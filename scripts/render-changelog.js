#!/usr/bin/env node
/* Render cheaper-app/CHANGELOG.md into cheaper-web/web/changelog.html.
 *
 * WHY THIS EXISTS: the page's intro used to carry a hand-typed sentence,
 * "The currently published CLI is cheaper@0.3.0". npm was serving 0.4.1 by then. Nobody
 * edits an intro paragraph when they cut a release, so that sentence was guaranteed to
 * rot, and it rotted into a false factual claim about what a visitor would install. The
 * version on the page is now derived from the newest CHANGELOG entry and cross-checked
 * against cli/package.json, so the site cannot name a version it is not shipping.
 *
 *   node scripts/render-changelog.js            # write the page
 *   node scripts/render-changelog.js --check    # exit non-zero if the page is stale
 *
 * Exit codes are distinct on purpose — "the page is out of date" and "I could not read
 * my inputs" need different responses from a human and from CI, and collapsing them
 * would let an unreadable CHANGELOG.md report as a stale page (or worse, as fine):
 *   0  page is up to date (or was just written)
 *   1  --check only: the page is STALE, regenerate it
 *   2  an input could not be read or parsed, or a consistency gate failed
 *
 * Only the region between the two GENERATED markers in changelog.html is touched. Every
 * byte outside them — head, nav, the page's own <style> block, the closing footnote,
 * the footer with its social SVGs, theme.js — is preserved exactly, because that chrome
 * is hand-designed and shared with 17 other pages.
 *
 * Testing hooks: --changelog <path> / --page <path> point the generator at copies, so
 * the escaping and staleness behaviour can be proven by mutation without ever editing
 * the real tracked files (which a concurrent auto-commit would happily ship).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const DEFAULT_CHANGELOG = path.join(REPO, "CHANGELOG.md");
const DEFAULT_PAGE = path.join(REPO, "..", "cheaper-web", "web", "changelog.html");
const PACKAGE_JSON = path.join(REPO, "cli", "package.json");

const BEGIN = "<!-- BEGIN GENERATED RELEASES: cheaper-app/scripts/render-changelog.js -->";
const END = "<!-- END GENERATED RELEASES -->";

const NPM_URL = "https://www.npmjs.com/package/cheaper";

/* Thrown for anything that must exit 2: an unreadable input, a malformed CHANGELOG, a
   version disagreement. Distinguished from a stale page by type, not by message text. */
class InputError extends Error {}

/* ------------------------------------------------------------------ text helpers */

function esc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* Markdown inline -> the page's existing inline vocabulary.
 *
 * Escaping happens BEFORE any markup is inserted, so a release note that says
 * "a & b" or mentions <script> becomes text on the page instead of breaking it or
 * executing.
 *
 * Code spans are lifted out to placeholders rather than rendered in place. Rendering
 * them in place split every bullet at the backticks, and CHANGELOG.md's most common
 * bullet opens with bold text wrapping a command — "**`cheaper status` no longer shows
 * a stopped gateway in green.**". With the string already cut at the backticks, the
 * opening ** and the closing ** were in different pieces, no bold matched, and eight
 * bullets published raw ** asterisks on the live page. The placeholder carries a NUL,
 * which cannot occur in the escaped text, so nothing else can collide with it. */
function inline(md) {
  const code = [];
  const withHoles = md.replace(/`([^`]*)`/g, (_m, body) => {
    code.push(body);
    return `\u0000${code.length - 1}\u0000`;
  });

  let s = esc(withHoles);
  /* href comes out of already-escaped text, so it is attribute-safe as written. */
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text, href) => `<a class="link" href="${href}">${text}</a>`
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<span class="kbd">${esc(code[Number(i)])}</span>`);
}

/* Soft-wrap the generated HTML so the page source stays readable in a diff.
 *
 * Only a space that is already outside a tag becomes a newline, and a newline renders
 * exactly as that space did — so wrapping can never change what the browser shows, and
 * can never split `<span class="kbd">` down the middle. The `<`/`>` tracking is only
 * safe because inline() escaped the text first: no raw angle bracket survives except
 * the ones this file emitted as markup. */
