#!/usr/bin/env bash
# End-to-end tests for the Cheaper BRANCH PROMOTION TRACK.
#
#     dev → test → staging → backup-YYYY-MM-DD → prod → release-v<version>
#         → [deploy from the release ref] → prod into main → main into dev
#
# Exercises the two real modules — scripts/promote.sh (branch engine) and
# scripts/release-worktree.sh (deploy-from-ref) — against a synthetic workspace of three
# throwaway git repos, each with its own local bare "origin", built in a mktemp'd directory.
#
# NOTHING HERE TOUCHES THE REAL REPOS AND NOTHING HERE REACHES THE NETWORK.
#   * Every repository under test is created by fresh_ws() seconds before it is used.
#   * Every "remote" is a bare repo on this disk, so `fetch` and `push` are filesystem
#     copies. There is no origin on the internet to reach and no credential to present.
#   * No scenario can publish: promote.sh runs no wrangler, no npm publish, no R2 upload,
#     and rw_build_desktop (the only function in either module that shells out to npm) is
#     never called — see scenario 3, which asserts that no dist/ was produced.
#   * audit_real_repos() at the end PROVES the real cheaper-app / cheaper-web /
#     cheaper-desktop gained no worktree and no promotion branch while this ran.
#
# ── HOW THE STATE PROBLEM IS SOLVED ────────────────────────────────────────────────
#
# promote.sh latches PROMOTE_ABORTED, and every entry point refuses while it is 1. A track
# is therefore only meaningful when its stages run in ONE process. drive() runs a named
# program in a fresh `bash` that sources both modules and calls the stages in sequence, so
# the latch behaves exactly as it will under cheaper-deploy.sh — and so one scenario's
# abort cannot leak into the next scenario's run.
#
# ── PROVING THE HARNESS IS NOT VACUOUS ─────────────────────────────────────────────
#
# A scenario that passes against a broken module is worse than no scenario: it converts
# "untested" into "tested and fine", which is the same class of defect as a git command
# whose exit status was discarded. So every scenario below is paired with a MUTANT — a
# copy of the module with one specific guard removed or inverted — and the run asserts the
# scenario FAILS against it, naming which assertion flipped.
#
# Two rules the mutation machinery learned the hard way and must keep:
#   * A mutant that does not PARSE prints nothing, and a scenario asserting on output then
#     "fails" for a reason that has nothing to do with the guard. _mut_check runs `bash -n`
#     on every mutant and reports a non-parsing one as a harness FAILURE, not as a kill.
#   * A mutation that changed no bytes is also a false kill. _mut_check `cmp`s it.
# The originals are never edited — mutants are separate files — and the run asserts both
# module checksums are byte-identical at the end.
set -u

T="$(cd "$(dirname "$0")" && pwd -P)"
PROMOTE_SRC="$T/promote.sh"
RW_SRC="$T/release-worktree.sh"
REPOS="cheaper-app cheaper-web cheaper-desktop"

for f in "$PROMOTE_SRC" "$RW_SRC"; do
  [ -f "$f" ] || { printf 'test-promote: missing module %s\n' "$f" >&2; exit 2; }
done

# ---- the sandbox ------------------------------------------------------------------
# mktemp, never a path inside a repo. test-deploy-preflight.sh puts its workspace beside
# itself, which is survivable for a script that only reads; this suite creates git repos
# and WORKTREES, and a worktree registered inside the real cheaper-app is precisely the
# untracked-directory shape the tree-cleaning automation in this workspace deletes.
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/cheaper-promote-test.XXXXXX")" || exit 2
TMPROOT="$(cd "$TMPROOT" && pwd -P)"
case "$TMPROOT" in
  */cheaper-promote-test.*) : ;;
  *) printf 'test-promote: refusing — %s is not a mktemp sandbox\n' "$TMPROOT" >&2; exit 2 ;;
esac

WS="$TMPROOT/ws"                 # the synthetic workspace of three repos
DRIVE="$TMPROOT/drive.sh"        # one-process stage runner (written below)
MUTDIR="$TMPROOT/mutants"
WTDEST="$TMPROOT/relwt"          # where release worktrees are materialised
BINDIR="$TMPROOT/bin"            # holds the git argv logger used by scenario 9
GITLOG="$TMPROOT/git-argv.log"
mkdir -p "$MUTDIR" "$BINDIR"

# Modules under test. Repointed at a mutant for the duration of a mutation proof.
PROMOTE_MODULE="$PROMOTE_SRC"
RW_MODULE="$RW_SRC"

PASS=0; FAIL=0; KILLED=0; SURVIVED=0
MUT=0; MUT_FAILS=0; MUT_FIRST=""

cleanup(){
  # Everything this suite created lives under one mktemp'd root, including the worktrees
  # and the bare origins, so removing that root removes all of it. Guarded by the same
  # pattern test as above, because an `rm -rf` whose argument was computed is worth
  # checking twice in a workspace that has already lost work.
  case "${TMPROOT:-}" in
    */cheaper-promote-test.*) rm -rf "$TMPROOT" ;;
  esac
}
trap 'rc=$?; cleanup; exit $rc' EXIT INT TERM

# ---- assertion core ---------------------------------------------------------------
# In MUT mode nothing is printed and nothing touches PASS/FAIL — the failures are counted
# instead, because under a mutant a FAILING assertion is the desired outcome.
_record(){   # $1 0=ok/1=bad  $2 name  $3 detail
  if [ "$MUT" -eq 1 ]; then
    if [ "$1" -ne 0 ]; then
      MUT_FAILS=$((MUT_FAILS+1))
      [ -z "$MUT_FIRST" ] && MUT_FIRST="$2"
    fi
    return 0
  fi
  if [ "$1" -eq 0 ]; then
    PASS=$((PASS+1)); printf '  PASS  %s\n' "$2"
  else
    FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$2"
    [ -n "$3" ] && printf '%s\n' "$3" | sed 's/^/        | /' | head -n 20
  fi
  return 0
}

