#!/usr/bin/env bash
# promote.sh — the branch-promotion ENGINE for the Cheaper release track.
#
# SOURCE THIS FILE. It defines functions and touches nothing at source time:
#
#     . "$APP/scripts/promote.sh"
#
# It moves BRANCHES and NOTHING ELSE. It never runs wrangler, never runs `npm publish`,
# never writes to R2, never purges a cache, never builds anything. The deploy happens in
# cheaper-deploy.sh, between promote_release and promote_finish, and this file has no
# opinion about how. Keeping the two apart is deliberate: a promotion that half-published
# is unrecoverable, whereas a promotion that stopped between two branches is a branch you
# can look at.
#
# ── THE TRACK ──────────────────────────────────────────────────────────────────────
#
#   dev → test → staging → backup-YYYY-MM-DD → prod → release-v<version>
#       → [DEPLOY, from the release ref] → merge prod into main
#       → checkout dev, merge main into dev
#
#   promote_preflight                 every repo: clean, dev exists, dev level with origin
#   promote_bootstrap                 create dev/test/staging/prod from main (opt-in only)
#   promote_to test                   dev     → test
#   promote_to staging                test    → staging
#   promote_backup <YYYY-MM-DD>       snapshot the OUTGOING prod before it is replaced
#   promote_to prod                   staging → prod
#   promote_release <version>         prod    → release-v<version>
#   …caller deploys from the release ref…
#   promote_finish                    prod → main, then main → dev
#   promote_where                     which branch is each repo on, right now
#
# WHY backup COMES BEFORE prod IS MOVED. backup-YYYY-MM-DD is the rollback point, and the
# thing worth rolling back to is the production that is about to be OVERWRITTEN. Taken
# after the merge it would be a snapshot of the new release — a backup of the thing you
# would be recovering from, which is no backup at all.
#
# WHY THE DEPLOY RUNS FROM THE RELEASE REF, NOT FROM prod. prod keeps moving; release-v0.4.2
# never does. If a deploy is ever questioned, "what exactly went live" has to be answerable
# by name months later, and a branch tip is not an answer.
#
# WHY main IS MERGED LAST RATHER THAN FIRST. main is the repo's public face — the branch
# GitHub shows a visitor by default. Merging prod into main at the END means main states
# what is IN PRODUCTION rather than what someone hopes to ship. Then main is merged back
# into dev so the next cycle starts from what is live, and dev never quietly drifts behind
# a hotfix that went out through prod.
#
# ── SAFETY. THIS SECTION IS THE POINT OF THE FILE. ─────────────────────────────────
#
# This workspace has already lost work twice to branch-hopping deploy automation:
# merge-deploy.sh / fast-deploy.sh hopped dev → main → prod → backup-* and cleaned the
# tree on the way, and files that had never been committed were destroyed with no reflog
# entry to recover them, because a file that was never a git object has no history to
# recover FROM. `git status` afterwards was clean and the branch was valid, so nothing
# looked wrong. The loss was silent.
#
# This engine therefore does NONE of the following, anywhere, under any flag:
#
#   * `git clean`            — the command that did the destroying.
#   * `git stash`            — it races the workspace's auto-commit automation, and a
#                              stash entry is exactly as easy to lose as the edit was.
#   * `git checkout -f` / `git switch --force` / `--discard-changes` — the same deletion
#                              wearing a different name.
#   * `git push --force` / `--force-with-lease` — a promotion branch is shared; a force
#                              push discards a teammate's commit with no local copy.
#   * `git branch -D`, `git worktree remove --force`.
#   * `git rebase`, `git commit --amend`, `git reset --hard` — no history is rewritten.
#
# When the tree is dirty this engine REFUSES TO HOP. It does not clean, does not stash,
# does not "handle" it: it prints what is dirty and stops. Uncommitted work is the single
# thing here that cannot be reconstructed from a remote, so it outranks finishing the run.
#
# EVERY REPO IS CHECKED BEFORE ANY REPO IS HOPPED. Hopping cheaper-app and then finding
# cheaper-web dirty leaves the workspace straddling two branches mid-release — the state
# that made the original loss invisible. Each entry point runs a full pre-pass across all
# repos and only then starts moving.
#
# EVERY MERGE IS VERIFIED AFTER THE FACT, never assumed:
#     git -C <repo> merge-base --is-ancestor <source> <target>
# `git merge` exiting 0 means git believed it did something. This asks the repository
# whether the commit is actually reachable now. The two have diverged before, and the exit
# status of a git command whose rc was discarded is the single most common defect already
# fixed in cheaper-deploy.sh. Every git call in this file captures rc, and a rc that cannot
# be interpreted is reported as "could not determine" — which is a REFUSAL, never a pass.
# "I could not look" is not "there is nothing there".
#
# A FAILED STAGE ALWAYS SAYS WHERE IT LEFT EVERY REPO. On any abort the engine restores the
# failing repo to the branch it was on when that stage began (a restore that is itself
# verified) and then prints promote_where for all repos, including the ones that already
# moved. It does NOT try to un-merge a repo that succeeded: undoing a pushed merge means
# rewriting history, which is banned above, and a half-rolled-back release that claims to
# be clean is worse than one that says plainly where it stopped.
#
# ── MERGE POLICY, and why ──────────────────────────────────────────────────────────
#
# `--ff-only` FIRST, ALWAYS. A fast-forward makes the target's tree BYTE-IDENTICAL to the
# source's: after `promote_to prod`, prod and staging are the same sha, so "prod is what we
# tested" is a checkable claim rather than a hopeful one. It also cannot conflict and
# cannot invent a merge commit nobody reviewed.
#
# `--no-ff` ONLY when a fast-forward is impossible — i.e. the target has commits the source
# does not (a hotfix committed straight onto prod, or main carrying a README edit). Then the
# merge commit is recorded EXPLICITLY, with a message naming both stages
# ("promote: staging -> prod"), so the history says which promotion produced it.
#
# PLAIN `git merge` IS NEVER USED. It silently does either one, so afterwards you cannot
# tell from the command whether history stayed linear. `--squash` and `--rebase` are never
# used either: both rewrite the commit identities, and the whole track depends on
# `merge-base --is-ancestor` finding the SAME commits further down the line.
#
# A CONFLICT ABORTS THAT REPO (`git merge --abort`), restores it to the branch the stage
# started on, and STOPS THE WHOLE RUN. A repo is never left carrying conflict markers on a
# promotion branch: those markers are a syntax error in every file they touch, and prod is
# the branch this stack deploys from.
#
# ── CONFIGURATION (set before calling; every one has a safe default) ───────────────
#
#   PROMOTE_WORKSPACE        dir containing the three repos. Defaults to $WORKSPACE, which
#                            cheaper-deploy.sh already resolves.
#   PROMOTE_REPO_NAMES       space-separated repo dir names.
#                            Default: "cheaper-app cheaper-web cheaper-desktop".
#   PROMOTE_REMOTE           default "origin".
#   PROMOTE_ALLOW_BOOTSTRAP  must be `true` before promote_bootstrap will create anything.
#                            Wire it in cheaper-deploy.sh's arg loop as its own flag:
#                                --promote-bootstrap) PROMOTE_ALLOW_BOOTSTRAP=true ;;
#                            It is a separate flag, never implied by --yes and never part
#                            of a normal run, because bootstrap CREATES FOUR SHARED
#                            BRANCHES in three remotes. --yes automates a question that was
#                            going to be asked; this authorises a side effect nobody asked
#                            about. On the day all three repos have only `main` — today —
#                            that is the intended one-time act; on every day after, an
#                            implicit bootstrap would mean a typo'd branch name silently
#                            resurrecting a stage that was deleted on purpose.
#
# ── STATE THE CALLER MAY READ ─────────────────────────────────────────────────────
#
#   PROMOTE_ABORTED   1 once any stage has failed. Every entry point refuses to start while
#                     it is 1, so a caller that forgets to check an rc still cannot drive
#                     the track past a failure.
#   PROMOTE_FAILED    1 if anything at all failed (mirrors cheaper-deploy.sh's FAILED).
#   PROMOTE_BACKUP_BRANCH / PROMOTE_RELEASE_BRANCH   the names actually created.
#
# Every function returns 0 on success and non-zero on refusal. NOTHING here calls `exit`:
# a sourced module that exits kills the caller mid-release, which is precisely the
# "stopped somewhere, said nothing" failure this file exists to prevent.

