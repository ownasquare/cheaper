#!/usr/bin/env node
'use strict';
// POST-DEPLOY VERIFICATION — is what is LIVE what we just shipped?
//
//   node scripts/verify-live.js <workspace-dir>
//
// WHY THIS EXISTS. Every other step in cheaper-deploy.sh reports on the ACTION it took:
// the push succeeded, wrangler exited 0, `r2 object put` said "Upload complete". None of
// them look at the result. That gap has produced a wrong answer at every layer of this
// stack in a single week:
//
//   * three R2 keys served the PREVIOUS version for ~50 minutes after their uploads
//     succeeded, because the CDN had them cached (`cf-cache-status: HIT`);
//   * cheaper.app served the previous build after a green redeploy, for the same reason;
//   * the Linux installer keys served 0.1.0 for DAYS while the site advertised 0.4.0,
//     because nothing ever compared the two;
//   * a publish job reported success having published nothing.
//
// In every case the deploy output was green and the live bytes were wrong. So this asks
// the only question that actually matters, of the public URLs, from outside.
//
// WHAT IT PROVES, and how strongly — the distinction is stated per check rather than
// flattened into a tick:
//
//   website     BYTE-IDENTICAL. The worker serves web/ verbatim, so the sha256 of what
//               the CDN returns must equal the sha256 of the file on disk. Nothing
//               weaker would catch a stale edge cache, which is the failure actually
//               observed.
//   mac dmg     BYTE-IDENTICAL. R2's etag is the md5 for a single-part upload, so it is
//               compared against the local artifact's md5 — no download needed.
//   ci artifact SIZE-MATCHED against the release's own electron-updater manifest
//               (latest*.yml), fetched unauthenticated from the GitHub Release. Those
//               are built on runners, so there is no local copy to hash; the manifest is
//               the authoritative record of what that version's bytes are. A key still
//               serving the previous release has a different length, which is exactly
//               the defect this catches.
//   npm         the registry's `latest` dist-tag versus cli/package.json.
//
// "COULD NOT CHECK" IS NEVER "FINE". A fetch failure, an unreadable file or a missing
// manifest is reported in its own category and never counted as verified. The only case
// that is a warning rather than an error is a missing manifest, where the object itself
// still answers 200 with a non-zero length — that is a genuinely weaker but non-empty
// statement, and it is labelled as one. v0.4.1 has no latest-linux-arm64.yml (a known,
// documented gap), and this must not fail every verification run until the next release.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WS = process.argv[2];
if (!WS) { console.error('usage: verify-live.js <workspace-dir>'); process.exit(2); }

const WEB = path.join(WS, 'cheaper-web', 'web');
const CLI_PKG = path.join(WS, 'cheaper-app', 'cli', 'package.json');
const DESKTOP_PKG = path.join(WS, 'cheaper-desktop', 'package.json');
const DIST = path.join(WS, 'cheaper-desktop', 'dist');

const SITE = 'https://cheaper.app';
const DL = 'https://dl.cheaper.app';
const RELEASES = 'https://github.com/ownasquare/cheaper-desktop/releases/download';
const REGISTRY = 'https://registry.npmjs.org/cheaper/latest';
const TIMEOUT_MS = 45000;

const C = { g: '[32m', r: '[31m', y: '[33m', d: '[2m', x: '[0m' };
let verified = 0, mismatched = 0, unchecked = 0, weak = 0;

const okLine   = (m) => { verified++;   console.log(`      ${C.g}✓${C.x} ${m}`); };
const badLine  = (m) => { mismatched++; console.log(`      ${C.r}✗ ${m}${C.x}`); };
const weakLine = (m) => { weak++;       console.log(`      ${C.y}~ ${m}${C.x}`); };
const noLine   = (m) => { unchecked++;  console.log(`      ${C.y}? ${m}${C.x}`); };
const group    = (m) => console.log(`  ${m}`);

function readVersion(p) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    return (typeof v === 'string' && v.length) ? v : null;
  } catch { return null; }
}

