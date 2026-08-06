# Cheaper — external resources to set up

The site links to these. Create each account/handle so the links resolve, then
fill in any placeholder slugs.

| Resource | URL | Notes |
|----------|-----|-------|
| GitHub repo | https://github.com/ownasquare/cheaper | Push this repo; add `LICENSE` (MIT, included). |
| License link | https://github.com/ownasquare/cheaper/blob/main/LICENSE | Resolves once the repo is pushed to `main`. |
| npm package | https://www.npmjs.com/package/cheaperapp | `cd cli && npm publish` (package name is `cheaperapp`). |
| GitHub Sponsors | https://github.com/sponsors/cheaperapp | Enable Sponsors on the `cheaperapp` GitHub account/org. |
| Discord | https://discord.gg/&lt;slug&gt; | Create the server, then replace the `discord` URL in `web/gen`/pages with the real invite slug. |
| YouTube | https://www.youtube.com/@cheaperapp | Claim the `@cheaperapp` handle. |
| LinkedIn | https://www.linkedin.com/showcase/cheaperapp | Create a showcase page under your company page. |
| X / Twitter | https://x.com/_cheaperapp | Claim `@_cheaperapp`. |

## Naming note
The product/site is **Cheaper** (domain `cheaper.app`), but the npm package and
social handles use **cheaperapp** / **_cheaperapp** (since `cheaper` is likely taken).
The site nav/footer already point at these. If you later secure the bare `cheaper`
handles, update the URLs in `web/*.html` (they're plain `<a href>`s) and the npm
name in `cli/package.json`.

## Internal pages (already built)
`docs.html`, `changelog.html`, `codex-savings.html`, `cursor-savings.html`,
`claude-code-savings-tracker.html`, `ai-tokens-savings-tracker.html`,
`compare/ccusage.html`, `compare/rtk.html`, `compare/graphify.html`, plus `index.html`
and shared `style.css`.

Deploy the `web/` folder to any static host at `cheaper.app`. On Vercel/Netlify the
clean URLs (`/docs`, `/compare/ccusage`) work if you enable "clean URLs" / drop the
`.html`; otherwise link the `.html` files directly (already wired that way).
