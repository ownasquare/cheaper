# The deploy track had no branch: consolidating three repos back onto `main`

**Date:** 2026-08-09 · **Workspace:** `/Users/fortunevieyra/Documents/Github/ownasquare.com`
**Repos:** `cheaper-app`, `cheaper-web`, `cheaper-desktop` (and `ownasquare`, untouched)
**Result:** `cheaper-app` `64e1d29 → 0a1d6c1` · `cheaper-web` `6cf8504 → 2ec83ad` ·
`cheaper-desktop` `740b6e5 → 33bdc14` — all on `main`, all pushed, all trees clean.

---

## What was actually wrong

The working state was reported as "dev has been silently misrepresenting what it contains
for at least 8 commits". The misrepresentation was real and larger than eight, but the
mechanism was not a stale `dev` branch.

**There is no `dev` branch in any of these repos** — not local, not on origin. Verified by
`git fetch --all --prune` followed by `for-each-ref` on all four. `origin` carried `main`
and, in `cheaper-app`, one feature branch.

**`cheaper-deploy.sh` has no branch track at all.** It contains no `switch`, no `checkout`,
no `merge`, and no reference to `dev`. Two facts follow, and together they are the defect:

- `git_repo()` commits and pushes **whatever branch the repo is currently sitting on**
  (`cheaper-deploy.sh:228`, called at `:451-453` for app/desktop/web);
- `step_web()` runs `wrangler deploy` **from the working tree** (`:685`), not from any ref.

So what ships and what the git history says are independent. On 2026-08-09 they had come
fully apart:

| repo | HEAD branch | on origin/main | uncommitted |
|---|---|---|---|
| cheaper-app | `parity-gates/one-python-launcher` | **none of 6 commits** | 16 files |
| cheaper-web | `main` | none of 3 commits | — |
| cheaper-desktop | `main` | none of 1 commit | 3 files |

Running the deploy in that state would have shipped every one of those changes to
cheaper.app and to R2, while pushing the code to `origin/parity-gates/one-python-launcher`
and leaving `origin/main` at `64e1d29`. The deployed product and the branch a reader would
inspect to audit it would have disagreed, with nothing printing a warning — the deploy would
have reported success, correctly, for the branch it was actually on.

## The uncommitted 16 were three sessions' finished work, not one change

`cheaper-app`'s dirty tree held three concurrent workstreams interleaved. Attribution was
recoverable because each session had already written its own `docs/parity-gates/` note
naming its files. Committed separately rather than as one blob:

| commit | workstream | files |
|---|---|---|
| `81aba1a` | Mistral route-target tier correction | `pricing.js`, `sync-prices.js`, `peek.test.js`, `policy_parity.test.js` + doc |
| `6a91a79` | catalog price verification, OpenAI long-context | `models.js`, `model_prices.json` + doc |
| `a00b557` | peek substitution / route-unpriced counters | `scan.js`, `render.js`, `peek_reconciliation.test.js`, `peek.md`, `README.md` + 2 docs |
| `0a1d6c1` | release bump | `cli/package.json` 0.3.0 → 0.4.0 |

**Each message states that validation was performed on the COMBINED tree, not on that commit
in isolation.** None of the three was ever independently built or tested, because they were
never separable in time — they were developed simultaneously in one tree. Recording that in
the message is the only thing that stops a future bisect from reading a red intermediate
commit as a regression it introduced.

## Validation

| command | before push | result |
|---|---|---|
| `cd cli && npm test` (dirty tree, pre-commit) | yes | **454 pass / 0 fail**, exit 0 |
| `cd cli && npm test` (on `main`, post-merge) | yes | **454 pass / 0 fail**, exit 0 |
| all four gates (`sync-prices`, `check-period-parity`, `check-policy-parity`) | yes | green — 144,180 routing decisions agree |

The suite was re-run **after** the fast-forward, not only before it, because `main` is the
branch the deploy will now ship from.

## How the feature branch was retired

`git branch -d` refused, and its refusal was correct in form but misleading in substance: it
compares against the branch's **upstream** (`origin/parity-gates/one-python-launcher`, still
at `64e1d29`), not against `main`. `-D` was NOT used. Instead the containment was proven
twice and the stale remote ref deleted first:

```
git merge-base --is-ancestor parity-gates/one-python-launcher origin/main   # exit 0
git merge-base --is-ancestor origin/parity-gates/one-python-launcher origin/main  # exit 0
git push origin --delete parity-gates/one-python-launcher
git fetch --prune && git branch -d parity-gates/one-python-launcher        # now succeeds
```

No force flag, no history rewrite, nothing discarded.

## Also removed

`cheaper-desktop/2026-08-08-claude-cheaper-router-honesty-audit.handoff.mdc` — an untracked
beladed handoff document sitting in the desktop repo root. `cheaper-deploy.sh` stages with
`git add -A`, so the next deploy would have committed it into a release repo. Confirmed
byte-identical (`sha256 c70e9811…`) to the copy at its canonical path before removing the
stray; the canonical copy is untouched.

## Known state at the time of writing — ALL THREE NOW CLOSED

*Superseded by `2026-08-09-preflight-gate-and-the-dead-release-matrix.md`. Kept here with
the original wording, and one correction, because two of the three were understated.*

- ~~**`cheaper-desktop/dist/` holds two versions.**~~ **CORRECTION — this was wrong in a way
  that mattered.** The original text said the stale `0.1.0` set "will not be uploaded — a
  designed-for case, not luck", which is true and beside the point. Three of the six keys
  (`*-amd64.deb`, `*-x86_64.rpm`, `*-x86_64.AppImage`) matched **only** a `0.1.0` file,
  because the `0.4.0` Linux build produced `arm64` artifacts and those globs ask for
  `x86_64`. `put_r2()` would have refused each one and `step_desktop` would have exited 1.
  Not a harmless leftover — a run-failing condition. Cleared: the 7 stale `0.1.0` artifacts
  are deleted, along with `Cheaper-0.4.0-arm64.deb`, which was a **96-byte empty `ar`
  archive** (a failed build that matched no glob and would have been a corrupt package the
  moment an arm64 deb key was added).
- ~~**No Windows `Cheaper-Setup-0.4.0.exe`.**~~ **ROOT CAUSE FOUND AND FIXED.** It was never
  a build that produced nothing — it was a build that never ran. `release.yml` carried
  `if: matrix.os == 'macos-latest' && secrets.APPLE_API_KEY_P8 != ''`, and the `secrets`
  context is not available in a step-level `if:`. That does not evaluate to false; it makes
  the whole workflow file invalid, so GitHub created **zero jobs** and every run failed in
  0s with the generic "This run likely failed because of a workflow file issue" — no
  annotation, no job, nothing naming the line. Confirmed on runs `31354189948` and
  `31176699507` (both 0s, both `total_count: 0`); the last good run predates the step.
  The 3-OS matrix had therefore not built once since **2026-08-07**. Fixed by hoisting the
  test to job-level `env:` (the pattern the same file already used for `HAS_AZURE_SIGNING`),
  and pinned by `cheaper-desktop/scripts/check-workflows.js`, wired into `npm test`.
- **`cli/package.json` and `cheaper-desktop/package.json` are both `0.4.0`.** Unchanged and
  still true — the deploy refuses to upload when these disagree, so the lockstep is a
  precondition, not a courtesy.

## What would prevent a recurrence

The root cause is that `cheaper-deploy.sh` deploys the working tree while pushing the current
branch, and never asserts a relationship between the two. It already refuses on far smaller
inconsistencies (a version mismatch between two `package.json` files gets a named error).
A pre-flight assertion in the same spirit — *"HEAD is on the expected release branch, and
that branch is in sync with origin, or stop"* — would have caught this on the first deploy
after the feature branch was created, instead of after six commits.

**CLOSED — the check now exists.** `require_releasable()` in
`cheaper-app/scripts/cheaper-deploy.sh` runs after `git` and before anything publishes, and
refuses on wrong branch, detached HEAD, dirty tree, unpushed commits, or a tree behind
origin — in all three repos, even for a single-step run. 16 scenarios in
`scripts/test-deploy-preflight.sh` cover it, including the exact 2026-08-09 condition.
Full write-up: `2026-08-09-preflight-gate-and-the-dead-release-matrix.md`.