function wrapHtml(s, width) {
  let out = "";
  let col = 0;
  let inTag = false;
  for (const ch of s) {
    if (ch === "<") inTag = true;
    if (ch === ">") inTag = false;
    if (ch === " " && !inTag && col >= width) {
      out += "\n";
      col = 0;
      continue;
    }
    out += ch;
    col += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ CHANGELOG parse */

/* The format contract, enforced rather than assumed:
     ## <semver> — <YYYY-MM-DD>      (em dash, one space either side)
   A heading that does not match is a hard error. Skipping it would silently drop a
   whole release from the public page, which looks identical to that release never
   having existed. */
const HEADING = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/;

function cmpSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parseChangelog(text, source) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  if (lines[i] === undefined || !/^#\s+/.test(lines[i])) {
    throw new InputError(`${source}: expected a "# Changelog" title on the first line`);
  }
  i += 1;

  const introLines = [];
  for (; i < lines.length && !lines[i].startsWith("## "); i += 1) {
    if (lines[i].trim() !== "") introLines.push(lines[i].trim());
  }
  const intro = introLines.join(" ").trim();
  if (!intro) throw new InputError(`${source}: no intro paragraph between the title and the first release`);

  const entries = [];
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("## ")) continue;
    const m = HEADING.exec(line);
    if (!m) {
      throw new InputError(
        `${source}:${i + 1}: release heading does not match "## <semver> — <YYYY-MM-DD>": ${line}`
      );
    }
    const entry = { version: m[1], date: m[2], summaryLines: [], bullets: [] };
    for (i += 1; i < lines.length && !lines[i].startsWith("## "); i += 1) {
      const body = lines[i];
      if (body.trim() === "") continue;
      if (/^-\s+/.test(body)) {
        entry.bullets.push(body.replace(/^-\s+/, "").trim());
      } else if (entry.bullets.length) {
        /* Continuation of the bullet above: markdown folds it into the same item. */
        entry.bullets[entry.bullets.length - 1] += ` ${body.trim()}`;
      } else {
        entry.summaryLines.push(body.trim());
      }
    }
    i -= 1;
    entry.summary = entry.summaryLines.join(" ").trim();
    if (!entry.summary) {
      throw new InputError(
        `${source}: release ${entry.version} has no one-line summary under its heading`
      );
    }
    entries.push(entry);
  }

  if (!entries.length) throw new InputError(`${source}: no release entries found`);

  /* Versions must descend: the newest entry is the one that gets the "current" pill and
     the published-version sentence, and both would be wrong if the file were reordered. */
  for (let k = 1; k < entries.length; k += 1) {
    if (cmpSemver(entries[k - 1].version, entries[k].version) <= 0) {
      throw new InputError(
        `${source}: versions must descend, but ${entries[k - 1].version} is followed by ${entries[k].version}`
      );
    }
  }

  return { intro, entries };
}

/* ------------------------------------------------------------------ intro rewriting */

/* The intro's own "current release is cheaper@X" claim is removed and re-emitted from
   the parsed newest version, so the sentence on the page has exactly one source. A
   disagreement between the intro prose and the headings is a defect in CHANGELOG.md
   itself and stops the run — rendering either number would publish a claim the file
   does not agree with. */
