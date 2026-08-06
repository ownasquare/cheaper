# Cheaper — release handoff

What's production-ready, what needs a build machine, and how to cut a downloadable
release like codeburn.app.

## 1. Publish the CLI (this is the `npx cheaperapp` path)

The CLI bundles the gateway and plugin assets, so `npx cheaperapp install` is
self-contained.

```bash
cd cli
npm publish --access public      # name: "cheaperapp" (claim it, or scope as @ownasquare/cheaperapp)
```

After publish, `npx cheaperapp install --all` works anywhere Node 16+ is present.
If the npm name "cheaper" is taken, set a scoped name in `cli/package.json`
(`@ownasquare/cheaperapp`) and the landing-page command becomes `npx @ownasquare/cheaperapp`.

## 2. Build the desktop installers

The desktop app now lives in its own repo — **cheaper-desktop**
(https://github.com/ownasquare/cheaper-desktop). It consumes the published
`cheaperapp` package and builds the native installers (`.dmg` / `.exe` / `.deb` /
`.rpm` / `.AppImage`); signing, notarization, and the tag-triggered GitHub Release +
Cloudflare R2 upload all live there (`SIGNING.md` + `.github/workflows/release.yml`).
This repo only publishes the CLI to npm (`.github/workflows/publish-cli.yml`).

## 3. Host the landing page

The marketing site is a **separate project** at `../cheaper-web/` (not in this
repo). Its `web/index.html` is a self-contained file; deploy the site with
`npm run deploy` (Cloudflare Workers static assets, already wired to **cheaper.app**)
or to any static host. Wire the Download dropdown links and `npx cheaperapp` to your
published artifacts and npm name.

## 4. The gateway in production

`gateway/` runs behind `uvicorn`/`gunicorn`. Put it on a trusted host over TLS,
set the `ROUTER_MODEL_*` ids to models your account has, and tune category patterns
in `gateway/app/router.py`. It forwards the caller's own API key upstream and stores
no secret of its own. Metrics persist to `~/.cheaper/metrics.db` (override with
`CHEAPER_DB`).

## Automated release

Two repos, two tag-triggered workflows:

- **`cheaperapp`** (`.github/workflows/publish-cli.yml`) — on a `v*` tag, verifies the
  tag matches `cli/package.json` and publishes `cheaperapp` to npm.
- **`cheaper-desktop`** (`.github/workflows/release.yml`) — on a `v*` tag, builds the
  five installers on macOS/Windows/Linux runners, publishes a GitHub Release, and
  uploads them to Cloudflare R2 (dl.cheaper.app).

```
# bump cli/package.json to match, then tag each repo you're releasing:
git tag v0.1.0 && git push origin v0.1.0
```

Required secret (this repo): `NPM_TOKEN` — npm automation token with publish rights
for `cheaperapp`. Signing / notarization secrets live in `cheaper-desktop`.

## Suggested release checklist

1. `cd gateway && python -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python -m pytest` (19 tests green).
2. Verify `npx cheaperapp install --all` on a clean machine (installs skill + agents +
   hook + gateway). Then `npx cheaperapp install plugin` and confirm
   `claude plugin list` shows `adaptive-model-router@cheaper-local  Status: ✔ enabled`
   (and `claude plugin validate ~/.cheaper/marketplace` passes). Agent frontmatter must
   parse — `claude plugin validate <plugin>` catches a broken `model:` pin that would
   otherwise silently drop the tier override.
3. Bump `cli/package.json`, commit, then tag `v<version>` and push — publishes the
   CLI to npm. Tag the `cheaper-desktop` repo to build installers + GitHub Release.
4. Point the landing page's Download menu (`../cheaper-web/web/index.html`
   `data-dl` keys) at the release asset URLs.
5. Deploy the site from `../cheaper-web/` (`npm run deploy`) to cheaper.app.
6. Announce with the live monitor screenshot as proof it actually saves money.