eq(){     # name expected actual
  if [ "$2" = "$3" ]; then _record 0 "$1" ""
  else _record 1 "$1" "expected: [$2]
  actual: [$3]"; fi
}
ne(){     # name not-expected actual
  if [ "$2" != "$3" ]; then _record 0 "$1" ""
  else _record 1 "$1" "value should NOT have been: [$2]"; fi
}
has(){    # name literal-substring text
  if printf '%s' "$3" | grep -F -q -e "$2"; then _record 0 "$1" ""
  else _record 1 "$1" "output should contain: $2
$3"; fi
}
hasnt(){  # name literal-substring text
  if printf '%s' "$3" | grep -F -q -e "$2"; then _record 1 "$1" "output must NOT contain: $2
$3"
  else _record 0 "$1" ""; fi
}
yes_cmd(){ local n="$1"; shift; if "$@" >/dev/null 2>&1; then _record 0 "$n" ""; else _record 1 "$n" "command failed: $*"; fi; }
no_cmd(){  local n="$1"; shift; if "$@" >/dev/null 2>&1; then _record 1 "$n" "command unexpectedly SUCCEEDED: $*"; else _record 0 "$n" ""; fi; }

sec(){ [ "$MUT" -eq 0 ] && printf '\n=== %s ===\n' "$*"; return 0; }

# ---- fixture ----------------------------------------------------------------------
# --verify --quiet, never a bare `rev-parse`. A bare `git rev-parse dev` on a repo with no
# dev branch prints the STRING "dev" on stdout and exits 128, so an assertion that a branch
# does not exist compares "" against "dev" and fails — and, far worse, an assertion that two
# refs MATCH would compare two identical unresolved names and PASS. The harness's own
# "could not determine must never render as fine" bug, found by scenario 1.
sha(){       git -C "$WS/$1" rev-parse --verify --quiet "$2^{commit}" 2>/dev/null; }
branch_of(){ git -C "$WS/$1" rev-parse --abbrev-ref HEAD 2>/dev/null; }

# Snapshots, because "assert the COMMIT SHAs" needs the before-value of three repos at
# once and bash 3.2 (macOS's /bin/bash) has no associative arrays.
# Conflict markers in a file, as a single line. `grep -F -c … || printf '0'` looks
# equivalent and is not: grep -c PRINTS "0" and EXITS 1 when it matches nothing, so the
# fallback fires as well and the answer comes back as two lines, "0\n0". A missing file is
# reported by name rather than as zero — "the file is not there" is not "the file is clean".
marker_count(){   # $1 path
  if [ ! -f "$1" ]; then printf 'NO-SUCH-FILE'; return 0; fi
  grep -F -c '<<<<<<<' "$1" 2>/dev/null | head -n 1
}

record_shas(){  # $1 tag  $2 ref
  : > "$TMPROOT/shas.$1"
  local r
  for r in $REPOS; do printf '%s %s\n' "$r" "$(sha "$r" "$2")" >> "$TMPROOT/shas.$1"; done
}
recalled(){ awk -v r="$2" '$1==r{print $2}' "$TMPROOT/shas.$1" 2>/dev/null; }

# Rebuilt from scratch per scenario. Reproduces TODAY'S REAL STATE exactly: every repo has
# `main` and nothing else, locally and on its origin. dev/test/staging/prod do not exist,
# so every scenario that needs them has to go through the bootstrap path that will be run
# for real, once, on the three live repos.
fresh_ws(){
  case "$WS" in "$TMPROOT"/ws) : ;; *) printf 'fresh_ws: refusing to rm %s\n' "$WS" >&2; exit 2 ;; esac
  rm -rf "$WS"
  mkdir -p "$WS/remotes"
  local r
  for r in $REPOS; do
    git init -q --bare "$WS/remotes/$r.git"
    git init -q -b main "$WS/$r"
    git -C "$WS/$r" config user.email test@example.invalid
    git -C "$WS/$r" config user.name  "promote test"
    git -C "$WS/$r" config commit.gpgsign false
    printf 'v1\n' > "$WS/$r/file.txt"
  done
  # Every file a module might read is written BEFORE the initial commit. Written after, the
  # fixture's own repos would be untracked-dirty and the clean gate would (correctly) refuse
  # every scenario — including the ones asserting it should proceed.
  mkdir -p "$WS/cheaper-app/cli"
  printf '{"name":"cheaper","version":"0.4.2"}\n' > "$WS/cheaper-app/cli/package.json"
  printf 'console.log("cli");\n' > "$WS/cheaper-app/cli/index.js"
  printf 'web\n' > "$WS/cheaper-web/index.html"
  # The file: dependency is load-bearing for release-worktree.sh's sibling check: it is the
  # thing that must resolve INSIDE the worktree set rather than escaping to a main checkout.
  printf '{\n  "name": "cheaper-desktop",\n  "version": "0.4.2",\n  "dependencies": { "cheaper": "file:../cheaper-app/cli" }\n}\n' > "$WS/cheaper-desktop/package.json"
  for r in $REPOS; do
    git -C "$WS/$r" add -A
    git -C "$WS/$r" commit -q -m "init $r"
    git -C "$WS/$r" remote add origin "$WS/remotes/$r.git"
    git -C "$WS/$r" push -q -u origin main
  done
}

commit_on_dev(){   # $1 message — the work a release is supposed to carry
  local r
  for r in $REPOS; do
    git -C "$WS/$r" switch -q dev
    printf '%s\n' "$1" > "$WS/$r/file.txt"
    git -C "$WS/$r" add -A
    git -C "$WS/$r" commit -q -m "$1"
    git -C "$WS/$r" push -q origin dev
  done
}

commit_on_prod_pushed(){   # $1 repo  $2 content — a hotfix that went out through prod
  git -C "$WS/$1" switch -q prod
  printf '%s\n' "$2" > "$WS/$1/file.txt"
  git -C "$WS/$1" commit -qam "hotfix straight onto prod"
  git -C "$WS/$1" push -q origin prod
  git -C "$WS/$1" switch -q dev
}

commit_on_prod_local(){    # $1 repo  $2 content — committed, deliberately NOT pushed
  git -C "$WS/$1" switch -q prod
  printf '%s\n' "$2" > "$WS/$1/file.txt"
  git -C "$WS/$1" commit -qam "local-only prod commit"
  git -C "$WS/$1" switch -q dev
}