# ---- configuration ---------------------------------------------------------
# Assigned with := so a caller that set them wins, and so `set -u` in cheaper-deploy.sh
# cannot trip over an unset name later.
: "${PROMOTE_WORKSPACE:=${WORKSPACE:-}}"
: "${PROMOTE_REPO_NAMES:=cheaper-app cheaper-web cheaper-desktop}"
: "${PROMOTE_REMOTE:=origin}"
: "${PROMOTE_ALLOW_BOOTSTRAP:=false}"

# The linear part of the track. backup-* and release-v* hang off prod and are not stages.
: "${PROMOTE_DEV_BRANCH:=dev}"
: "${PROMOTE_MAIN_BRANCH:=main}"
: "${PROMOTE_STAGES:=dev test staging prod}"

# A backup name collides when two releases go out on one day. 50 is not a real limit, it is
# a runaway guard: if the search ever gets that far the ref store is being misread, and
# looping forever inside a release script is its own outage.
: "${PROMOTE_BACKUP_MAX_SUFFIX:=50}"

# ---- state -----------------------------------------------------------------
: "${PROMOTE_ABORTED:=0}"
: "${PROMOTE_FAILED:=0}"
: "${PROMOTE_BACKUP_BRANCH:=}"
: "${PROMOTE_RELEASE_BRANCH:=}"
# Where each repo was when the CURRENT stage began, as "name=branch" lines. The failure
# path restores from this, so it is rewritten at the top of every stage rather than once.
: "${PROMOTE_STAGE_ENTRY_BRANCHES:=}"

# ---- output ----------------------------------------------------------------
# Delegate to cheaper-deploy.sh's printers WHEN THEY EXIST, so a sourced run looks like one
# script instead of two, and err() keeps flipping the host's FAILED. Resolved at CALL time,
# not at source time: the orchestrator may source this file before it defines its helpers,
# and a source-time snapshot would silently fall back to the plain printers forever.
_pr_b(){    if declare -F b    >/dev/null 2>&1; then b    "$@"; else printf '\n\033[1m%s\033[0m\n' "$*"; fi; }
_pr_say(){  if declare -F say  >/dev/null 2>&1; then say  "$@"; else printf '  %s\n' "$*"; fi; }
_pr_ok(){   if declare -F ok   >/dev/null 2>&1; then ok   "$@"; else printf '  \033[32m✓\033[0m %s\n' "$*"; fi; }
_pr_warn(){ if declare -F warn >/dev/null 2>&1; then warn "$@"; else printf '  \033[33m! %s\033[0m\n' "$*"; fi; }
_pr_err(){  PROMOTE_FAILED=1
            if declare -F err >/dev/null 2>&1; then err "$@"; else printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; fi; }

# ---- repo enumeration ------------------------------------------------------
# Names, not an array: bash 3.2 ships on macOS and `${arr[@]}` on an empty array is an
# unbound-variable error there under `set -u`. A space-separated string has no such edge.
_pr_repo_dir(){ printf '%s/%s' "$PROMOTE_WORKSPACE" "$1"; }

# Refuses rather than iterating nothing. An empty PROMOTE_WORKSPACE used to be survivable
# here — every loop body would just never run, every check would "pass", and the engine
# would report a green promotion having examined zero repositories.
_pr_have_workspace(){
  if [ -z "$PROMOTE_WORKSPACE" ]; then
    _pr_err "promote: PROMOTE_WORKSPACE is empty — no repositories to promote. Set PROMOTE_WORKSPACE (or WORKSPACE) to the directory containing $PROMOTE_REPO_NAMES."
    return 1
  fi
  if [ ! -d "$PROMOTE_WORKSPACE" ]; then
    _pr_err "promote: PROMOTE_WORKSPACE '$PROMOTE_WORKSPACE' is not a directory"
    return 1
  fi
  local n found=0
  for n in $PROMOTE_REPO_NAMES; do found=$((found+1)); done
  if [ "$found" -eq 0 ]; then
    _pr_err "promote: PROMOTE_REPO_NAMES is empty — there is nothing to promote, and an empty run must not read as a successful one"
    return 1
  fi
  return 0
}

# ---- abort plumbing --------------------------------------------------------
# Checked at the TOP of every public entry point. The orchestrator wires these functions
# into a step list, and a step list that ignores one rc would otherwise carry a broken
# release all the way to prod. Failing closed here means the worst a missed rc can do is
# print a refusal.
_pr_guard(){
  if [ "$PROMOTE_ABORTED" = "1" ]; then
    _pr_err "promote: the run was already ABORTED by an earlier stage — refusing to continue. Nothing further will be merged or pushed."
    promote_where
    return 1
  fi
  return 0
}

# Marks the run dead, says why, and reports where every repo is standing. Always returns 1
# so callers can `_pr_abort "…" && return 1`-style chain without inverting the logic.
_pr_abort(){
  PROMOTE_ABORTED=1
  _pr_err "$*"
  _pr_say "the promotion run is ABORTED. Nothing else will be merged or pushed."
  promote_where
  return 1
}

# ---- low-level git, every one of them rc-capturing -------------------------

# Prints every local branch and every remote-tracking branch on $PROMOTE_REMOTE.
# rc 0 = the list is authoritative; non-zero = the ref store could not be read, and the
# caller MUST treat that as a refusal rather than as "the branch does not exist". Those two
# answers are indistinguishable from `show-ref --quiet`, which is why this exists.
_pr_ref_list(){  # $1 dir
  git -C "$1" for-each-ref --format='%(refname)' refs/heads "refs/remotes/$PROMOTE_REMOTE" 2>/dev/null
}

# 0 = exists, 1 = does not exist, 2 = COULD NOT DETERMINE. Callers must branch on all three.
_pr_ref_exists(){  # $1 dir  $2 full refname, e.g. refs/heads/dev
  local dir="$1" want="$2" list rc
  list="$(_pr_ref_list "$dir")"; rc=$?
  [ "$rc" -ne 0 ] && return 2
  printf '%s\n' "$list" | grep -Fxq "$want" && return 0
  return 1
}

_pr_local_branch_exists(){  _pr_ref_exists "$1" "refs/heads/$2"; }
_pr_remote_branch_exists(){ _pr_ref_exists "$1" "refs/remotes/$PROMOTE_REMOTE/$2"; }

# The current branch name, or the empty string. Prints "HEAD" for a detached HEAD — the
# caller must test for that, because a detached HEAD is not a branch and cannot be pushed.
_pr_current_branch(){  # $1 dir
  git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null
}

_pr_short_sha(){  # $1 dir  $2 ref
  git -C "$1" rev-parse --short "$2" 2>/dev/null
}

# Clean means: no modifications, no staged changes, AND no untracked files. Untracked is
# not a lesser state here — an untracked file is the exact thing that was destroyed twice,
# because it has never been a git object and therefore has nothing to recover from.
# A `git status` that FAILS is a refusal: it exits non-zero having printed nothing, and
# empty output is also the "clean" answer, so a discarded rc turns "I could not look" into
# "there is nothing there".
_pr_require_clean(){  # $1 dir  $2 name  -> 0 clean, 1 not (reasons printed)
  local dir="$1" name="$2" dirty rc n
  dirty="$(git -C "$dir" status --porcelain 2>/dev/null)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    _pr_err "$name: git status FAILED (git exit $rc) — cannot tell whether this tree holds uncommitted work, and 'cannot tell' is not 'clean'. Refusing to hop branches."
    return 1
  fi
  if [ -n "$dirty" ]; then
    n="$(printf '%s\n' "$dirty" | grep -c .)"
    _pr_err "$name: working tree is DIRTY ($n path(s)) — REFUSING to change branches. Uncommitted and untracked files are the only thing here that no remote can give back."
    printf '%s\n' "$dirty" | head -n 12 | sed 's/^/        /'
    [ "$n" -gt 12 ] && _pr_say "        … and $((n-12)) more"
    _pr_say "    this engine will NOT clean, stash or discard them. Commit them (./cheaper-deploy.sh git), or move them aside yourself, then re-run."
    return 1
  fi
  return 0
}

