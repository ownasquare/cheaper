# Closing every release blocker, and the one that needs a credential

**Date:** 2026-08-10 · **Closes:** the *Open* list in
[2026-08-09-shipping-0.4.1-and-the-blockers-it-surfaced.md](2026-08-09-shipping-0.4.1-and-the-blockers-it-surfaced.md)

Six items were open. Five are closed in code and proved. The sixth needs a repository
secret and is now, at least, impossible to miss.

---

## 1. The visual gate could not run on Linux — and took the publish with it

Playwright suffixes every snapshot with `process.platform`. Every baseline this repository
has ever committed is `-darwin`. `toHaveScreenshot` answers a missing baseline by **writing
one and failing**, so on `ubuntu-latest` all 25 captures failed with *"A snapshot doesn't
exist … writing actual"*. Measured in the v0.4.1 run: Playwright **531 passed / 25 failed**,
and the 25 were exactly these captures — nothing else in the suite was red.

That is not a gate catching a regression. It is a gate that **cannot run**, and it took the
release path with it, because `publish-cli.yml` gates `npm publish` on `ci.yml`.

**Not fixed by skipping the tests.** Each capture is paired with *measured* assertions —
horizontal overflow, clipped text, collapsed/offscreen boxes, provenance and basis
statements. Those are platform-independent, they are the checks that say "it looked
**right**" rather than "it looked like this", and they were already running on Linux before
the screenshot killed the test. Skipping would have thrown away real coverage to fix a
file-naming problem.

So only the **pixel comparison** is conditional, and only on whether a baseline exists for
the platform in hand. macOS is unchanged. Linux enforces the structure and records the
capture as skipped *with its reason*. A `-linux` baseline, if ever committed, activates
automatically.

**The hole that opens, and the guard that closes it.** Delete a baseline and a capture would
quietly downgrade to a skip. `baseline inventory` asserts the reference set **from disk with
no browser**, so it runs and fails on *every* platform including the Linux CI where captures
are skipped. Three tests: every expected baseline present; no orphan baseline that nothing
captures; and a non-vacuity check, because the first two pass trivially on an empty
expectation set.

| control | result |
|---|---|
| delete `logs-tablet-darwin.png` | exit 1, names the file, 2 failed |
| add `retired-tab-tablet-darwin.png` | exit 1, names the orphan |
| move the whole snapshot dir aside, run captures | **exit 0, 8 structural tests still pass** — the Linux path, reproduced on macOS |

Each restored afterwards; the directory is back at 25 files.

## 2. A green publish job that published nothing

With the gate fixed, CI went fully green — and npm stayed on 0.4.0.

Every step in `publish-npm` is gated on `env.HAS_NPM`, false when `NPM_TOKEN` is absent.
GitHub records a skipped step as **neither success nor failure**, so the job reported
*"Publish cheaperapp to npm: success"* on a release tag, having published nothing. Run
`31359357043`: test suite success, publish success, `npm view cheaper version` → `0.4.0`.
The only way to catch it was to query the registry afterwards and disbelieve the tick.

The job now fails with an `::error::` naming the secret and the exact re-tag commands.
**Verified by re-tagging** (run `31359997231`): test suite success, publish job **failure**,
annotation *"NPM_TOKEN is not configured for this repository, so v0.4.1 was NOT published to
npm."*

**This is the one item left open.** Adding the secret needs repo-admin access and a
credential. Once it exists:

```
git push origin :refs/tags/v0.4.1 && git push origin v0.4.1
```

The desktop 0.4.1 release is unaffected — it bundles the CLI from the sibling checkout, not
from npm.

## 3. arm64 Linux auto-update pointed at x86_64 binaries

electron-updater fetches per-arch metadata: x86_64 asks for `latest-linux.yml`, arm64 for
`latest-linux-arm64.yml`. electron-builder puts the arch in the filename only when it is not
the host default — so a **native** arm64 runner writes the plain `latest-linux.yml`,
describing arm64 artifacts, colliding with the x86_64 lane's file of the same name.
`download-artifact` merges with `merge-multiple` and one silently overwrites the other.

Verified by downloading the published asset: v0.4.1's `latest-linux.yml` lists only
`x86_64.AppImage` / `amd64.deb` / `x86_64.rpm`, and there is **no `latest-linux-arm64.yml`
on the release at all**.

The arm lane now renames its metadata (conditionally, so a future electron-builder that
emits the right name makes it a no-op), and a release step **fails the job** unless all four
metadata files are present. electron-updater failures are silent by construction — a client
that cannot fetch its file reports "no update available", indistinguishable from being up to
date — so nothing would ever have reported this.