push_divergent_prod(){     # $1 repo  $2 content — someone else pushed prod meanwhile
  local c="$TMPROOT/pusher"
  rm -rf "$c"
  git clone -q "$WS/remotes/$1.git" "$c"
  git -C "$c" config user.email test@example.invalid
  git -C "$c" config user.name  "someone else"
  git -C "$c" switch -q prod
  printf '%s\n' "$2" > "$c/file.txt"
  git -C "$c" commit -qam "a teammate pushed straight to prod"
  git -C "$c" push -q origin prod
  rm -rf "$c"
}

# ---- the one-process stage runner -------------------------------------------------
write_driver(){
  cat > "$DRIVE" <<'DRIVER_EOF'
#!/usr/bin/env bash
# Sources both modules and runs ONE named program in ONE process.
#
# One process matters: promote.sh latches PROMOTE_ABORTED and every entry point refuses
# while it is 1. Running each stage in its own shell would silently reset that latch and
# the suite would be testing a promotion engine nobody will ever run.
#
# set -u only, never set -e: this file exists to observe REFUSALS, and errexit would kill
# the run at the first non-zero rc — including the ones that are the expected answer.
set -u
PROMOTE_MOD="$1"; RW_MOD="$2"; WS="$3"; PROG="$4"; shift 4

# A driver that ran against the real workspace would create branches in the live repos.
# The name is checked rather than assumed, and a mismatch exits 90 (a code no module uses)
# so it cannot be mistaken for a module refusal.
case "$WS" in
  *cheaper-promote-test.*) : ;;
  *) printf 'drive.sh: REFUSING — %s is not a test workspace\n' "$WS" >&2; exit 90 ;;
esac

PROMOTE_WORKSPACE="$WS"
RW_WORKSPACE_ROOT="$WS"
. "$PROMOTE_MOD"
. "$RW_MOD"

# The stage sequences, written the way cheaper-deploy.sh will wire them: every stage's rc
# is checked, and the first refusal stops the track.
run_track(){            # $1 date  $2 version
  promote_preflight      || return 1
  promote_to test        || return 1
  promote_to staging     || return 1
  promote_backup "$1"    || return 1
  promote_to prod        || return 1
  promote_release "$2"   || return 1
  promote_finish         || return 1
  return 0
}
run_upto_prod(){        # $1 date
  promote_preflight      || return 1
  promote_to test        || return 1
  promote_to staging     || return 1
  promote_backup "$1"    || return 1
  promote_to prod        || return 1
  return 0
}
run_upto_prod_nobackup(){
  promote_preflight      || return 1
  promote_to test        || return 1
  promote_to staging     || return 1
  promote_to prod        || return 1
  return 0
}

rc=0
case "$PROG" in
  preflight)            promote_preflight; rc=$? ;;
  bootstrap-noflag)     promote_bootstrap; rc=$? ;;
  bootstrap)            PROMOTE_ALLOW_BOOTSTRAP=true; promote_bootstrap; rc=$? ;;
  to)                   promote_to "${1:-}"; rc=$? ;;
  backup)               promote_backup "${1:-}"; rc=$? ;;
  release)              promote_release "${1:-}"; rc=$? ;;
  finish)               promote_finish; rc=$? ;;
  where)                promote_where; rc=$? ;;
  track)                run_track "${1:-}" "${2:-}"; rc=$? ;;
  upto-prod)            run_upto_prod "${1:-}"; rc=$? ;;
  upto-prod-nobackup)   run_upto_prod_nobackup; rc=$? ;;
  # The deploy-from-ref half. rw_paths is included so the run proves the three paths are
  # emitted on stdout for the deploy steps to consume.
  wt-create)            rw_create "${1:-}" "${2:-}" && rw_verify "${2:-}" "${1:-}" && rw_paths "${2:-}"; rc=$? ;;
  wt-remove)            rw_remove "${1:-}"; rc=$? ;;
  # One full release, end to end, including the worktree cycle in its real position:
  # after the release ref is cut and before main/dev are closed out.
  track-with-deploy)    run_track "${1:-}" "${2:-}" \
                          && rw_create "release-v${2:-}" "${3:-}" \
                          && rw_verify "${3:-}" "release-v${2:-}" \
                          && rw_remove "${3:-}"; rc=$? ;;
  *) printf 'drive.sh: unknown program %s\n' "$PROG" >&2; rc=91 ;;
esac
exit "$rc"
DRIVER_EOF
  chmod +x "$DRIVE"
}

DOUT=""; DRC=0
drive(){   # $@ = program + args. Sets DOUT (combined output) and DRC.
  DOUT="$(bash "$DRIVE" "$PROMOTE_MODULE" "$RW_MODULE" "$WS" "$@" 2>&1)"; DRC=$?
  return 0
}

# Same, with a git that records its argv first. Used by scenario 9 to assert behaviourally
# — not by reading the source — that no destructive verb was ever invoked.
drive_logged(){
  : > "$GITLOG"
  DOUT="$( PATH="$BINDIR:$PATH" GITLOG="$GITLOG" bash "$DRIVE" "$PROMOTE_MODULE" "$RW_MODULE" "$WS" "$@" 2>&1 )"; DRC=$?
  return 0
}

write_git_logger(){
  local realgit; realgit="$(command -v git)"
  [ -n "$realgit" ] || { printf 'test-promote: no git on PATH\n' >&2; exit 2; }
  cat > "$BINDIR/git" <<GITSHIM
#!/usr/bin/env bash
# Records every git invocation the modules make, then runs the real git unchanged.
# A source grep cannot do this job: promote.sh's own refusal messages contain the words
# "clean" and "stash", so a textual scan reports false positives on the very strings that
# promise the destruction will not happen. This records what was actually RUN.
printf '%s\n' "\$*" >> "\${GITLOG:-/dev/null}"
exec "$realgit" "\$@"
GITSHIM
  chmod +x "$BINDIR/git"
}

# ---- mutation machinery -----------------------------------------------------------
_mut_check(){   # $1 src  $2 mutant  $3 label
  if cmp -s "$1" "$2"; then
    printf '  FAIL  mutant construction changed nothing: %s\n' "$3"; FAIL=$((FAIL+1)); return 1
  fi
  if ! bash -n "$2" 2>/dev/null; then
    printf '  FAIL  mutant does not parse: %s — a module that does not parse prints nothing, and a scenario asserting on output would then "kill" it for the wrong reason\n' "$3"
    FAIL=$((FAIL+1)); return 1
  fi
  return 0
}