# `fetch --prune` with its rc captured. A failed fetch leaves every remote-tracking ref
# STALE, and every question this engine asks is answered against those refs — so a fetch
# failure is a refusal, not a shrug. cheaper-deploy.sh's old git_repo() learned this the
# hard way with `|| true` on the fetch: "in sync with origin" quietly became "in sync with
# whatever we last heard".
_pr_fetch(){  # $1 dir  $2 name
  local dir="$1" name="$2" out rc
  out="$(git -C "$dir" fetch --quiet --prune "$PROMOTE_REMOTE" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    _pr_err "$name: git fetch $PROMOTE_REMOTE FAILED (git exit $rc) — remote-tracking refs are STALE, so nothing below can be established. Refusing to promote on a guess."
    [ -n "$out" ] && _pr_say "    git said: $out"
    return 1
  fi
  return 0
}

# Switch branches WITHOUT any force flag, and verify afterwards that we actually landed
# there. `git switch` reporting success while HEAD stayed put would otherwise merge the
# next stage into the WRONG branch and push it.
_pr_switch(){  # $1 dir  $2 name  $3 branch
  local dir="$1" name="$2" br="$3" cur out rc
  cur="$(_pr_current_branch "$dir")"
  [ "$cur" = "$br" ] && return 0

  # Re-check immediately before the hop, not only in the pre-pass: minutes can pass
  # between the two while another agent in this workspace writes a file.
  _pr_require_clean "$dir" "$name" || return 1

  local exists; _pr_local_branch_exists "$dir" "$br"; exists=$?
  case "$exists" in
    0) out="$(git -C "$dir" switch "$br" 2>&1)"; rc=$? ;;
    1) # No local branch. Create it from the remote-tracking ref if there is one — that is
       # a new branch, not a reset of an existing one, so nothing can be lost.
       local rexists; _pr_remote_branch_exists "$dir" "$br"; rexists=$?
       case "$rexists" in
         0) out="$(git -C "$dir" switch -c "$br" --track "$PROMOTE_REMOTE/$br" 2>&1)"; rc=$? ;;
         1) _pr_err "$name: branch '$br' does not exist locally or on $PROMOTE_REMOTE — the track cannot continue. Run the bootstrap stage once (PROMOTE_ALLOW_BOOTSTRAP=true) to create the stage branches from '$PROMOTE_MAIN_BRANCH'."
            return 1 ;;
         *) _pr_err "$name: cannot read the ref store to see whether '$PROMOTE_REMOTE/$br' exists — refusing to guess"
            return 1 ;;
       esac ;;
    *) _pr_err "$name: cannot read the ref store to see whether '$br' exists — refusing to guess"
       return 1 ;;
  esac

  if [ "$rc" -ne 0 ]; then
    _pr_err "$name: could not switch to '$br' (git exit $rc)"
    [ -n "$out" ] && _pr_say "    git said: $out"
    return 1
  fi
  cur="$(_pr_current_branch "$dir")"
  if [ "$cur" != "$br" ]; then
    _pr_err "$name: git switch reported success but HEAD is on '${cur:-<unreadable>}', not '$br' — refusing to act on a branch this engine cannot identify"
    return 1
  fi
  return 0
}

# Bring the CHECKED-OUT branch up to its remote-tracking ref, fast-forward only. If the two
# have diverged this fails, and that failure is correct: reconciling them means either a
# merge nobody asked for or a force push, and a promotion stage is not the place to decide
# which. Skipped silently when the branch has no remote-tracking ref yet (freshly created
# locally — its first push is what creates it).
_pr_ff_from_remote(){  # $1 dir  $2 name  $3 branch
  local dir="$1" name="$2" br="$3" out rc rexists
  _pr_remote_branch_exists "$dir" "$br"; rexists=$?
  case "$rexists" in
    0) : ;;
    1) return 0 ;;
    *) _pr_err "$name: cannot read the ref store while checking '$PROMOTE_REMOTE/$br' — refusing to guess"; return 1 ;;
  esac
  out="$(git -C "$dir" merge --ff-only "$PROMOTE_REMOTE/$br" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    _pr_err "$name: local '$br' has DIVERGED from $PROMOTE_REMOTE/$br (git exit $rc) — it cannot be fast-forwarded, and this engine will not force-push or rewrite it"
    [ -n "$out" ] && _pr_say "    git said: $out"
    _pr_say "    inspect it yourself: git -C $dir log --oneline --left-right $PROMOTE_REMOTE/$br...$br"
    return 1
  fi
  return 0
}

# --ff-only, falling back to --no-ff. See the MERGE POLICY block at the top of this file.
# A conflict aborts the merge here; the CALLER is responsible for restoring the branch and
# stopping the run, because only the caller knows which branch the stage started on.
_pr_merge(){  # $1 dir  $2 name  $3 source-ref  $4 target-branch (already checked out)
  local dir="$1" name="$2" src="$3" tgt="$4" out rc

  out="$(git -C "$dir" merge --ff-only "$src" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    _pr_say "    $name: $src → $tgt fast-forward"
    return 0
  fi

  # --ff-only refuses BEFORE touching the working tree when the merge is not a
  # fast-forward, so there is normally nothing to clean up. Assert that rather than
  # assume it: if a merge really is in flight, falling through to --no-ff would compound
  # one broken state with another.
  if git -C "$dir" rev-parse --verify --quiet MERGE_HEAD >/dev/null 2>&1; then
    _pr_err "$name: --ff-only left a merge IN PROGRESS on '$tgt' (git exit $rc) — this is not a state this engine created or understands"
    [ -n "$out" ] && _pr_say "    git said: $out"
    return 1
  fi
  if ! _pr_require_clean "$dir" "$name"; then
    _pr_err "$name: the working tree became dirty during the attempted merge of $src into '$tgt' — stopping rather than merging over it"
    return 1
  fi

  _pr_say "    $name: $src → $tgt is not a fast-forward ('$tgt' holds commits '$src' does not) — recording an explicit merge commit"
  out="$(git -C "$dir" merge --no-ff -m "promote: $src -> $tgt" "$src" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    _pr_say "    $name: $src → $tgt merged (--no-ff)"
    return 0
  fi

  # Conflict, or any other mid-merge failure. Abort it so the tree carries no conflict
  # markers: those markers are a syntax error in every file they touch, and prod is the
  # branch this stack deploys from.
  if git -C "$dir" rev-parse --verify --quiet MERGE_HEAD >/dev/null 2>&1; then
    local aout arc
    aout="$(git -C "$dir" merge --abort 2>&1)"; arc=$?
    if [ "$arc" -ne 0 ]; then
      _pr_err "$name: merge of $src into '$tgt' CONFLICTED and 'git merge --abort' ALSO failed (git exit $arc). This repo is mid-merge and needs a human NOW: git -C $dir status"
      [ -n "$aout" ] && _pr_say "    git said: $aout"
      return 1
    fi
    _pr_err "$name: merge of $src into '$tgt' CONFLICTED — aborted, the tree is restored, and NOTHING was pushed"
  else
    _pr_err "$name: merge of $src into '$tgt' FAILED (git exit $rc) with no merge in progress"
  fi
  [ -n "$out" ] && printf '%s\n' "$out" | head -n 12 | sed 's/^/        /'
  _pr_say "    resolve it deliberately, on purpose, by hand:"
  _pr_say "      git -C $dir switch $tgt && git -C $dir merge $src   # then fix, commit, re-run"
  return 1
}

