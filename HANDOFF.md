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

## 2. Build the desktop installers (signed .dmg / .exe)

Can't be done in a cloud sandbox — needs each OS + signing certs. On the machines:

The five download targets (to match the site's menu):

```bash
cd desktop
npm install
# macOS — both arches (needs Apple Developer ID + notarization creds):
npm run dist:mac      # -> Cheaper-<v>-arm64.dmg  +  Cheaper-<v>-x64.dmg
# Windows — Microsoft Store package + direct installer (needs a signing cert):
npm run dist:win      # -> Cheaper-<v>.appx (Store)  +  Cheaper Setup <v>.exe
# Linux — Debian/Ubuntu and Fedora/RHEL:
npm run dist:linux    # -> cheaper_<v>_amd64.deb  +  Cheaper-<v>.x86_64.rpm  (+ .AppImage)
```

Notes per target:
- **macOS**: `build.mac.target` is `dmg` for `arch: [arm64, x64]` — produces the two
  Apple Silicon / Intel `.dmg` files. Add notarization under `build.mac.notarize`.
- **Windows Microsoft Store**: `build.win.target` includes `appx`; set the real
  `build.appx.identityName` / `publisher` from your Partner Center registration, then
  submit the `.appx` to the Store. `nsis` also builds a direct `.exe`.
- **Linux `.rpm`**: building rpm needs `rpm`/`rpmbuild` (or fpm) on the Linux build
  host — present on the `ubuntu-latest` GitHub Actions runner.

Add signing config under `build.mac.notarize` / `build.win.certificateFile` in
`desktop/package.json`. Drop a monochrome `desktop/assets/trayTemplate.png` before
building. GitHub Actions with `macos-latest`, `windows-latest`, `ubuntu-latest`
matrix jobs produces all five artifacts on tag push.

## 3. Host the landing page

`web/index.html` is a single self-contained file. Deploy to any static host
(Vercel / Netlify / GitHub Pages / Cloudflare Pages) at **cheaper.app**. Wire the
Download dropdown links and `npx cheaperapp` to your published artifacts and npm name.

## 4. The gateway in production

`gateway/` runs behind `uvicorn`/`gunicorn`. Put it on a trusted host over TLS,
set the `ROUTER_MODEL_*` ids to models your account has, and tune category patterns
in `gateway/app/router.py`. It forwards the caller's own API key upstream and stores
no secret of its own. Metrics persist to `~/.cheaper/metrics.db` (override with
`CHEAPER_DB`).

## Automated release (`.github/workflows/release.yml`)

Pushing a version tag runs the whole release: builds all five installers on
macOS/Windows/Linux runners, publishes `cheaperapp` to npm, and attaches the
installers to a GitHub Release.

```
# bump cli/package.json version to match, then:
git tag v0.1.0 && git push origin v0.1.0
```

Required repository secret:

- `NPM_TOKEN` — npm automation token with publish rights for `cheaperapp`.

Optional signing secrets (unsigned artifacts still build without them; needed for
distributable/Store-submittable installers):

- `CSC_LINK` + `CSC_KEY_PASSWORD` — macOS signing cert (.p12, base64) + password.
- `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` — Windows cert (.pfx, base64) + password.

The workflow guards that the tag (`v0.1.0`) matches `cli/package.json` version
(`0.1.0`) before publishing. The `rpm` target is built with the `rpm` toolchain
installed on the Linux runner. The built-in `GITHUB_TOKEN` handles the Release
upload — no secret to create for that.

## Suggested release checklist

1. `cd gateway && python -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python -m pytest` (19 tests green).
2. Verify `npx cheaperapp install --all` on a clean machine (installs skill + agents +
   hook + gateway). Then `npx cheaperapp install plugin` and confirm
   `claude plugin list` shows `adaptive-model-router@cheaper-local  Status: ✔ enabled`
   (and `claude plugin validate ~/.cheaper/marketplace` passes). Agent frontmatter must
   parse — `claude plugin validate <plugin>` catches a broken `model:` pin that would
   otherwise silently drop the tier override.
3. Bump `cli/package.json` version, commit, then tag `v<version>` and push — the
   workflow builds installers, publishes npm, and creates the release automatically.
4. Point the landing page's Download menu (`web/index.html` `data-dl` keys) at the
   release asset URLs.
5. Deploy `web/index.html` to cheaper.app.
6. Announce with the live monitor screenshot as proof it actually saves money.