# Replace a function body with `return 0`, keeping the file parseable. The original body's
# closing brace is left to close a renamed, never-called twin — without that the file is a
# syntax error and every mutation proof becomes a false pass.
stub_fn(){   # $1 src  $2 dst  $3 function name
  awk -v fn="$3" '
    BEGIN{done=0}
    { if (!done && index($0, fn "(){") == 1) {
        print fn "(){ return 0; }; " fn "__MUTANT_DISABLED(){"; done=1; next } print }
  ' "$1" > "$2"
  _mut_check "$1" "$2" "stub $3"
}

# Literal (non-regex) replacement of the FIRST occurrence of a source fragment.
lit_sub(){   # $1 src  $2 dst  $3 needle  $4 replacement
  awk -v needle="$3" -v repl="$4" '
    BEGIN{done=0}
    { if (!done) { i = index($0, needle)
                   if (i > 0) { $0 = substr($0,1,i-1) repl substr($0, i+length(needle)); done=1 } }
      print }
  ' "$1" > "$2"
  _mut_check "$1" "$2" "replace: $3"
}

# Run a scenario against a broken module and require it to FAIL.
run_mutant(){   # $1 label  $2 scenario fn  $3 promote module  $4 rw module
  local label="$1" fn="$2" pm="$3" rmod="$4"
  local sp="$PROMOTE_MODULE" sr="$RW_MODULE"
  PROMOTE_MODULE="$pm"; RW_MODULE="$rmod"
  MUT=1; MUT_FAILS=0; MUT_FIRST=""
  "$fn" >/dev/null 2>&1
  MUT=0
  PROMOTE_MODULE="$sp"; RW_MODULE="$sr"
  if [ "$MUT_FAILS" -gt 0 ]; then
    printf '  KILL  %s\n' "$label"
    printf '        %s assertion(s) flipped; first: %s\n' "$MUT_FAILS" "$MUT_FIRST"
    PASS=$((PASS+1)); KILLED=$((KILLED+1))
  else
    printf '  SURVIVED  %s\n' "$label"
    printf '        the scenario PASSES against a broken module — it proves nothing. Fix the scenario.\n'
    FAIL=$((FAIL+1)); SURVIVED=$((SURVIVED+1))
  fi
}

# ══════════════════════════════════════════════════════════════════════════════════
# SCENARIOS
# ══════════════════════════════════════════════════════════════════════════════════

# ---- 1. bootstrap -----------------------------------------------------------------
# Today all three repos have only `main`, locally and on origin. This is the path that has
# to work once, under supervision, before any release can use the track at all.
scn_bootstrap(){
  fresh_ws

  # The opt-in is not decoration: bootstrap creates four shared branches in three remotes.
  drive bootstrap-noflag
  ne  "bootstrap without the opt-in flag REFUSES" 0 "$DRC"
  has "and it names the flag that enables it" "--promote-bootstrap" "$DOUT"
  local r b
  for r in $REPOS; do
    eq "$r: refused bootstrap created no 'dev'" "" "$(sha "$r" dev)"
    eq "$r: refused bootstrap created no 'prod'" "" "$(sha "$r" prod)"
  done

  drive bootstrap
  eq "bootstrap (opted in) exits 0" 0 "$DRC"
  for r in $REPOS; do
    for b in dev test staging prod; do
      ne "$r: '$b' now exists locally" "" "$(sha "$r" "$b")"
      eq "$r: '$b' was pushed to origin" "$(sha "$r" "$b")" "$(sha "$r" "origin/$b")"
      eq "$r: '$b' starts at main's commit" "$(sha "$r" main)" "$(sha "$r" "$b")"
    done
  done

  # IDEMPOTENCE, tested where it can actually be wrong. Re-running against branches that
  # still equal main proves nothing — `git branch -f` and `git branch` are indistinguishable
  # there. So production is moved forward first: a re-bootstrap that RESET prod to main
  # would silently discard a hotfix, and that is the failure worth catching.
  for r in $REPOS; do
    git -C "$WS/$r" switch -q prod
    printf 'hotfix\n' > "$WS/$r/hotfix.txt"
    git -C "$WS/$r" add -A
    git -C "$WS/$r" commit -q -m "hotfix that exists only on prod"
    git -C "$WS/$r" push -q origin prod
    git -C "$WS/$r" switch -q main
  done
  record_shas prodhot prod

  drive bootstrap
  eq  "a second bootstrap exits 0 (idempotent, not an error)" 0 "$DRC"
  has "and it says the existing branch was left alone" "left exactly as it is" "$DOUT"
  for r in $REPOS; do
    eq "$r: prod was NOT reset to main by the re-run" "$(recalled prodhot "$r")" "$(sha "$r" prod)"
    eq "$r: origin/prod still carries the hotfix"      "$(recalled prodhot "$r")" "$(sha "$r" origin/prod)"
    yes_cmd "$r: the hotfix commit is still reachable from prod" \
      git -C "$WS/$r" merge-base --is-ancestor "$(recalled prodhot "$r")" prod
  done
}