# THE verification. `git merge` exiting 0 means git believed it did something; this asks the
# repository whether <source> is genuinely reachable from <target> now.
# merge-base --is-ancestor: 0 = yes, 1 = NO, anything else = the question could not be
# answered. The third case is reported separately and is still a refusal — a bad ref or an
# unreadable object store collapsing into "not an ancestor" would send the operator hunting
# for a merge problem that does not exist.
_pr_verify_ancestor(){  # $1 dir  $2 name  $3 source  $4 target
  local dir="$1" name="$2" src="$3" tgt="$4" rc
  git -C "$dir" merge-base --is-ancestor "$src" "$tgt" >/dev/null 2>&1; rc=$?
  case "$rc" in
    0) return 0 ;;
    1) _pr_err "$name: VERIFICATION FAILED — '$src' is NOT an ancestor of '$tgt' after the merge reported success. The two disagree, so the merge did not do what it said."
       _pr_say "    check: git -C $dir merge-base --is-ancestor $src $tgt ; echo \$?"
       return 1 ;;
    *) _pr_err "$name: VERIFICATION could not be performed (git exit $rc) — one of '$src' / '$tgt' could not be resolved. 'Could not determine' is not 'verified'."
       return 1 ;;
  esac
}

# Push, then confirm the remote-tracking ref actually moved. `git push` can exit 0 having
# transferred nothing meaningful, and a push that did not land leaves the next stage
# merging a branch nobody else can see.
_pr_push(){  # $1 dir  $2 name  $3 branch
  local dir="$1" name="$2" br="$3" out rc local_sha remote_sha
  out="$(git -C "$dir" push "$PROMOTE_REMOTE" "$br" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    _pr_err "$name: git push $PROMOTE_REMOTE $br FAILED (git exit $rc) — this engine does NOT force-push, so a rejection means the remote moved and must be looked at"
    [ -n "$out" ] && printf '%s\n' "$out" | head -n 10 | sed 's/^/        /'
    return 1
  fi
  local_sha="$(git -C "$dir" rev-parse "$br" 2>/dev/null)"; rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$local_sha" ]; then
    _pr_err "$name: pushed '$br' but cannot read its local sha (git exit $rc) — cannot confirm what landed"
    return 1
  fi
  remote_sha="$(git -C "$dir" rev-parse "$PROMOTE_REMOTE/$br" 2>/dev/null)"; rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$remote_sha" ]; then
    _pr_err "$name: pushed '$br' but $PROMOTE_REMOTE/$br cannot be read (git exit $rc) — cannot confirm the push landed"
    return 1
  fi
  if [ "$local_sha" != "$remote_sha" ]; then
    _pr_err "$name: git push exited 0 but $PROMOTE_REMOTE/$br is $remote_sha while '$br' is $local_sha — the push did NOT land"
    return 1
  fi
  return 0
}

# ---- stage entry bookkeeping ----------------------------------------------
# Recorded fresh at the top of every stage, so the restore path returns a repo to where THIS
# stage found it rather than to wherever the release started. Stored as text, not an
# associative array, because bash 3.2 (macOS's /bin/bash) has none.
_pr_record_entry_branches(){
  PROMOTE_STAGE_ENTRY_BRANCHES=""
  local n dir br
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    br="$(_pr_current_branch "$dir")"
    PROMOTE_STAGE_ENTRY_BRANCHES="$PROMOTE_STAGE_ENTRY_BRANCHES$n=${br:-<unreadable>}
"
  done
}

_pr_entry_branch(){  # $1 repo name -> the branch it was on when this stage began
  printf '%s\n' "$PROMOTE_STAGE_ENTRY_BRANCHES" | grep "^$1=" | head -n 1 | cut -d= -f2-
}

# Put one repo back where this stage found it. Only ever called when the tree is clean (a
# conflict has already been aborted), so this cannot discard anything. If the restore itself
# fails, say so loudly — a repo left on an unexpected branch is exactly the silent mid-hop
# state this engine exists to prevent.
_pr_restore_entry_branch(){  # $1 name
  local n="$1" dir was cur out rc
  dir="$(_pr_repo_dir "$n")"
  was="$(_pr_entry_branch "$n")"
  cur="$(_pr_current_branch "$dir")"
  # Not knowing where it started is itself worth saying. Returning quietly here would leave
  # the abort report claiming a restore that never happened.
  if [ -z "$was" ] || [ "$was" = "<unreadable>" ]; then
    _pr_err "$n: cannot restore — the branch it was on when this stage began was never readable. It is on '${cur:-<unreadable>}'."
    return 1
  fi
  [ "$cur" = "$was" ] && return 0
  out="$(git -C "$dir" switch "$was" 2>&1)"; rc=$?
  cur="$(_pr_current_branch "$dir")"
  if [ "$rc" -ne 0 ] || [ "$cur" != "$was" ]; then
    _pr_err "$n: could NOT be restored to '$was' — it is on '${cur:-<unreadable>}' (git exit $rc)"
    [ -n "$out" ] && _pr_say "    git said: $out"
    return 1
  fi
  _pr_say "    $n: restored to '$was'"
  return 0
}

# ---- promote_where ---------------------------------------------------------
# Report-only, and never fails the run: it is called FROM the failure path, and a reporter
# that can itself abort would swallow the diagnosis it was called to print.
promote_where(){
  _pr_say "where each repo is standing right now:"
  if [ -z "$PROMOTE_WORKSPACE" ]; then
    _pr_say "    (PROMOTE_WORKSPACE is unset — cannot look)"
    return 0
  fi
  local n dir br sha
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    if [ ! -e "$dir/.git" ]; then
      _pr_say "    $n: NOT a git repo at $dir"
      continue
    fi
    br="$(_pr_current_branch "$dir")"
    sha="$(_pr_short_sha "$dir" HEAD)"
    if [ -z "$br" ]; then
      _pr_say "    $n: branch UNREADABLE (git could not answer) at ${sha:-unknown sha}"
    elif [ "$br" = "HEAD" ]; then
      _pr_say "    $n: DETACHED HEAD at ${sha:-unknown sha} — not on any branch"
    else
      _pr_say "    $n: on '$br' at ${sha:-unknown sha}"
    fi
  done
  return 0
}

