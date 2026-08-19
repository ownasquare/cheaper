# 2026-08-19 — `npx cheaper install --all` shipped without the `cheaper` command

## What happened

A third machine ran `npx cheaper install --all` and got an install that ended in green
ticks followed by three failures:

```
✗ nothing to autostart: /Users/<user>/.cheaper/cli/bin/cheaper.js does not exist.
  Autostart runs the stable copy of this CLI, not whatever is on your PATH today.
  Install it first: cheaper install cli
zsh: command not found: cheaper
No ROUTING was configured for them
```

The third line is by design (a tagline reports savings, it does not route). The first two
are one defect.

## Root cause — a fix that was committed but never released

`cli` was added to `DEFAULT_KEYS` in commit `a0c7581` ("Install the command the rest of the
install depends on"). That commit was never published. npm's `latest` was still `0.4.1`
from 2026-08-10, and `npx cheaper` resolves `latest`, so every fresh machine kept getting
the pre-fix installer.

Verified directly against the published tarball rather than inferred:

| | published `cheaper@0.4.1` | working tree |
| --- | --- | --- |
| `DEFAULT_KEYS` | `['skill','agents','hook','gateway']` | `[...,'cli']` |
| `~/.cheaper/cli/bin/cheaper.js` after `install --all` | absent | present |
| `~/.local/bin/cheaper` after `install --all` | absent | present, runs (`cheaper 0.4.2`) |

Reproduced in a sandbox `HOME` from `npm pack cheaper@0.4.1`; the working tree was run the
same way and produced both files.

The `cli` component itself shipped fine in 0.4.1 — `installCliLauncher` and `clilink.js`
are both in the tarball. Only the *default set* was stale, so naming the component
explicitly (`npx cheaper install cli`) always worked and remains the unblock for any
machine already in this state.

### Why it was worse than a missing command

`tagline_install.js` writes the literal string `cheaper peek --tagline …` into the global
instructions file of every detected harness. A run that printed "✓ tagline wired" for
Codex and Copilot had therefore wired instructions that could never execute, and nothing
would ever have reported it. Same defect class the installer's own comments warn about:
a green tick for something that is not in place.

## Second defect, found while confirming the first

The one-time autostart offer was gated on `installed.has('gateway')` alone. A login entry
is pointed at `~/.cheaper/cli/bin/cheaper.js`, and `autostart.js::enable` refuses when that
file is absent — so on exactly the machines above, answering `y` printed
`✗ nothing to autostart`. The answer is persisted to `~/.cheaper/autostart.json`, so that
burned the single question the machine ever gets on an outcome already known to fail.

The gate now also requires the staged CLI. It tests the **file**, not this run's rows:
the staged copy is durable, so `cheaper install gateway` on a machine that staged the CLI
in an earlier run is still legitimately offered. Gating on `installed.has('cli')` would
have silently withheld the offer there — the mirror of the bug being fixed.

## Changes

| File | Change |
| --- | --- |
| `cli/package.json` | `0.4.1` → `0.4.2` (published and local were the same version, so a release needed a bump) |
| `cli/src/install.js` | autostart offer additionally requires `~/.cheaper/cli/bin/cheaper.js` on disk |
| `cli/test/install.test.js` | existing offer test now installs `gateway cli`; new test pins the no-staged-CLI case at 0 offers |
| `CHANGELOG.md` | 0.4.2 entry |

Commit `0ad59ec` on `main`, local to the repo at
`/Volumes/fortunevieyra/Documents/Github/ownasquare.com/cheaper-app`.

## Validation

- `npm test` in `cli/`: **663 pass, 0 fail, exit 0** (includes the price-sync, period-parity
  and policy-parity gates — 144180 routing decisions compared across both runtimes).
- Sandbox-`HOME` install from the working tree stages `~/.cheaper/cli/bin/cheaper.js` and
  `~/.local/bin/cheaper`, and the launcher executes and reports `cheaper 0.4.2`.
- The same sandbox install from published 0.4.1 produces neither file — the failure in the
  report reproduces on demand.

## Also regenerated: the public changelog page

`cheaper-web/web/changelog.html` still asserted "The currently published CLI is
`cheaper@0.4.1`". That page is generated from this repo's `CHANGELOG.md` by
`scripts/render-changelog.js`, and `--check` reported it STALE. Regenerated and committed
as `03781d8` in `cheaper-web`.

This matters more than a version string: publishing 0.4.2 without it would have put
cheaper.app back into exactly the state `cheaper-deploy.sh`'s own pre-flight comment
describes from 2026-08-10 — the site telling every visitor a false "current" version. The
pre-flight compares `CHANGELOG.md` to `cli/package.json`; it does **not** check the
rendered page, so nothing would have caught it.

## Release — use `cheaper-deploy.sh`, not `npm publish`

```
cd /Users/fortunevieyra/Documents/Github/ownasquare.com
./cheaper-deploy.sh git web cli verify
```

`git` pushes the three commits, `web` deploys the regenerated page and purges the CDN,
`cli` publishes (deliberately last — an npm version is immutable), `verify` asks the
registry what it actually serves rather than trusting `npm publish`'s own output.

**Must run in a real terminal** — npm's browser approval is only offered when stdin and
stdout are both TTYs — and **on the machine that owns the checkout**: the git credential
helper resolves to a `/Users/...` path absent on a machine that only mounted the volume,
and `npm whoami` returns 401 there.

### `desktop` and `docker` are deliberately excluded

`cheaper-desktop/package.json` is 0.4.1 while `cli/package.json` is now 0.4.2, and
`dist/` holds `Cheaper-0.4.1-*.dmg`. `step_desktop` refuses the whole step on that
disagreement (`cheaper-deploy.sh:1388`). Because `err()` sets `FAILED` without aborting,
and `cli` runs *after* `desktop`, a bare full run would refuse the desktop upload, publish
0.4.2 to npm anyway, and exit 1 — the immutable half done, the run reported as failed.

The fix here is CLI-only and the desktop app genuinely is 0.4.1, so scoping the run is
correct. Before the next bare `./cheaper-deploy.sh`, either bump `cheaper-desktop` to
match and rebuild (`npm run dist:mac` — stale 0.4.1 filenames are refused per-file), or
keep scoping the steps.

## Status — NOT yet released

Until the publish lands, `npx cheaper install --all` still serves 0.4.1 and still produces
the broken install described above.

## Follow-up

- Publishing is the only thing that fixes this for users; the commit alone changes nothing
  for anyone running `npx`.
- Consider a release check that fails when `cli/package.json`'s version equals the current
  `latest` on npm while `git log` shows commits touching `cli/` since that publish. This
  defect was invisible precisely because the repo was correct — ten commits touching `cli/`
  had accumulated behind an unchanged version number.