# ---- 2. happy path ----------------------------------------------------------------
# A commit on dev reaches prod, gets a backup and a release ref, and main/dev close out.
# Asserted on COMMIT SHAs. Asserting on exit codes alone would pass against an engine that
# merged nothing — see mutant M2b, which does exactly that and exits 0.
scn_happy(){
  fresh_ws
  drive bootstrap
  eq "bootstrap for the happy path exits 0" 0 "$DRC"
  record_shas prod0 prod          # the production about to be replaced
  commit_on_dev "release work 0.4.2"
  record_shas devtip dev          # the one commit the whole track is supposed to carry

  drive track 2026-08-10 0.4.2
  eq "the full track exits 0" 0 "$DRC"

  local r b want
  for r in $REPOS; do
    want="$(recalled devtip "$r")"
    for b in test staging prod release-v0.4.2 main dev; do
      eq "$r: '$b' IS the gated dev commit"        "$want" "$(sha "$r" "$b")"
      eq "$r: 'origin/$b' matches it (pushed)"     "$want" "$(sha "$r" "origin/$b")"
    done
    # The backup is a snapshot of the OUTGOING production, not of the new release. Taken
    # after the merge it would be a backup of the thing you would be recovering from.
    eq "$r: backup-2026-08-10 is the OUTGOING prod" "$(recalled prod0 "$r")" "$(sha "$r" backup-2026-08-10)"
    ne "$r: the backup is NOT the new release"      "$want" "$(sha "$r" backup-2026-08-10)"
    eq "$r: the backup was pushed" "$(sha "$r" backup-2026-08-10)" "$(sha "$r" origin/backup-2026-08-10)"
    yes_cmd "$r: the backup is an ancestor of the new prod" \
      git -C "$WS/$r" merge-base --is-ancestor backup-2026-08-10 prod
    eq "$r: the run ends on 'dev', where the next cycle starts" "dev" "$(branch_of "$r")"
  done
  has "the release ref is named for the deploy to run from" "release-v0.4.2" "$DOUT"

  # Cutting the same version twice must be refused, never suffixed: release-v0.4.2 is an
  # identity (an npm version is immutable), unlike a backup stamp which is just a date.
  drive release 0.4.2
  ne  "re-cutting release-v0.4.2 is REFUSED" 0 "$DRC"
  has "and it says the ref already exists" "ALREADY EXISTS" "$DOUT"
  for r in $REPOS; do
    eq "$r: no release-v0.4.2-2 was invented" "" "$(sha "$r" release-v0.4.2-2)"
  done
}

# ---- 3. deploy from the release ref -----------------------------------------------
scn_deploy_from_ref(){
  fresh_ws
  drive bootstrap
  commit_on_dev "release work 0.4.2"
  drive track 2026-08-10 0.4.2
  eq "the track that produces the release ref exits 0" 0 "$DRC"

  case "$WTDEST" in "$TMPROOT"/relwt) rm -rf "$WTDEST" ;; *) exit 2 ;; esac
  drive wt-create release-v0.4.2 "$WTDEST"
  eq "rw_create + rw_verify + rw_paths exit 0" 0 "$DRC"

  local r
  for r in $REPOS; do
    eq "$r: worktree HEAD IS release-v0.4.2" "$(sha "$r" release-v0.4.2)" \
       "$(git -C "$WTDEST/$r" rev-parse HEAD 2>/dev/null)"
    # Detached is a requirement, not a detail: a branch checked out here could be advanced
    # by anything running in the directory, and HEAD would stop being pinned to the ref.
    no_cmd "$r: worktree HEAD is DETACHED (no branch to advance)" \
      git -C "$WTDEST/$r" symbolic-ref -q HEAD
    has "$r: rw_paths emitted its path for the deploy steps" "$WTDEST/$r" "$DOUT"
  done

  # The sibling layout, resolved the way npm resolves it: from INSIDE cheaper-desktop.
  # Asserting `-d "$WTDEST/cheaper-app/cli"` would pass on a layout where the `file:` spec
  # still escapes upward to a main checkout.
  yes_cmd "sibling layout: ../cheaper-app/cli resolves from cheaper-desktop" \
    test -f "$WTDEST/cheaper-desktop/../cheaper-app/cli/package.json"
  eq "and it resolves to the RELEASE ref's CLI, not a working tree" \
     '{"name":"cheaper","version":"0.4.2"}' \
     "$(cat "$WTDEST/cheaper-desktop/../cheaper-app/cli/package.json" 2>/dev/null)"

  # No build ran, so nothing could have been uploaded: rw_build_desktop is the only path in
  # either module that shells out to npm, and this suite never calls it.
  no_cmd "no dist/ exists — no build ran and nothing could be published" \
    test -d "$WTDEST/cheaper-desktop/dist"

  # The main checkouts must be untouched by the whole worktree cycle. This is the property
  # that makes deploy-from-ref safe at all: `worktree add --detach` moves no branch.
  for r in $REPOS; do
    eq "$r: main checkout still on 'dev' while the worktree exists" "dev" "$(branch_of "$r")"
  done

  drive wt-remove "$WTDEST"
  eq "rw_remove exits 0" 0 "$DRC"
  for r in $REPOS; do
    no_cmd "$r: the worktree directory is GONE" test -d "$WTDEST/$r"
    eq "$r: 'git worktree list' is back to just the main checkout" "1" \
       "$(git -C "$WS/$r" worktree list 2>/dev/null | grep -c .)"
  done
  no_cmd "the whole destination directory is gone" test -d "$WTDEST"
}

# ---- 4. dirty tree is refused, and the work survives -------------------------------
# THE regression test for the two real incidents. Both destroyed files that had never been
# committed, so there was no reflog to recover from and `git status` afterwards was clean.
# Asserting only that the command exited non-zero would pass against a module that refused
# AFTER deleting the file, so the CONTENT is compared byte for byte.
scn_dirty(){
  fresh_ws
  drive bootstrap
  commit_on_dev "release work"

  local secret="$WS/cheaper-web/UNCOMMITTED-NOTES.txt"
  printf 'line one\nthis text exists in exactly one place on earth\nline three\n' > "$secret"
  local before; before="$(cat "$secret")"
  record_shas t0 test

  drive to test
  ne  "an UNTRACKED file refuses the hop"          0 "$DRC"
  has "and it says the tree is dirty"              "working tree is DIRTY" "$DOUT"
  has "and it names the offending path"            "UNCOMMITTED-NOTES.txt" "$DOUT"
  has "and it promises not to clean or stash it"   "will NOT clean, stash or discard" "$DOUT"
  yes_cmd "the untracked file still EXISTS"        test -f "$secret"
  eq  "and its CONTENT is byte-identical"          "$before" "$(cat "$secret" 2>/dev/null)"

  local r
  for r in $REPOS; do
    eq "$r: still on 'dev' — no repo was hopped"   "dev" "$(branch_of "$r")"
    eq "$r: 'test' did not move"                   "$(recalled t0 "$r")" "$(sha "$r" test)"
  done

  drive preflight
  ne  "pre-flight refuses the same workspace"      0 "$DRC"
  has "for the same, named reason"                 "working tree is DIRTY" "$DOUT"

  # A MODIFIED TRACKED file is refused too — and it also survives.
  rm -f "$secret"
  printf 'edited but never committed\n' > "$WS/cheaper-web/file.txt"
  drive to test
  ne "a modified tracked file refuses the hop"     0 "$DRC"
  eq "and the edit is still there afterwards"      "edited but never committed" \
     "$(cat "$WS/cheaper-web/file.txt" 2>/dev/null)"
}