async function get(url, { method = 'GET' } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { method, redirect: 'follow', signal: ac.signal });
    return { ok: r.ok, status: r.status, headers: r.headers, res: r };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.name === 'AbortError') ? 'timed out' : 'request failed' };
  } finally { clearTimeout(t); }
}

// --- 1. website: byte-identical -------------------------------------------------------
async function verifyWebsite() {
  group('website — the CDN must return exactly the bytes in cheaper-web/web/');
  if (!fs.existsSync(WEB)) { noLine(`${WEB} not readable — cannot verify the website`); return; }
  const pages = fs.readdirSync(WEB).filter((f) => f.endsWith('.html')).sort();
  if (pages.length === 0) { noLine('no .html files in web/ — nothing to verify, which is itself wrong'); return; }

  let same = 0; const bad = [];
  for (const page of pages) {
    const name = path.basename(page, '.html');
    const url = name === 'index' ? `${SITE}/` : `${SITE}/${name}`;
    const local = crypto.createHash('sha256').update(fs.readFileSync(path.join(WEB, page))).digest('hex');
    const r = await get(url);
    if (!r.ok) { bad.push(`${name}: HTTP ${r.status || r.error}`); continue; }
    const body = Buffer.from(await r.res.arrayBuffer());
    const live = crypto.createHash('sha256').update(body).digest('hex');
    if (live === local) { same++; }
    else {
      bad.push(`${name}: live sha256 ${live.slice(0, 12)}… != local ${local.slice(0, 12)}… ` +
               `(${body.length} vs ${fs.statSync(path.join(WEB, page)).size} bytes)`);
    }
  }
  if (bad.length === 0) okLine(`${same}/${pages.length} pages byte-identical to web/`);
  else {
    badLine(`${bad.length} of ${pages.length} page(s) are NOT what is on disk — the edge is serving something else:`);
    for (const b of bad) console.log(`          ${b}`);
    console.log(`          the deploy may have succeeded and the CDN not caught up; re-run and let the purge run, or purge these paths.`);
  }
}

// --- 2. installers ---------------------------------------------------------------------
// Minimal reader for electron-builder's latest*.yml: pairs each `- url: X` with the
// `size: N` that follows it. Deliberately not a YAML parser — the shape is fixed and
// generated, and a dependency here would have to be installed before a release could be
// checked.
function parseManifest(text) {
  const out = new Map();
  let url = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    let m = /^-\s+url:\s*(.+)$/.exec(line);
    if (m) { url = m[1].trim(); continue; }
    m = /^size:\s*(\d+)$/.exec(line);
    if (m && url) { out.set(url, Number(m[1])); url = null; }
  }
  return out;
}

async function fetchManifest(version, name) {
  const r = await get(`${RELEASES}/v${version}/${name}`);
  if (!r.ok) return null;
  try { return parseManifest(await r.res.text()); } catch { return null; }
}