function buildLead(intro, newest, source) {
  const sentences = intro.split(/(?<=\.)\s+/);
  const kept = [];
  for (const sentence of sentences) {
    const claims = [...sentence.matchAll(/cheaper@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    if (!claims.length) {
      kept.push(sentence);
      continue;
    }
    for (const claimed of claims) {
      if (claimed !== newest) {
        throw new InputError(
          `${source}: the intro says cheaper@${claimed} but the newest release entry is ${newest}`
        );
      }
    }
  }
  const prose = inline(kept.join(" ").trim());
  const version = `<span class="kbd">cheaper@${esc(newest)}</span>`;
  return `${prose} The currently published CLI is ${version} (<a class="link" href="${NPM_URL}">npm</a>).`;
}

/* ------------------------------------------------------------------ rendering */

function renderReleases({ intro, entries }, source) {
  const newest = entries[0].version;
  const out = [];
  out.push(`<p class="lead">${wrapHtml(buildLead(intro, newest, source), 92)}</p>`);
  for (const entry of entries) {
    const pill = entry === entries[0] ? ' <span class="verpill">current</span>' : "";
    out.push("");
    out.push(`<h2>${esc(entry.version)}${pill}</h2>`);
    out.push(`<p class="verdate">${esc(entry.date)}</p>`);
    out.push(`<p class="lead">${wrapHtml(inline(entry.summary), 92)}</p>`);
    if (entry.bullets.length) {
      out.push("<ul>");
      for (const bullet of entry.bullets) {
        out.push(`  <li>${wrapHtml(inline(bullet), 92)}</li>`);
      }
      out.push("</ul>");
    }
  }
  return out.join("\n");
}

function spliceIntoPage(pageText, releasesHtml, pagePath) {
  const start = pageText.indexOf(BEGIN);
  const end = pageText.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new InputError(
      `${pagePath}: the generated region markers are missing. Expected\n  ${BEGIN}\n  ${END}\n` +
        "around the release entries, so the surrounding chrome can be preserved byte for byte."
    );
  }
  const head = pageText.slice(0, start + BEGIN.length);
  const tail = pageText.slice(end);
  return `${head}\n${releasesHtml}\n\n${tail}`;
}

/* ------------------------------------------------------------------ gates */

function readFileOrFail(file, label) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new InputError(`could not read ${label} at ${file}: ${err.message}`);
  }
}

/* The page says "the currently published CLI is X". cli/package.json is the version that
   actually gets published, so if the two disagree the sentence is unverifiable and we
   refuse to render it — the exact class of false claim this generator exists to kill. */
function assertPackageVersion(newest) {
  const raw = readFileOrFail(PACKAGE_JSON, "cli/package.json");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    throw new InputError(`could not parse cli/package.json at ${PACKAGE_JSON}: ${err.message}`);
  }
  if (pkg.version !== newest) {
    throw new InputError(
      `newest CHANGELOG entry is ${newest} but cli/package.json is ${pkg.version}; ` +
        "the page would name a version the CLI does not ship"
    );
  }
}

/* ------------------------------------------------------------------ cli */

function parseArgs(argv) {
  const opts = { check: false, changelog: DEFAULT_CHANGELOG, page: DEFAULT_PAGE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") opts.check = true;
    else if (arg === "--changelog") opts.changelog = path.resolve(argv[++i] || "");
    else if (arg === "--page") opts.page = path.resolve(argv[++i] || "");
    else {
      process.stderr.write(`render-changelog: unknown argument ${arg}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function firstDifference(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i += 1) {
    if (al[i] !== bl[i]) {
      return `line ${i + 1}\n  page:     ${al[i] === undefined ? "<missing>" : al[i]}\n  expected: ${
        bl[i] === undefined ? "<missing>" : bl[i]
      }`;
    }
  }
  return "the files differ only in trailing bytes";
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const mdText = readFileOrFail(opts.changelog, "CHANGELOG.md");
  const pageText = readFileOrFail(opts.page, "changelog.html");

  const parsed = parseChangelog(mdText, opts.changelog);
  assertPackageVersion(parsed.entries[0].version);

  const expected = spliceIntoPage(pageText, renderReleases(parsed, opts.changelog), opts.page);

  if (opts.check) {
    if (expected !== pageText) {
      process.stderr.write(
        `render-changelog: STALE PAGE — ${opts.page} does not match ${opts.changelog}.\n` +
          `First difference at ${firstDifference(pageText, expected)}\n` +
          "Run: node cheaper-app/scripts/render-changelog.js\n"
      );
      process.exit(1);
    }
    process.stdout.write(
      `render-changelog: up to date — ${opts.page} matches ${opts.changelog} (cheaper@${parsed.entries[0].version}).\n`
    );
    return;
  }

  if (expected === pageText) {
    process.stdout.write(
      `render-changelog: unchanged — ${opts.page} already matches (cheaper@${parsed.entries[0].version}).\n`
    );
    return;
  }
  fs.writeFileSync(opts.page, expected);
  process.stdout.write(
    `render-changelog: wrote ${opts.page} — ${parsed.entries.length} releases, current cheaper@${parsed.entries[0].version}.\n`
  );
}

try {
  main();
} catch (err) {
  if (err instanceof InputError) {
    process.stderr.write(`render-changelog: ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}