# ---- 5. a conflicting merge aborts -------------------------------------------------
# prod carries a hotfix that staging does not, and both touch the same line. The merge
# cannot fast-forward, --no-ff conflicts, and the engine must abort rather than leave
# conflict markers on prod — the branch this stack deploys from.
scn_conflict(){
  fresh_ws
  drive bootstrap
  commit_on_dev "release work"
  commit_on_prod_pushed cheaper-app "hotfix that only prod has"
  record_shas prodbefore prod
  record_shas webprod prod

  drive upto-prod 2026-08-10
  ne  "the run FAILS at the conflicting stage"     0 "$DRC"
  has "and it says the merge conflicted"           "CONFLICTED" "$DOUT"
  has "and that the tree was restored"             "aborted, the tree is restored" "$DOUT"
  has "and that nothing was pushed"                "NOTHING was pushed" "$DOUT"
  has "and the whole run is declared ABORTED"      "ABORTED" "$DOUT"

  no_cmd "cheaper-app: no merge is left in progress" \
    git -C "$WS/cheaper-app" rev-parse --verify --quiet MERGE_HEAD
  eq "cheaper-app: the working tree is clean again" "" \
    "$(git -C "$WS/cheaper-app" status --porcelain 2>/dev/null)"
  eq "cheaper-app: restored to 'staging', the branch the stage began on" "staging" "$(branch_of cheaper-app)"
  # No promotion branch may carry conflict markers: they are a syntax error in every file
  # they touch, and prod is the branch this stack deploys from.
  local r
  for r in $REPOS; do
    eq "$r: file.txt carries NO conflict markers" "0" "$(marker_count "$WS/$r/file.txt")"
  done

  # The repos after the failing one must never have been touched.
  eq "cheaper-web: never hopped to prod"           "staging" "$(branch_of cheaper-web)"
  eq "cheaper-web: its prod sha is unchanged"      "$(recalled webprod cheaper-web)" "$(sha cheaper-web prod)"
  eq "cheaper-desktop: never hopped to prod"       "staging" "$(branch_of cheaper-desktop)"
  # Production itself is untouched: the conflict happened before anything reached origin.
  eq "cheaper-app: origin/prod is still the hotfix" "$(recalled prodbefore cheaper-app)" "$(sha cheaper-app origin/prod)"
}

# ---- 6. a mid-track failure names where every repo is standing ---------------------
# cheaper-desktop's local prod and origin/prod have diverged, which is only discovered at
# the prod stage — i.e. after cheaper-app and cheaper-web have already been promoted. The
# engine may not leave the workspace straddling branches silently: that is the state that
# made the original losses invisible.
scn_midtrack_named(){
  fresh_ws
  drive bootstrap
  commit_on_dev "release work"
  commit_on_prod_local  cheaper-desktop "local prod, never pushed"
  push_divergent_prod   cheaper-desktop "someone else's prod"

  drive upto-prod-nobackup
  ne  "the run FAILS partway through the track"    0 "$DRC"
  has "and names the cause"                        "DIVERGED" "$DOUT"
  has "and declares the run ABORTED"               "ABORTED" "$DOUT"

  # The verdict must say, by name, where each repo is standing — including the ones that
  # already moved. "It stopped somewhere" is the failure mode this reporting exists to kill.
  has "the report names cheaper-app's branch"      "cheaper-app: on 'prod' at" "$DOUT"
  has "the report names cheaper-web's branch"      "cheaper-web: on 'prod' at" "$DOUT"
  has "the report names cheaper-desktop's branch"  "cheaper-desktop: on 'staging' at" "$DOUT"
  hasnt "and no repo is reported detached"         "DETACHED HEAD" "$DOUT"
  hasnt "and no repo's branch is unreadable"       "branch UNREADABLE" "$DOUT"

  local r
  for r in $REPOS; do
    yes_cmd "$r: HEAD really is a NAMED branch, not detached" \
      git -C "$WS/$r" symbolic-ref -q HEAD
  done
  eq "cheaper-app really is on prod"       "prod"    "$(branch_of cheaper-app)"
  eq "cheaper-web really is on prod"       "prod"    "$(branch_of cheaper-web)"
  eq "cheaper-desktop was restored to the branch its stage began on" "staging" "$(branch_of cheaper-desktop)"
}

# ---- 7. backup collision ------------------------------------------------------------
# Two releases on one day. The morning's rollback point must survive the afternoon's.
scn_backup_collision(){
  fresh_ws
  drive bootstrap
  record_shas p0 prod

  drive backup 2026-08-10
  eq "the first backup exits 0" 0 "$DRC"

  # Production moves on between the two releases, so an overwriting implementation is
  # visible: without this the two backups would point at the same commit and an overwrite
  # would be undetectable.
  local r
  for r in $REPOS; do
    git -C "$WS/$r" switch -q prod
    printf 'the afternoon release\n' > "$WS/$r/file.txt"
    git -C "$WS/$r" commit -qam "second release of the day"
    git -C "$WS/$r" push -q origin prod
    git -C "$WS/$r" switch -q main
  done
  record_shas p1 prod

  drive backup 2026-08-10
  eq  "the second backup on the same date exits 0" 0 "$DRC"
  has "and it says the plain name was taken"       "is already taken" "$DOUT"
  has "and it names the suffixed branch it used"   "backup-2026-08-10-2" "$DOUT"

  for r in $REPOS; do
    eq "$r: backup-2026-08-10 still points at the MORNING prod" \
       "$(recalled p0 "$r")" "$(sha "$r" backup-2026-08-10)"
    eq "$r: backup-2026-08-10-2 points at the AFTERNOON prod" \
       "$(recalled p1 "$r")" "$(sha "$r" backup-2026-08-10-2)"
    eq "$r: the suffixed backup was pushed" \
       "$(sha "$r" backup-2026-08-10-2)" "$(sha "$r" origin/backup-2026-08-10-2)"
    ne "$r: the two backups are different commits" \
       "$(sha "$r" backup-2026-08-10)" "$(sha "$r" backup-2026-08-10-2)"
  done

  # A rollback set whose members have three different names is not a set. A collision in
  # ONE repo must force the same suffix in all three.
  fresh_ws
  drive bootstrap
  git -C "$WS/cheaper-web" branch backup-2026-08-10 prod
  drive backup 2026-08-10
  eq "a collision in one repo alone still exits 0" 0 "$DRC"
  for r in $REPOS; do
    ne "$r: got the SUFFIXED name too" "" "$(sha "$r" backup-2026-08-10-2)"
  done
  eq "cheaper-app did not quietly take the plain name" "" "$(sha cheaper-app backup-2026-08-10)"
}