# ---- promote_preflight -----------------------------------------------------
# Answers one question for all three repos before anything moves: can this workspace start
# a promotion at all? Clean tree, no untracked files, a dev branch that EXISTS, and a dev
# that is level with origin/dev — because the very first hop merges local dev into test,
# and merging a dev that is ahead of origin promotes commits nobody else has, while merging
# one that is behind promotes software OLDER than the team already has.
#
# It checks EVERY repo and only then returns a verdict. Returning on the first failure would
# make an operator fix cheaper-app, re-run, and discover cheaper-web — three runs to learn
# what one run knows.
promote_preflight(){
  _pr_guard || return 1
  _pr_have_workspace || return 1
  _pr_b "promote: pre-flight — can this workspace start a promotion?"

  local n dir blocked=0 rc exists counts behind ahead upstream cur
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"

    # -e, not -d: in a linked worktree and a submodule checkout .git is a FILE.
    if [ ! -e "$dir/.git" ]; then
      _pr_err "$n: not a git repo at $dir — nothing here can be promoted"
      blocked=1; continue
    fi
    if ! _pr_fetch "$dir" "$n"; then blocked=1; continue; fi
    if ! _pr_require_clean "$dir" "$n"; then blocked=1; continue; fi

    _pr_local_branch_exists "$dir" "$PROMOTE_DEV_BRANCH"; exists=$?
    case "$exists" in
      0) : ;;
      1) _pr_err "$n: has no '$PROMOTE_DEV_BRANCH' branch — the track starts there. Run the bootstrap stage once (PROMOTE_ALLOW_BOOTSTRAP=true) to create dev/test/staging/prod from '$PROMOTE_MAIN_BRANCH'."
         blocked=1; continue ;;
      *) _pr_err "$n: cannot read the ref store to see whether '$PROMOTE_DEV_BRANCH' exists — refusing to guess"
         blocked=1; continue ;;
    esac

    _pr_remote_branch_exists "$dir" "$PROMOTE_DEV_BRANCH"; exists=$?
    case "$exists" in
      0) : ;;
      1) _pr_err "$n: '$PROMOTE_DEV_BRANCH' has never been pushed — its commits exist only on this machine, so promoting them would ship code nothing on GitHub describes"
         _pr_say "    fix: git -C $dir push -u $PROMOTE_REMOTE $PROMOTE_DEV_BRANCH"
         blocked=1; continue ;;
      *) _pr_err "$n: cannot read the ref store to see whether '$PROMOTE_REMOTE/$PROMOTE_DEV_BRANCH' exists — refusing to guess"
         blocked=1; continue ;;
    esac

    # left = commits only on the remote (BEHIND), right = only on dev (AHEAD).
    upstream="$PROMOTE_REMOTE/$PROMOTE_DEV_BRANCH"
    counts="$(git -C "$dir" rev-list --left-right --count "$upstream...$PROMOTE_DEV_BRANCH" 2>/dev/null)"; rc=$?
    if [ "$rc" -ne 0 ] || [ -z "$counts" ]; then
      _pr_err "$n: git rev-list FAILED (git exit $rc) — cannot tell whether '$PROMOTE_DEV_BRANCH' is level with $upstream, and 'cannot tell' is not 'level'"
      blocked=1; continue
    fi
    behind="$(printf '%s' "$counts" | awk '{print $1}')"
    ahead="$(printf '%s' "$counts" | awk '{print $2}')"
    if [ "$ahead" != "0" ]; then
      _pr_err "$n: $ahead commit(s) on '$PROMOTE_DEV_BRANCH' are NOT on $upstream — promoting now would carry commits nobody else has all the way to prod"
      git -C "$dir" log --oneline --no-decorate "$upstream..$PROMOTE_DEV_BRANCH" 2>/dev/null | head -n 5 | sed 's/^/        /'
      _pr_say "    fix: git -C $dir push $PROMOTE_REMOTE $PROMOTE_DEV_BRANCH"
      blocked=1; continue
    fi
    if [ "$behind" != "0" ]; then
      _pr_err "$n: $behind commit(s) on $upstream are NOT in '$PROMOTE_DEV_BRANCH' — promoting now would push software OLDER than what is already on origin, and the next push would look like a revert"
      _pr_say "    fix: git -C $dir switch $PROMOTE_DEV_BRANCH && git -C $dir merge --ff-only $upstream"
      blocked=1; continue
    fi

    cur="$(_pr_current_branch "$dir")"
    _pr_ok "$n: clean, '$PROMOTE_DEV_BRANCH' level with $upstream at $(_pr_short_sha "$dir" "$PROMOTE_DEV_BRANCH") (currently on '${cur:-<unreadable>}')"
  done

  if [ "$blocked" -ne 0 ]; then
    _pr_err "promote: pre-flight REFUSED — nothing was merged, nothing was pushed, no branch was changed."
    promote_where
    return 1
  fi
  _pr_ok "promote: all repos are ready to start the track"
  return 0
}

# ---- promote_bootstrap -----------------------------------------------------
# The one-time path that lets a repo which only has 'main' — the real state of all three
# repos today — join the track. Creates dev/test/staging/prod FROM main wherever they are
# missing, and pushes them.
#
# IT NEVER MOVES A BRANCH THAT ALREADY EXISTS. `git branch <b> <main>` fails if <b> exists,
# and that failure is treated as "already bootstrapped", not as an error to work around.
# The alternative — `git branch -f` — would reset an existing prod to main, i.e. silently
# discard everything production had that main did not. That is the whole reason this
# function creates rather than updates, and the reason it is idempotent by construction:
# running it twice is a no-op, not a rollback.
#
# It requires the EXPLICIT opt-in (PROMOTE_ALLOW_BOOTSTRAP=true, wired to its own flag in
# cheaper-deploy.sh) because it creates four shared branches across three remotes. That is
# a deliberate one-time act on the day the track is introduced; implicit, it would mean a
# stage branch deleted on purpose quietly reappearing on the next release.
promote_bootstrap(){
  _pr_guard || return 1
  _pr_have_workspace || return 1

  if [ "$PROMOTE_ALLOW_BOOTSTRAP" != "true" ]; then
    _pr_err "promote: bootstrap is NOT enabled — refusing to create branches nobody asked for."
    _pr_say "    it creates $PROMOTE_STAGES in every repo AND pushes them to $PROMOTE_REMOTE, so it is opt-in on purpose."
    _pr_say "    enable it explicitly for this run: ./cheaper-deploy.sh --promote-bootstrap   (PROMOTE_ALLOW_BOOTSTRAP=true)"
    return 1
  fi

  _pr_b "promote: bootstrap — creating the stage branches from '$PROMOTE_MAIN_BRANCH'"

  # PRE-PASS over every repo first. Creating branches in cheaper-app and then discovering
  # cheaper-web has no main leaves the workspace half-on-the-track, which is worse than not
  # starting: the next run's pre-flight would pass for one repo and fail for another.
  local n dir blocked=0 exists rc
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    if [ ! -e "$dir/.git" ]; then
      _pr_err "$n: not a git repo at $dir"; blocked=1; continue
    fi
    if ! _pr_fetch "$dir" "$n"; then blocked=1; continue; fi
    # Bootstrap creates refs and pushes; it does not touch the working tree. The clean
    # check is here anyway because a dirty repo means someone is mid-edit, and handing them
    # four new branches mid-edit is a coordination failure even when it is technically safe.
    if ! _pr_require_clean "$dir" "$n"; then blocked=1; continue; fi
    _pr_local_branch_exists "$dir" "$PROMOTE_MAIN_BRANCH"; exists=$?
    case "$exists" in
      0) : ;;
      1) _pr_err "$n: has no '$PROMOTE_MAIN_BRANCH' branch — there is no agreed starting point for the stage branches"
         blocked=1 ;;
      *) _pr_err "$n: cannot read the ref store — refusing to guess"; blocked=1 ;;
    esac
  done
  if [ "$blocked" -ne 0 ]; then
    _pr_err "promote: bootstrap REFUSED before creating anything — no branch was created or pushed."
    promote_where
    return 1
  fi

  local stage out created=0 skipped=0
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    for stage in $PROMOTE_STAGES; do
      _pr_local_branch_exists "$dir" "$stage"; exists=$?
      case "$exists" in
        1) out="$(git -C "$dir" branch "$stage" "$PROMOTE_MAIN_BRANCH" 2>&1)"; rc=$?
           if [ "$rc" -ne 0 ]; then
             [ -n "$out" ] && _pr_say "    git said: $out"
             _pr_abort "$n: could not create '$stage' from '$PROMOTE_MAIN_BRANCH' (git exit $rc)"
             return 1
           fi
           created=$((created+1))
           _pr_say "    $n: created '$stage' at $(_pr_short_sha "$dir" "$stage")" ;;
        0) skipped=$((skipped+1))
           _pr_say "    $n: '$stage' already exists at $(_pr_short_sha "$dir" "$stage") — left exactly as it is" ;;
        *) _pr_abort "$n: cannot read the ref store while checking '$stage' — refusing to guess"
           return 1 ;;
      esac
      # Push whether it was created now or already existed locally: a stage branch that
      # exists only on this machine is invisible to CI and to every other clone, which is
      # indistinguishable from not having bootstrapped at all. A push that transfers
      # nothing exits 0.
      if ! _pr_push "$dir" "$n" "$stage"; then
        _pr_abort "$n: '$stage' exists locally but could not be published to $PROMOTE_REMOTE — the track would be invisible to everyone else"
        return 1
      fi
    done
    _pr_ok "$n: stage branches present and pushed ($PROMOTE_STAGES)"
  done

  _pr_ok "promote: bootstrap complete — $created branch(es) created, $skipped already present, all pushed to $PROMOTE_REMOTE"
  return 0
}

