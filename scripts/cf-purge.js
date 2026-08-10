#!/usr/bin/env node
'use strict';
// Purge specific URLs from the cheaper.app Cloudflare cache.
//
//   node scripts/cf-purge.js <url> [<url> ...]
//
// WHY THIS EXISTS. An upload is not a publish. dl.cheaper.app serves installers with
// `cache-control: max-age=14400`, and the site's HTML is cached at the edge too, so a
// successful `wrangler r2 object put` or `wrangler deploy` leaves the OLD bytes being
// served — for up to four hours on installers, and until revalidation on pages.
//
// Observed twice on 2026-08-09/10, both times after a green deploy:
//   * three R2 keys still returned the previous version's etag ~50 minutes after their
//     uploads succeeded (`cf-cache-status: HIT`);
//   * cheaper.app/post-download served the previous build after a redeploy, because a
//     verification request minutes earlier had warmed the cache with it.
// Both looked exactly like "the deploy did not land". Both had landed.
//
// The token is read from process.env and never placed in argv: a
// `curl -H "Authorization: Bearer $TOKEN"` exposes the secret to `ps` for the life of the
// request. URLs are safe in argv — they are not secrets.
//
// Exit codes: 0 purged · 1 the API refused · 2 no token (caller decides how loud that is).

const ZONE = process.env.CHEAPER_CF_ZONE_ID || '5e2bdeb36a5d5a0f1432d5e1dadd4819'; // cheaper.app
const token = process.env.CLOUDFLARE_API_TOKEN;
const files = process.argv.slice(2).filter(Boolean);

if (files.length === 0) { console.error('cf-purge: no URLs given'); process.exit(1); }
if (!token) {
  console.error('cf-purge: CLOUDFLARE_API_TOKEN is not set — cannot purge, so the CDN will keep serving the previous bytes until its TTL expires.');
  process.exit(2);
}

(async () => {
  // Cloudflare caps a single purge_cache call at 30 files.
  const BATCH = 30;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    let r, j;
    try {
      r = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: batch }),
      });
      j = await r.json();
    } catch (e) {
      // Never print the error object wholesale — a fetch error can carry request headers.
      console.error('cf-purge: request failed (' + (e && e.name ? e.name : 'error') + ')');
      process.exit(1);
    }
    if (!r.ok || !j || j.success !== true) {
      const why = (j && j.errors) ? JSON.stringify(j.errors).slice(0, 400) : `HTTP ${r.status}`;
      console.error('cf-purge: Cloudflare refused the purge — ' + why);
      process.exit(1);
    }
  }
  console.log(`cf-purge: purged ${files.length} URL(s) from the cheaper.app cache`);
})();