# ---- 8. partial failure: repo 2 dirty means repo 1 is never hopped ------------------
scn_partial(){
  fresh_ws
  drive bootstrap
  commit_on_dev "release work"
  printf 'brand new, never committed\n' > "$WS/cheaper-web/BRAND-NEW.txt"
  record_shas t0 test

  drive to test
  ne  "the stage is refused"                                  0 "$DRC"
  has "and it says so BEFORE any branch changed"              "REFUSED before any branch was changed" "$DOUT"
  hasnt "and no repo reports a completed promotion"           "now contains" "$DOUT"

  eq "cheaper-app (repo 1) was NEVER hopped"                  "dev" "$(branch_of cheaper-app)"
  eq "cheaper-app: its 'test' branch did not move"            "$(recalled t0 cheaper-app)" "$(sha cheaper-app test)"
  eq "cheaper-app: origin/test did not move"                  "$(recalled t0 cheaper-app)" "$(sha cheaper-app origin/test)"
  eq "cheaper-desktop (repo 3) was never hopped either"       "dev" "$(branch_of cheaper-desktop)"
  yes_cmd "the untracked file in repo 2 still exists"         test -f "$WS/cheaper-web/BRAND-NEW.txt"
}

# ---- 9. no destructive git verb is ever invoked -------------------------------------
# Behavioural, not textual. A source grep would report false positives on promote.sh's own
# refusal messages ("will NOT clean, stash or discard them"), so this records the argv of
# every git call made during a complete release — bootstrap, full track, worktree cycle —
# and asserts the forbidden verbs never appear.
scn_no_destructive_verbs(){
  fresh_ws
  drive bootstrap
  commit_on_dev "release work"
  case "$WTDEST" in "$TMPROOT"/relwt) rm -rf "$WTDEST" ;; *) exit 2 ;; esac

  drive_logged track-with-deploy 2026-08-10 0.4.2 "$WTDEST"
  eq "a complete release (track + worktree deploy + cleanup) exits 0" 0 "$DRC"
  ne "the git argv log is not empty (the shim really was used)" "0" "$(grep -c . "$GITLOG" 2>/dev/null || printf '0')"

  local v
  for v in "clean" "stash" "--force" "-f " "branch -D" "reset --hard" "--amend" "rebase" "--discard-changes" "checkout -f"; do
    eq "no git invocation contained: $v" "" \
       "$(grep -F -e "$v" "$GITLOG" 2>/dev/null | head -n 3)"
  done
  # The worktree set was created and removed inside that one run.
  no_cmd "the release worktrees were cleaned up by the run itself" test -d "$WTDEST"
  local r
  for r in $REPOS; do
    eq "$r: no worktree left registered" "1" "$(git -C "$WS/$r" worktree list 2>/dev/null | grep -c .)"
  done
}

# ---- final audit: the REAL repos ----------------------------------------------------
# Read-only, and deliberately narrow. It does not compare HEAD shas, because a concurrent
# agent committing in this workspace would make that flake and a flaky safety check gets
# ignored. It asserts the two things only THIS suite could have caused.
audit_real_repos(){
  local real; real="$(cd "$T/../.." 2>/dev/null && pwd -P)"
  local r
  for r in $REPOS; do
    if [ ! -e "$real/$r/.git" ]; then
      _record 0 "REAL $r: not present at $real — nothing to audit" ""
      continue
    fi
    eq "REAL $r: still exactly one worktree (its own checkout)" "1" \
       "$(git -C "$real/$r" worktree list 2>/dev/null | grep -c .)"
    eq "REAL $r: no promotion branch was created" "" \
       "$(git -C "$real/$r" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null \
          | grep -E '^(dev|test|staging|prod|backup-|release-v)' | tr '\n' ' ')"
  done
}

# ══════════════════════════════════════════════════════════════════════════════════
# RUN
# ══════════════════════════════════════════════════════════════════════════════════
write_driver
write_git_logger

sum_of(){ shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }
PROMOTE_SUM_BEFORE="$(sum_of "$PROMOTE_SRC")"
RW_SUM_BEFORE="$(sum_of "$RW_SRC")"

printf 'promotion track e2e — synthetic repos under %s\n' "$TMPROOT"

sec "1. bootstrap: three repos that have ONLY main gain dev/test/staging/prod, idempotently"
scn_bootstrap

sec "2. happy path: a dev commit reaches prod, is backed up, released, and closes out into main and dev"
scn_happy

sec "3. deploy from the release ref: worktrees at release-v0.4.2, sibling layout, then removed"
scn_deploy_from_ref

sec "4. a dirty tree is REFUSED and the uncommitted work survives byte for byte"
scn_dirty

sec "5. a conflicting merge aborts, restores the starting branch, and stops the run"
scn_conflict

sec "6. a mid-track failure leaves every repo on a NAMED branch and says which"
scn_midtrack_named

sec "7. two releases on one day: backup-<date> and backup-<date>-2, never an overwrite"
scn_backup_collision

sec "8. repo 2 dirty means repo 1 is NEVER hopped"
scn_partial

sec "9. no destructive git verb is invoked during a complete release"
scn_no_destructive_verbs

# ── MUTATION PROOFS ────────────────────────────────────────────────────────────────
# Each entry: break exactly one guard, re-run the scenario that claims to cover it, and
# require the scenario to fail. The originals are never touched — these are copies.
printf '\n=== mutation proofs: every scenario above must FAIL against a broken module ===\n'