# ---- promote_to ------------------------------------------------------------
# The predecessor map. Deliberately a hardcoded case rather than "the item before it in
# PROMOTE_STAGES": the order of the track is a release policy, not a list someone can
# reorder by editing a variable and accidentally promote dev straight into prod.
promote_prev_stage(){  # $1 stage -> prints its source stage, rc 1 if $1 is not a target
  case "$1" in
    test)    printf 'dev' ;;
    staging) printf 'test' ;;
    prod)    printf 'staging' ;;
    *)       return 1 ;;
  esac
  return 0
}

# Merge the previous stage into <stage>, verify it, and push it — in every repo.
#
# ALL REPOS ARE CHECKED BEFORE ANY REPO IS HOPPED (the pre-pass below). Hopping cheaper-app
# and then finding cheaper-web dirty is the exact state that made the earlier losses
# invisible: a workspace straddling two branches, with `git status` clean in the repo you
# happen to look at.
promote_to(){  # $1 stage: test | staging | prod
  _pr_guard || return 1
  _pr_have_workspace || return 1

  local stage="${1:-}" prev
  if [ -z "$stage" ]; then
    _pr_err "promote_to: no stage given. Usage: promote_to test|staging|prod"
    return 1
  fi
  if ! prev="$(promote_prev_stage "$stage")"; then
    _pr_err "promote_to: '$stage' is not a promotion target. The track is: $PROMOTE_STAGES (dev is the source; '$PROMOTE_MAIN_BRANCH' is handled by promote_finish)."
    return 1
  fi

  _pr_b "promote: $prev → $stage"
  _pr_record_entry_branches

  # ---- pre-pass: every repo, before any of them moves ----
  local n dir blocked=0 exists
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    if [ ! -e "$dir/.git" ]; then
      _pr_err "$n: not a git repo at $dir"; blocked=1; continue
    fi
    if ! _pr_fetch "$dir" "$n"; then blocked=1; continue; fi
    if ! _pr_require_clean "$dir" "$n"; then blocked=1; continue; fi
    _pr_local_branch_exists "$dir" "$prev"; exists=$?
    case "$exists" in
      0) : ;;
      1) _pr_err "$n: source branch '$prev' does not exist — '$stage' cannot be promoted from nothing"; blocked=1 ;;
      *) _pr_err "$n: cannot read the ref store while checking '$prev' — refusing to guess"; blocked=1 ;;
    esac
    # The target may legitimately be missing locally while present on the remote; _pr_switch
    # creates a tracking branch for that case. Only a target missing from BOTH is fatal, and
    # it is fatal HERE rather than mid-hop.
    _pr_local_branch_exists "$dir" "$stage"; exists=$?
    if [ "$exists" -eq 1 ]; then
      _pr_remote_branch_exists "$dir" "$stage"; exists=$?
      case "$exists" in
        0) : ;;
        1) _pr_err "$n: target branch '$stage' exists neither locally nor on $PROMOTE_REMOTE — run the bootstrap stage once (PROMOTE_ALLOW_BOOTSTRAP=true)"; blocked=1 ;;
        *) _pr_err "$n: cannot read the ref store while checking '$stage' — refusing to guess"; blocked=1 ;;
      esac
    elif [ "$exists" -ne 0 ]; then
      _pr_err "$n: cannot read the ref store while checking '$stage' — refusing to guess"; blocked=1
    fi
  done
  if [ "$blocked" -ne 0 ]; then
    _pr_err "promote: $prev → $stage REFUSED before any branch was changed — nothing was merged or pushed."
    promote_where
    return 1
  fi

  # ---- the hops ----
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"

    if ! _pr_switch "$dir" "$n" "$stage"; then
      _pr_restore_entry_branch "$n"
      _pr_abort "$n: could not get onto '$stage' — stopping the whole run rather than promoting some repos and not others"
      return 1
    fi
    if ! _pr_ff_from_remote "$dir" "$n" "$stage"; then
      _pr_restore_entry_branch "$n"
      _pr_abort "$n: '$stage' is not in step with $PROMOTE_REMOTE/$stage — stopping"
      return 1
    fi
    if ! _pr_merge "$dir" "$n" "$prev" "$stage"; then
      # _pr_merge has already aborted any in-flight merge, so the tree is clean and this
      # restore cannot discard anything.
      _pr_restore_entry_branch "$n"
      _pr_abort "$n: $prev → $stage failed — stopping the whole run. No repo will be promoted past this point."
      return 1
    fi
    if ! _pr_verify_ancestor "$dir" "$n" "$prev" "$stage"; then
      _pr_abort "$n: $prev → $stage could NOT be verified — stopping BEFORE pushing, so nothing unverified reaches $PROMOTE_REMOTE"
      return 1
    fi
    if ! _pr_push "$dir" "$n" "$stage"; then
      _pr_abort "$n: '$stage' was merged locally but could NOT be pushed — this repo is on '$stage' and AHEAD of $PROMOTE_REMOTE"
      return 1
    fi
    _pr_ok "$n: '$stage' now contains '$prev' at $(_pr_short_sha "$dir" "$stage"), pushed to $PROMOTE_REMOTE"
  done

  _pr_ok "promote: $prev → $stage complete in all repos — every repo is now on '$stage'"
  return 0
}