**Not backfilled:** v0.4.1 keeps its gap. arm64 Linux is new in this release, so nothing is
installed from it yet, and the next release publishes the file clients look for.

## 4. Uploads that were not publishes

Both surfaces sit behind the Cloudflare cache: installers carry `max-age=14400`, pages are
cached at the edge. It bit twice in one session, both after a green deploy:

- three R2 keys still returned the previous etag ~50 minutes after their uploads succeeded
  (`cf-cache-status: HIT`), the Windows installer among them;
- `cheaper.app/post-download` served the previous build after a redeploy — because a
  verification request minutes earlier had warmed the cache with it. **Checking whether the
  deploy landed is what stopped it from landing.**

`step_web` now purges every page in `web/`, derived from the directory rather than a
hand-kept list, in **both** URL forms — `/<name>.html` 307s to `/<name>`, and it is the
redirect target that gets cached and served. `step_desktop` purges exactly the keys it
uploaded, collected as they succeed so a refused artifact never gets a purge implying it
shipped. A failed purge is reported but never fatal: the bytes *are* uploaded, and calling
that a failed release would be its own false claim.

`scripts/cf-purge.js` reads the token from `process.env` and never puts it in argv.

## 5. Transient upload failures

`cheaper-macos-x64.dmg` (~104 MB) failed three separate runs with wrangler's bare
`TypeError: fetch failed` — no HTTP status, no mention of credentials — then succeeded with
identical bytes, while the smaller arm64 dmg beside it uploaded first time every run. One
attempt turned a flaky network into *"dl.cheaper.app was NOT fully updated"*, which is
alarming and, on re-run, untrue.

`put_r2` retries three times with a widening pause and prints the attempt count on success,
so an upload that needed three goes stays visible. Deliberately short: a genuine credential
or bucket error fails identically every time, and watching it fail slowly teaches nothing.

## 6. AppImage published since 0.1.0, linked from nowhere

Both AppImages were on R2 and attached to every Release, and no page linked them — silently
excluding anyone on a distro that is neither Debian- nor RPM-based, for whom it is the only
option.

Now linked on both surfaces, x86_64 and arm64. **The part that needed care:**
`stepsFor()` in `post-download.html` and `steps()` in `thanks.html` both *end* with the
`.deb` branch as an unconditional fallback, so a new entry with an unrecognised `plat` does
not render a blank panel — it renders `sudo apt install ./cheaper-linux-arm64.AppImage`,
confidently, to someone who may not have apt. AppImage therefore got a real renderer in both
files rather than a borrowed `plat`.

Nine downloads now offered: mac ×2, Windows, and Linux deb/rpm/AppImage in both
architectures. Playwright 154/154.

## 7. Two `v0.4.0` tags that released nothing — deleted

Neither had a Release or any artifact. `ownasquare/cheaper`'s named an Aug-9 commit, while
npm's 0.4.0 came from the Aug-8 tree — and `cli/package.json` first carried `"0.4.0"` *in a
commit* only at `0a1d6c1` (Aug 9 20:57), **after** the npm publish. So **no commit
corresponds to npm 0.4.0**: it was published from an uncommitted working tree, and the tag
could not have been made true by moving it. `cheaper-desktop`'s v0.4.0 tag produced only a
failed run.

Remaining tags: `cheaper` — `v0.1.0`, `v0.4.1`; `cheaper-desktop` — `v0.1.0`, `v0.1.1`,
`v0.1.2`, `v0.4.1`.

## A note on moving the `v0.4.1` tag

It was moved twice on `ownasquare/cheaper`, and the desktop release pins its CLI checkout to
that tag. Verified rather than asserted that this changed nothing shipped:

```
git diff --stat 2e02ee0 c39ae38 -- cli/bin cli/src cli/assets/plugin cli/assets/gateway cli/package.json
(empty)
```

The delta is workflow, docs, deploy script and tests — none of which appear in
`cli/package.json`'s `files` list, so the published tarball content is identical.

## Verification summary

| suite | result |
|---|---|
| `cheaper-app` CLI (`npm test`) | **454 pass / 0 fail**, four parity gates green |
| `cheaper-app` full CI on Linux | **green**, including Playwright |
| deploy pre-flight harness | **18 passed** |
| `cheaper-web` Playwright | **154 passed** |
| `cheaper-desktop` (`npm test`) | 34 deep-link checks + workflow lint, green |