# M1 — bootstrap recreates existing branches with -f, i.e. resets prod to main.
if lit_sub "$PROMOTE_SRC" "$MUTDIR/m1.sh" \
   '1) out="$(git -C "$dir" branch "$stage" "$PROMOTE_MAIN_BRANCH" 2>&1)"; rc=$?' \
   '0|1) out="$(git -C "$dir" branch -f "$stage" "$PROMOTE_MAIN_BRANCH" 2>&1)"; rc=$?'; then
  run_mutant "M1 bootstrap uses 'git branch -f' (a re-run would discard the hotfix on prod)" \
             scn_bootstrap "$MUTDIR/m1.sh" "$RW_SRC"
fi

# M2 — the merge becomes a silent no-op. The verification must catch it BEFORE the push.
if stub_fn "$PROMOTE_SRC" "$MUTDIR/m2.sh" "_pr_merge"; then
  run_mutant "M2 _pr_merge does nothing (merge-base --is-ancestor must refuse the push)" \
             scn_happy "$MUTDIR/m2.sh" "$RW_SRC"
fi

# M2b — merge AND verification both gutted, so the track "succeeds" having merged nothing.
# This is what proves the happy path asserts on SHAs rather than on exit codes: M2 could
# have been killed by any refusal, M2b exits 0 and is killed only by the sha comparison.
if stub_fn "$PROMOTE_SRC" "$MUTDIR/m2b.tmp" "_pr_merge" \
   && stub_fn "$MUTDIR/m2b.tmp" "$MUTDIR/m2b.sh" "_pr_verify_ancestor"; then
  run_mutant "M2b merge AND verification gutted (only a sha comparison can see this)" \
             scn_happy "$MUTDIR/m2b.sh" "$RW_SRC"
fi

# M3a — rw_remove reports success without removing anything.
if stub_fn "$RW_SRC" "$MUTDIR/m3a.sh" "rw__remove"; then
  run_mutant "M3a rw_remove is a no-op that returns 0 (stale worktrees left behind)" \
             scn_deploy_from_ref "$PROMOTE_SRC" "$MUTDIR/m3a.sh"
fi

# M3b — the worktree is created one commit BEFORE the release ref: the deploy would ship
# the wrong tree while every log line named the right one.
if lit_sub "$RW_SRC" "$MUTDIR/m3b.sh" \
   'worktree add --detach "$dest/$repo" "$sha"' \
   'worktree add --detach "$dest/$repo" "$sha~1"'; then
  run_mutant "M3b worktrees materialise at the WRONG commit" \
             scn_deploy_from_ref "$PROMOTE_SRC" "$MUTDIR/m3b.sh"
fi

# M4 — the historical incident, reconstructed: the clean gate is removed AND the switch
# path runs `git clean -fd`, exactly as merge-deploy.sh/fast-deploy.sh did. Both halves are
# needed: the pre-pass would refuse before the switch was ever reached.
if stub_fn "$PROMOTE_SRC" "$MUTDIR/m4.tmp" "_pr_require_clean" \
   && lit_sub "$MUTDIR/m4.tmp" "$MUTDIR/m4.sh" \
      '_pr_require_clean "$dir" "$name" || return 1' \
      'git -C "$dir" clean -fd >/dev/null 2>&1 || true'; then
  run_mutant "M4 the clean gate is gone and the hop runs 'git clean -fd' (the 2026-08-09 incident)" \
             scn_dirty "$MUTDIR/m4.sh" "$RW_SRC"
  # The same mutant must also be visible to the argv log — that is what proves scenario 9
  # is watching what git actually ran rather than counting on nobody adding a verb.
  run_mutant "M4' the same mutant is caught by the git argv log" \
             scn_no_destructive_verbs "$MUTDIR/m4.sh" "$RW_SRC"
fi

# M5 — the conflict is left in the tree instead of being aborted.
if lit_sub "$PROMOTE_SRC" "$MUTDIR/m5.sh" \
   'aout="$(git -C "$dir" merge --abort 2>&1)"; arc=$?' \
   'aout=""; arc=0'; then
  run_mutant "M5 'git merge --abort' is skipped (conflict markers survive on a promotion branch)" \
             scn_conflict "$MUTDIR/m5.sh" "$RW_SRC"
fi

# M6 — the failure reports nothing about where the repos are standing.
if stub_fn "$PROMOTE_SRC" "$MUTDIR/m6.sh" "promote_where"; then
  run_mutant "M6 promote_where prints nothing (a run that stopped 'somewhere')" \
             scn_midtrack_named "$MUTDIR/m6.sh" "$RW_SRC"
fi

# M7 — the free-name search is short-circuited and the backup branch is force-moved, so
# the second release of the day overwrites the morning's rollback point.
if lit_sub "$PROMOTE_SRC" "$MUTDIR/m7.tmp" \
   '[ "$free" -eq 1 ] && break' 'break' \
   && lit_sub "$MUTDIR/m7.tmp" "$MUTDIR/m7.sh" \
      'out="$(git -C "$dir" branch "$candidate" prod 2>&1)"; rc=$?' \
      'out="$(git -C "$dir" branch -f "$candidate" prod 2>&1)"; rc=$?'; then
  run_mutant "M7 the backup name is reused and force-moved (the morning's rollback point is lost)" \
             scn_backup_collision "$MUTDIR/m7.sh" "$RW_SRC"
fi

# M8 — the clean gate alone. Repo 1 is hopped before repo 2 is found dirty.
if stub_fn "$PROMOTE_SRC" "$MUTDIR/m8.sh" "_pr_require_clean"; then
  run_mutant "M8 the all-repos-first pre-pass is defeated (repo 1 hops before repo 2 is checked)" \
             scn_partial "$MUTDIR/m8.sh" "$RW_SRC"
fi

# ── the modules must be byte-identical to how they started ─────────────────────────
printf '\n=== the modules under test were never modified ===\n'
eq "promote.sh is byte-identical (sha256)"          "$PROMOTE_SUM_BEFORE" "$(sum_of "$PROMOTE_SRC")"
eq "release-worktree.sh is byte-identical (sha256)" "$RW_SUM_BEFORE"      "$(sum_of "$RW_SRC")"

printf '\n=== the real repos were never touched ===\n'
audit_real_repos

printf '\n──────────────────────────────────────────\n'
printf 'promotion track: %s passed, %s failed  (mutants: %s killed, %s survived)\n' \
  "$PASS" "$FAIL" "$KILLED" "$SURVIVED"
[ "$FAIL" -eq 0 ]