# ---- promote_backup --------------------------------------------------------
# Snapshot the OUTGOING production before prod is overwritten. Run this BEFORE
# `promote_to prod`; run after, it snapshots the new release and is not a backup of
# anything.
#
# THE DATE IS AN ARGUMENT, NOT `date +%F` READ IN HERE. Two reasons, both concrete:
#   * All three repos must carry the SAME stamp. A clock read per repo puts cheaper-app on
#     backup-2026-08-10 and cheaper-desktop on backup-2026-08-11 when a release crosses
#     midnight, and a rollback set whose members have different names is a rollback set
#     nobody can find.
#   * It makes this testable without waiting for tomorrow.
# An empty or malformed date is a refusal, never a default: `backup-` (from a failed `date`)
# is a branch name that means nothing and collides with itself every single release.
#
# The branch is created with `git branch <name> prod` — NO CHECKOUT. Creating a ref does not
# touch the working tree, so the backup cannot be the thing that loses an edit.
promote_backup(){  # $1 YYYY-MM-DD
  _pr_guard || return 1
  _pr_have_workspace || return 1

  local stamp="${1:-}"
  if [ -z "$stamp" ]; then
    _pr_err "promote_backup: no date given. Pass ONE stamp for the whole release so all repos share it: promote_backup \"\$(date +%Y-%m-%d)\""
    return 1
  fi
  if ! printf '%s' "$stamp" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
    _pr_err "promote_backup: '$stamp' is not a YYYY-MM-DD date — refusing to create a backup branch whose name says nothing about when it was taken"
    return 1
  fi

  _pr_b "promote: backup — snapshotting the OUTGOING 'prod' before it is replaced"
  # Recorded for the abort report only. This stage never checks anything out, so there is
  # nothing to restore — and, for the same reason, it does NOT require a clean tree: a ref
  # created with `git branch` cannot touch a working file, so refusing here would block a
  # rollback point for a reason that does not apply to it.
  _pr_record_entry_branches

  # ---- pre-pass, all repos ----
  local n dir blocked=0 exists local_sha remote_sha rc
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    if [ ! -e "$dir/.git" ]; then
      _pr_err "$n: not a git repo at $dir"; blocked=1; continue
    fi
    if ! _pr_fetch "$dir" "$n"; then blocked=1; continue; fi
    _pr_local_branch_exists "$dir" prod; exists=$?
    case "$exists" in
      0) : ;;
      1) _pr_err "$n: has no 'prod' branch — there is no production state to back up. Run the bootstrap stage once (PROMOTE_ALLOW_BOOTSTRAP=true)."
         blocked=1; continue ;;
      *) _pr_err "$n: cannot read the ref store while checking 'prod' — refusing to guess"; blocked=1; continue ;;
    esac
    # Local prod and origin/prod must agree, or "which one is production?" has no answer and
    # the backup would preserve the wrong tree — discovered only when someone tries to roll
    # back to it.
    _pr_remote_branch_exists "$dir" prod; exists=$?
    if [ "$exists" -eq 0 ]; then
      local_sha="$(git -C "$dir" rev-parse prod 2>/dev/null)"; rc=$?
      remote_sha="$(git -C "$dir" rev-parse "$PROMOTE_REMOTE/prod" 2>/dev/null)"
      if [ "$rc" -ne 0 ] || [ -z "$local_sha" ] || [ -z "$remote_sha" ]; then
        _pr_err "$n: cannot read 'prod' / '$PROMOTE_REMOTE/prod' — cannot establish what production is, so cannot back it up"
        blocked=1; continue
      fi
      if [ "$local_sha" != "$remote_sha" ]; then
        _pr_err "$n: local 'prod' ($(_pr_short_sha "$dir" prod)) and $PROMOTE_REMOTE/prod ($(_pr_short_sha "$dir" "$PROMOTE_REMOTE/prod")) DISAGREE — which one is production? Refusing to snapshot the wrong one."
        _pr_say "    inspect: git -C $dir log --oneline --left-right $PROMOTE_REMOTE/prod...prod"
        blocked=1; continue
      fi
    elif [ "$exists" -ne 1 ]; then
      _pr_err "$n: cannot read the ref store while checking '$PROMOTE_REMOTE/prod' — refusing to guess"; blocked=1; continue
    fi
  done
  if [ "$blocked" -ne 0 ]; then
    _pr_err "promote: backup REFUSED before creating anything — no branch was created or pushed."
    promote_where
    return 1
  fi

  # ---- ONE name for all repos ----
  # The suffix search runs across ALL repos before any branch is created. Choosing per repo
  # would give cheaper-app backup-2026-08-10-2 and cheaper-web backup-2026-08-10 on a
  # second release the same day, and a rollback set with three different names is not a set.
  # Declared and THEN assigned, one per line. `local base=… candidate="$base"` looks
  # equivalent and is not: bash expands every word on the line before `local` runs, so
  # `$base` is still unset there and `set -u` (which cheaper-deploy.sh sets) kills the
  # whole sourced run with "base: unbound variable" — mid-release, right after staging was
  # pushed and before prod was backed up.
  local base candidate suffix free
  base="backup-$stamp"
  candidate="$base"
  suffix=1
  while :; do
    free=1
    for n in $PROMOTE_REPO_NAMES; do
      dir="$(_pr_repo_dir "$n")"
      _pr_local_branch_exists "$dir" "$candidate"; exists=$?
      [ "$exists" -eq 0 ] && { free=0; break; }
      [ "$exists" -eq 2 ] && { _pr_err "$n: cannot read the ref store while searching for a free backup name — refusing to guess"; promote_where; return 1; }
      _pr_remote_branch_exists "$dir" "$candidate"; exists=$?
      [ "$exists" -eq 0 ] && { free=0; break; }
      [ "$exists" -eq 2 ] && { _pr_err "$n: cannot read the ref store while searching for a free backup name — refusing to guess"; promote_where; return 1; }
    done
    [ "$free" -eq 1 ] && break
    suffix=$((suffix+1))
    if [ "$suffix" -gt "$PROMOTE_BACKUP_MAX_SUFFIX" ]; then
      _pr_err "promote_backup: no free name after $PROMOTE_BACKUP_MAX_SUFFIX attempts starting at '$base' — something is wrong with the ref store, and looping forever inside a release script is its own outage"
      return 1
    fi
    candidate="$base-$suffix"
  done
  # An existing name is a second release on the same day, not an error: refusing here would
  # block a hotfix, and overwriting would destroy the morning's rollback point. Suffixing
  # keeps both.
  [ "$candidate" != "$base" ] && _pr_say "    '$base' is already taken — using '$candidate' so the earlier backup is not overwritten"

  local out
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    out="$(git -C "$dir" branch "$candidate" prod 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then
      [ -n "$out" ] && _pr_say "    git said: $out"
      _pr_abort "$n: could not create '$candidate' from 'prod' (git exit $rc)"
      return 1
    fi
    if ! _pr_verify_ancestor "$dir" "$n" prod "$candidate"; then
      _pr_abort "$n: '$candidate' was created but does not contain 'prod' — it is not a backup of anything"
      return 1
    fi
    if ! _pr_push "$dir" "$n" "$candidate"; then
      _pr_abort "$n: '$candidate' exists locally but could NOT be pushed — a rollback point only this machine can see is not a rollback point"
      return 1
    fi
    _pr_ok "$n: '$candidate' → $(_pr_short_sha "$dir" "$candidate") (the prod that is about to be replaced), pushed"
  done

  PROMOTE_BACKUP_BRANCH="$candidate"
  _pr_ok "promote: backup complete — roll back with: git -C <repo> switch $candidate"
  return 0
}