async function headKey(key) {
  // HEAD, so verification never pulls hundreds of megabytes through the CDN.
  const r = await get(`${DL}/${key}`, { method: 'HEAD' });
  if (!r.ok) return { ok: false, why: `HTTP ${r.status || r.error}` };
  return {
    ok: true,
    length: Number(r.headers.get('content-length') || 0),
    etag: (r.headers.get('etag') || '').replace(/"/g, ''),
  };
}

async function verifyInstallers() {
  const dv = readVersion(DESKTOP_PKG);
  group(`installers — dl.cheaper.app must serve v${dv || '?'}`);
  if (!dv) { noLine('cannot read cheaper-desktop/package.json version — nothing to check against'); return; }

  // Locally built and uploaded from this machine: byte-identity via etag == md5.
  for (const [key, file] of [
    ['cheaper-macos-arm64.dmg', `Cheaper-${dv}-arm64.dmg`],
    ['cheaper-macos-x64.dmg', `Cheaper-${dv}-x64.dmg`],
  ]) {
    const local = path.join(DIST, file);
    const live = await headKey(key);
    if (!live.ok) { badLine(`${key}: ${live.why}`); continue; }
    if (!fs.existsSync(local)) {
      weakLine(`${key}: live (${live.length} bytes) but ${file} is not in dist/, so byte-identity cannot be proved here`);
      continue;
    }
    const md5 = crypto.createHash('md5').update(fs.readFileSync(local)).digest('hex');
    if (md5 === live.etag) okLine(`${key} is byte-identical to ${file}`);
    else badLine(`${key}: live etag ${live.etag.slice(0, 12)}… != local md5 ${md5.slice(0, 12)}… — the CDN or the bucket is serving a DIFFERENT build`);
  }

  // Built by CI: no local copy, so the release's own manifest is the authority.
  const manifests = [
    ['latest.yml', [['cheaper-windows-x64.exe', `Cheaper-Setup-${dv}.exe`]]],
    ['latest-linux.yml', [
      ['cheaper-linux-x86_64.AppImage', `Cheaper-${dv}-x86_64.AppImage`],
      ['cheaper-linux-amd64.deb', `Cheaper-${dv}-amd64.deb`],
      ['cheaper-linux-x86_64.rpm', `Cheaper-${dv}-x86_64.rpm`],
    ]],
    ['latest-linux-arm64.yml', [
      ['cheaper-linux-arm64.AppImage', `Cheaper-${dv}-arm64.AppImage`],
      ['cheaper-linux-arm64.deb', `Cheaper-${dv}-arm64.deb`],
      ['cheaper-linux-arm64.rpm', `Cheaper-${dv}-aarch64.rpm`],
    ]],
  ];

  for (const [manifestName, pairs] of manifests) {
    const sizes = await fetchManifest(dv, manifestName);
    for (const [key, artifact] of pairs) {
      const live = await headKey(key);
      if (!live.ok) { badLine(`${key}: ${live.why}`); continue; }
      const expected = sizes ? sizes.get(artifact) : undefined;
      if (expected === undefined) {
        // No manifest, or it does not mention this artifact. The object exists and is
        // non-empty, which is a real but weaker statement — say which one it is.
        if (live.length > 0) {
          weakLine(`${key}: 200 and ${live.length} bytes, but v${dv}'s ${manifestName} ` +
                   `${sizes ? `does not list ${artifact}` : 'is not on the release'} — cannot confirm the VERSION`);
        } else {
          badLine(`${key}: 200 but zero-length`);
        }
        continue;
      }
      if (live.length === expected) okLine(`${key} matches v${dv} (${expected} bytes, per ${manifestName})`);
      else badLine(`${key}: ${live.length} bytes but v${dv} is ${expected} — this key is serving a DIFFERENT VERSION`);
    }
  }
}

// --- 3. npm ---------------------------------------------------------------------------
async function verifyNpm() {
  const cv = readVersion(CLI_PKG);
  group('npm — the registry must carry the version in cli/package.json');
  if (!cv) { noLine('cannot read cli/package.json version'); return; }
  const r = await get(REGISTRY);
  if (!r.ok) { noLine(`registry query failed (${r.status || r.error}) — cannot confirm what is published`); return; }
  let live;
  try { live = (await r.res.json()).version; } catch { noLine('registry returned unreadable JSON'); return; }
  if (live === cv) okLine(`cheaper@${cv} is the published latest`);
  else badLine(`cli/package.json is ${cv} but npm's latest is ${live} — this version was NOT published`);
}

(async () => {
  await verifyWebsite();
  await verifyInstallers();
  await verifyNpm();

  console.log('');
  const parts = [`${verified} verified`];
  if (mismatched) parts.push(`${mismatched} MISMATCHED`);
  if (weak) parts.push(`${weak} weakly confirmed`);
  if (unchecked) parts.push(`${unchecked} not checkable`);
  console.log(`  ${parts.join(', ')}`);
  if (mismatched > 0) {
    console.log(`  ${C.r}what is live is NOT what this workspace says should be live.${C.x}`);
    process.exit(1);
  }
  if (unchecked > 0) {
    // Not a mismatch, but the run cannot claim the release is verified either.
    console.log(`  ${C.y}some surfaces could not be checked — this run has NOT established that they are correct.${C.x}`);
    process.exit(3);
  }
  process.exit(0);
})();
