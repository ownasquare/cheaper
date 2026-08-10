# Closing the three release gaps: a pre-flight gate, a dead CI matrix, and a script with no history

**Date:** 2026-08-09 · **Follows:** [2026-08-09-branch-consolidation-onto-main.md](2026-08-09-branch-consolidation-onto-main.md)
**Commits:** `cheaper-desktop 8dc5ba2` · `cheaper-app 828de97`

The predecessor consolidated three repos back onto `main` and logged three conditions to
read before releasing. This closes all three. Two of them turned out to be understated in
that document, and the corrections are recorded there as well as here.

---

## 1. The pre-flight gate (was: "not implemented; this records the gap")

### The defect

`cheaper-deploy.sh` deploys the **working tree** (`step_web` runs `wrangler deploy` from
`cheaper-web/`; `step_desktop` uploads whatever is in `dist/`) while `step_git` pushes the
**current branch**, whatever that happens to be. Nothing asserted a relationship between
the two, so they could describe different software and every line of output would still be
literally true.

That is not hypothetical. On 2026-08-09 `cheaper-app` sat on
`parity-gates/one-python-launcher`, six commits and sixteen uncommitted files ahead of a
`main` that had none of it. A deploy would have shipped all of it to cheaper.app and R2,
pushed it to the feature branch, and exited 0 with nothing but green.

### What shipped

`require_releasable()` runs **after `git` and before anything publishes**. All three repos
must be on `main`, clean, and level with origin.

| condition | verdict | why it is not cosmetic |
|---|---|---|
| wrong branch / detached HEAD | refuse | this tree deploys, those commits land elsewhere |
| dirty tree (tracked **or** untracked) | refuse | deployed bytes that are in no commit are bytes nothing on GitHub describes |
| ahead of origin | refuse | ships code the remote has never seen |
| **behind** origin | refuse | publishes software OLDER than the team already has; the next push then looks like a revert |
| any git query fails | refuse | a failed fetch leaves the tracking refs stale, and every "in sync?" answer is read from them |

Three design points worth keeping:

- **`git` is deliberately NOT gated.** It is the step whose whole job is to clear the
  conditions the gate checks for. Gating it would deadlock the only tool that can unblock
  the run.
- **All three repos are checked even for a single-step run.** The surfaces are coupled —
  `step_desktop` reads `cli/package.json`'s version, the website advertises both — so "I'm
  only deploying the web" is not a reason to leave `cheaper-app` unexamined. That exact
  assumption is what let the divergence run for days.
- **`pf_bad()` prints red but does not flip `FAILED`.** Whether an unreleasable workspace
  is a *failure* depends on `--allow-unreleasable`, and that decision belongs to the gate,
  not to an individual finding. Using `err()` there would make an explicitly authorised run
  exit 1 anyway — which makes the flag useless and sends the operator to edit the script.

`--allow-unreleasable` and `--allow-partial-platforms` exist so that shipping anyway means
**naming** what is being overridden. A gate with no escape hatch gets commented out.

## 2. The release matrix had been dead for two days, silently

### The defect

`release.yml` carried:

```yaml
if: matrix.os == 'macos-latest' && secrets.APPLE_API_KEY_P8 != ''
```

The `secrets` context is **not available in a job- or step-level `if:`**. This does not
evaluate to false — it makes the entire workflow file invalid. GitHub then creates **zero
jobs** and the run fails in 0s with the generic *"This run likely failed because of a
workflow file issue"*: no annotation, no job, no log, nothing naming the offending line.

| run | date | duration | jobs |
|---|---|---|---|
| `31354189948` | 2026-08-09 | 0s, failure | `total_count: 0` |
| `31176699507` | 2026-08-07 | 0s, failure | `total_count: 0` |
| `31137850531` | 2026-08-07 01:23 | 1m25s, **success** | predates the step |

### Why it looked like something else entirely

The visible symptom was three directories away. Because the 3-OS matrix never ran, no
`Cheaper-Setup-0.4.0.exe` was ever produced, so `cheaper-deploy.sh`'s `*.exe` key found
nothing in `dist/` and took its benign *"no artifact — it comes from CI"* skip, while
dl.cheaper.app kept serving the **previous** Windows installer next to a 0.4.0 macOS
build. Every layer reported something reasonable. "Windows was never built" was really
"the file could not be parsed".

### The fix and its gate

Hoisted to job-level `env:` — the pattern the same file already used eight lines up for
`HAS_AZURE_SIGNING` — and read back as `env.HAS_APPLE_API_KEY == 'true'`.

`cheaper-desktop/scripts/check-workflows.js` refuses any `if:` referencing `secrets.` or
`inputs.`, and is wired into `npm test`. It is a **line scanner, not a YAML parser**, and
says so in its own header: a parser is the wrong tool for a failure mode whose definition
is "a file GitHub itself rejects". Its vacuity floor is deliberately **independent** of
what it asserts (no workflow files read, or no `if:` extracted at all, is a failure, not a
pass) — the same lesson a sibling gate in this repo learned when a floor set equal to the
number of asserted items fired first and blamed the scanner for a source it had read
perfectly.