# ---- promote_release -------------------------------------------------------
# Create release-v<version> from prod. This is the ref the caller DEPLOYS from, and the only
# ref in the whole track that never moves again.
#
# AN EXISTING release-v<ver> IS A REFUSAL, not a suffix — the opposite of promote_backup,
# deliberately. A backup name is a timestamp and two backups in one day are both legitimate.
# A release name is an IDENTITY: release-v0.4.2 must mean one tree forever, because an npm
# version is immutable and dl.cheaper.app keys are stable, so "what is 0.4.2?" has to have
# exactly one answer. Suffixing it to release-v0.4.2-2 would produce two refs both claiming
# to be the same release.
promote_release(){  # $1 version (with or without a leading v)
  _pr_guard || return 1
  _pr_have_workspace || return 1

  local ver="${1:-}"
  if [ -z "$ver" ]; then
    _pr_err "promote_release: no version given. Usage: promote_release 0.4.2"
    return 1
  fi
  # Accept 0.4.2 and v0.4.2 identically, so a caller reading cli/package.json and a human
  # typing the tag they saw on GitHub cannot produce two differently-named refs for one
  # release. Exactly one leading v is stripped.
  case "$ver" in v[0-9]*) ver="${ver#v}" ;; esac

  local branch="release-v$ver" rc out
  if ! printf '%s' "$branch" | grep -Eq '^release-v[A-Za-z0-9._+-]+$'; then
    _pr_err "promote_release: '$1' does not make a usable branch name ('$branch') — refusing to create a release ref nobody can type or match"
    return 1
  fi
  # git is the authority on what a ref may be called; the charset test above only exists to
  # produce a better message than git's.
  git check-ref-format "refs/heads/$branch" >/dev/null 2>&1; rc=$?
  if [ "$rc" -ne 0 ]; then
    _pr_err "promote_release: git rejects '$branch' as a branch name (git check-ref-format exit $rc)"
    return 1
  fi

  _pr_b "promote: release — creating '$branch' from 'prod'"
  # As with promote_backup: refs only, no checkout, so no clean-tree gate and nothing to
  # restore. Recorded purely so an abort report can still say where everything is standing.
  _pr_record_entry_branches

  # ---- pre-pass, all repos ----
  local n dir blocked=0 exists local_sha remote_sha
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    if [ ! -e "$dir/.git" ]; then
      _pr_err "$n: not a git repo at $dir"; blocked=1; continue
    fi
    if ! _pr_fetch "$dir" "$n"; then blocked=1; continue; fi
    _pr_local_branch_exists "$dir" prod; exists=$?
    case "$exists" in
      0) : ;;
      1) _pr_err "$n: has no 'prod' branch — there is nothing to cut a release from"; blocked=1; continue ;;
      *) _pr_err "$n: cannot read the ref store while checking 'prod' — refusing to guess"; blocked=1; continue ;;
    esac
    _pr_local_branch_exists "$dir" "$branch"; exists=$?
    case "$exists" in
      1) : ;;
      0) _pr_err "$n: '$branch' ALREADY EXISTS at $(_pr_short_sha "$dir" "$branch") — a release ref names one tree forever and this engine will not move or duplicate it. Bump the version, or delete that ref yourself if it was a mistake."
         blocked=1 ;;
      *) _pr_err "$n: cannot read the ref store while checking '$branch' — refusing to guess"; blocked=1 ;;
    esac
    _pr_remote_branch_exists "$dir" "$branch"; exists=$?
    case "$exists" in
      1) : ;;
      0) _pr_err "$n: '$PROMOTE_REMOTE/$branch' ALREADY EXISTS — that version has already been cut. Bump the version rather than re-pointing a published release ref."
         blocked=1 ;;
      *) _pr_err "$n: cannot read the ref store while checking '$PROMOTE_REMOTE/$branch' — refusing to guess"; blocked=1 ;;
    esac
    # The release must be cut from the prod everyone else can see, not from a local prod
    # that was never pushed — otherwise the deploy runs from bytes no remote describes.
    _pr_remote_branch_exists "$dir" prod; exists=$?
    if [ "$exists" -eq 0 ]; then
      local_sha="$(git -C "$dir" rev-parse prod 2>/dev/null)"
      remote_sha="$(git -C "$dir" rev-parse "$PROMOTE_REMOTE/prod" 2>/dev/null)"
      if [ -z "$local_sha" ] || [ -z "$remote_sha" ]; then
        _pr_err "$n: cannot read 'prod' / '$PROMOTE_REMOTE/prod' — cannot establish what would be released"; blocked=1
      elif [ "$local_sha" != "$remote_sha" ]; then
        _pr_err "$n: local 'prod' and $PROMOTE_REMOTE/prod DISAGREE — refusing to cut a release from a prod nobody else has"; blocked=1
      fi
    elif [ "$exists" -ne 1 ]; then
      _pr_err "$n: cannot read the ref store while checking '$PROMOTE_REMOTE/prod' — refusing to guess"; blocked=1
    fi
  done
  if [ "$blocked" -ne 0 ]; then
    _pr_err "promote: release REFUSED before creating anything — no branch was created or pushed."
    promote_where
    return 1
  fi

  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    out="$(git -C "$dir" branch "$branch" prod 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then
      [ -n "$out" ] && _pr_say "    git said: $out"
      _pr_abort "$n: could not create '$branch' from 'prod' (git exit $rc)"
      return 1
    fi
    if ! _pr_verify_ancestor "$dir" "$n" prod "$branch"; then
      _pr_abort "$n: '$branch' was created but does not contain 'prod' — it does not describe the release"
      return 1
    fi
    if ! _pr_push "$dir" "$n" "$branch"; then
      _pr_abort "$n: '$branch' exists locally but could NOT be pushed — the deploy would run from a ref nothing on $PROMOTE_REMOTE describes"
      return 1
    fi
    _pr_ok "$n: '$branch' → $(_pr_short_sha "$dir" "$branch"), pushed"
  done

  PROMOTE_RELEASE_BRANCH="$branch"
  _pr_ok "promote: release ref '$branch' exists in all repos — deploy from it, then run promote_finish"
  return 0
}

# ---- promote_finish --------------------------------------------------------
# The owner's closing loop, and both halves matter:
#   prod → main   so main states what is IN PRODUCTION. main is what GitHub shows a visitor
#                 by default; leaving it behind prod means the repo's public face describes
#                 software nobody is running.
#   main → dev    so dev never drifts behind. Without it, a hotfix that went out through
#                 prod is missing from dev, and the NEXT release silently reverts it — which
#                 is a re-introduced bug that no diff in the release will explain.
# Both merges are verified, and the run ends with every repo on dev, which is where the next
# cycle starts.
promote_finish(){
  _pr_guard || return 1
  _pr_have_workspace || return 1

  local main="$PROMOTE_MAIN_BRANCH" dev="$PROMOTE_DEV_BRANCH"
  _pr_b "promote: finish — prod → $main, then $main → $dev"
  _pr_record_entry_branches

  # ---- pre-pass, all repos ----
  local n dir blocked=0 exists b
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    if [ ! -e "$dir/.git" ]; then
      _pr_err "$n: not a git repo at $dir"; blocked=1; continue
    fi
    if ! _pr_fetch "$dir" "$n"; then blocked=1; continue; fi
    if ! _pr_require_clean "$dir" "$n"; then blocked=1; continue; fi
    for b in prod "$main" "$dev"; do
      _pr_local_branch_exists "$dir" "$b"; exists=$?
      case "$exists" in
        0) : ;;
        1) _pr_err "$n: branch '$b' does not exist — the closing loop needs prod, $main and $dev"; blocked=1 ;;
        *) _pr_err "$n: cannot read the ref store while checking '$b' — refusing to guess"; blocked=1 ;;
      esac
    done
  done
  if [ "$blocked" -ne 0 ]; then
    _pr_err "promote: finish REFUSED before any branch was changed — nothing was merged or pushed."
    promote_where
    return 1
  fi

  # ---- prod → main ----
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    if ! _pr_switch "$dir" "$n" "$main"; then
      _pr_restore_entry_branch "$n"
      _pr_abort "$n: could not get onto '$main' — stopping"
      return 1
    fi
    if ! _pr_ff_from_remote "$dir" "$n" "$main"; then
      _pr_restore_entry_branch "$n"
      _pr_abort "$n: '$main' is not in step with $PROMOTE_REMOTE/$main — stopping"
      return 1
    fi
    if ! _pr_merge "$dir" "$n" prod "$main"; then
      _pr_restore_entry_branch "$n"
      _pr_abort "$n: prod → $main failed — stopping. Production is unaffected; only '$main' is behind."
      return 1
    fi
    if ! _pr_verify_ancestor "$dir" "$n" prod "$main"; then
      _pr_abort "$n: prod → $main could NOT be verified — stopping BEFORE pushing"
      return 1
    fi
    if ! _pr_push "$dir" "$n" "$main"; then
      _pr_abort "$n: '$main' was merged locally but could NOT be pushed"
      return 1
    fi
    _pr_ok "$n: '$main' now mirrors prod at $(_pr_short_sha "$dir" "$main"), pushed"
  done

  # ---- main → dev ----
  for n in $PROMOTE_REPO_NAMES; do
    dir="$(_pr_repo_dir "$n")"
    if ! _pr_switch "$dir" "$n" "$dev"; then
      _pr_abort "$n: could not get onto '$dev' after '$main' was published — '$main' IS pushed; only the merge back into '$dev' is missing"
      return 1
    fi
    if ! _pr_ff_from_remote "$dir" "$n" "$dev"; then
      _pr_abort "$n: '$dev' is not in step with $PROMOTE_REMOTE/$dev — '$main' IS pushed; only the merge back into '$dev' is missing"
      return 1
    fi
    if ! _pr_merge "$dir" "$n" "$main" "$dev"; then
      _pr_abort "$n: $main → $dev failed — '$main' IS pushed. Merge it into '$dev' by hand before the next release, or the next release will revert this one."
      return 1
    fi
    if ! _pr_verify_ancestor "$dir" "$n" "$main" "$dev"; then
      _pr_abort "$n: $main → $dev could NOT be verified — stopping BEFORE pushing"
      return 1
    fi
    if ! _pr_push "$dir" "$n" "$dev"; then
      _pr_abort "$n: '$dev' was merged locally but could NOT be pushed"
      return 1
    fi
    _pr_ok "$n: '$dev' now contains '$main' at $(_pr_short_sha "$dir" "$dev"), pushed"
  done

  _pr_ok "promote: finish complete — '$main' mirrors production and '$dev' is caught up"
  promote_where
  return 0
}