Both controls executed: positive `npm test` exits 0 ("7 `if:` condition(s) across 1
workflow file"); negative, with the original expression reintroduced, exits 1 and names
`release.yml:86` with the remedy. Restored byte-identically (`sha256 65e86456…`,
re-verified).

## 3. A missing installer is now an error, not a skip

Every R2 destination is a **stable key** — `cheaper-windows-x64.exe` is the same object
every release. A platform with no matching artifact is therefore not skipped harmlessly:
its key keeps serving the previous version while the other platforms move up, under a
website that has already been relabelled. The old code called that a `warn()`, which by
this script's own convention means *"informational, nothing to do"*.

It now errors, names the affected keys, and states what a user on that platform would
actually download. `--allow-partial-platforms` accepts it deliberately and **still** names
them — including in the all-missing case, which previously fell through to a bare
"nothing uploaded" that named no key at all.

## 4. `cheaper-deploy.sh` had no history

The workspace root is not a git repository, so this ~1000-line script — and every failure
mode recorded in its comments, each one paid for once already — existed as a **single
untracked file** with no history, no remote, and no way back if the branch-hopping deploy
automation cleaned the tree.

The canonical copy now lives at `cheaper-app/scripts/cheaper-deploy.sh`; the workspace-root
path is a symlink to it. `WORKSPACE` is no longer `dirname "$0"` (true only while the file
sat at the root) but is found by walking up for a directory containing `cheaper-app/`,
`cheaper-web/` and `cheaper-desktop/`. All three entry points — symlink, relative real
path, absolute real path — are covered by tests.

## Validation

`cheaper-app/scripts/test-deploy-preflight.sh` — **16 scenarios, 16 passing.**

They run the **real** script against a synthetic workspace of three throwaway repos, each
with its own local bare origin. Nothing touches the actual repos, and **no scenario can
publish**: every negative case blocks before a step runs; the positive cases use `docker`,
which returns immediately with no daemon; the desktop cases use an empty `dist/`, so the
step fails before `wrangler` is ever invoked.

| # | scenario | expect |
|---|---|---|
| 1 | clean workspace | proceeds, exit 0 |
| 2 | feature branch (the 2026-08-09 condition) | refused |
| 3 | uncommitted change | refused |
| 4 | untracked file only | refused |
| 5 | committed, never pushed | refused |
| 6 | behind origin | refused |
| 7 | detached HEAD | refused |
| 8 | `--allow-unreleasable` | ships, names the consequence |
| 9 | `git` step | runs ungated |
| 10–11 | missing installer | errors, names the stale key |
| 12–13 | `--allow-partial-platforms` | accepts, still names the keys |
| 14–16 | workspace resolution | all three entry points |

Also verified against the **real** workspace: `./cheaper-deploy.sh docker` prints all three
repos green and proceeds. And the gate caught its own author — the first run after moving
the script reported `cheaper-app: working tree is DIRTY (1 path(s))`, which was the
uncommitted `scripts/` directory.

### The fixture was wrong first, and the gate is what found it

The initial fixture wrote `cli/package.json` and friends *after* the initial commit, so its
own repos were untracked-dirty and the gate refused every scenario — including the ones
asserting a pass. A fixture that trips the gate it is testing proves nothing about the
gate. It now commits everything before pushing, and its throwaway git directories are
gitignored, because while the test runs they would otherwise appear as untracked work in
`cheaper-app` — which the pre-flight would, correctly, refuse on.

## Still open — NOT done, deliberately

- **No 0.4.0 installers exist for Windows or Linux x86_64.** The matrix can now run, but it
  triggers on a `v*` tag or a `workflow_dispatch`, and this machine's `gh` account
  (`beladed-sites`) gets `HTTP 403: Must have admin rights` on dispatch. Producing them
  needs an admin dispatch or a tag push — the latter also creates a GitHub Release and
  uploads the `.exe` to R2, so it is a publish, not a build.
- **`dist/` currently holds macOS `0.4.0` only** (plus an arm64 Linux AppImage that matches
  no configured key — the globs ask for `x86_64`). Until the matrix runs, `./cheaper-deploy.sh
  desktop` will correctly refuse with 4 MISSING keys. That refusal is the new behaviour
  working, not a regression.
- **The `*-arm64.deb` / `*-arm64.AppImage` gap is unaddressed.** The 0.4.0 Linux build
  produced arm64 artifacts and `step_desktop`'s spec list has no arm64 Linux keys, so those
  artifacts can never be uploaded. Adding keys is a distribution decision (new stable URLs
  the website would need to link), not a bug fix, so it is logged rather than ridden along.
