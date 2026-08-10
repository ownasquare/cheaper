#!/usr/bin/env bash
# release-worktree.sh — SOURCE ME. Deploy from a REF, not from whatever is on disk.
#
#   source "$(dirname "$0")/release-worktree.sh"
#
#   rw_create <ref> <destdir>    detached worktrees of all three repos at <ref>
#   rw_verify <destdir> <ref>    prove each worktree's HEAD is EXACTLY <ref>
#   rw_build_desktop <destdir>   npm install + npm run dist:mac INSIDE the worktree
#   rw_paths  <destdir>          the three paths, one per line, for the deploy steps
#   rw_remove <destdir>          remove all three and prune. Idempotent. NEVER --force.
#
# ─────────────────────────────────────────────────────────────────────────────────────
# WHY THIS FILE EXISTS
#
# cheaper-deploy.sh ships the WORKING TREE. `wrangler deploy` publishes cheaper-web/web
# as it sits on disk; the desktop step uploads whatever files are in cheaper-desktop/dist;
# `npm publish` packs cli/ from disk. The branch promotion track
# (dev → test → staging → backup-… → prod → release-v<version>) gates COMMITS. Bolting a
# commit gate onto a working-tree deploy produces a release process whose every line of
# output is true and whose central claim is false: the gate approves commit X while the
# uploader ships the bytes under the cursor.
#
# A worktree closes that gap, and it is the ONLY mechanism here that closes it without
# touching the main checkout. `git worktree add --detach` writes a NEW directory at a
# commit. It does not switch the main checkout's branch, does not move any branch ref,
# does not touch the index, and does not care whether the main tree is dirty. That last
# property is the point: this workspace has lost uncommitted work TWICE to deploy scripts
# that hopped branches and cleaned the tree. A deploy that reads from a worktree never has
# a reason to hop, so it never has a reason to clean.
#
# ─────────────────────────────────────────────────────────────────────────────────────
# THE SIBLING LAYOUT IS LOAD-BEARING. IT IS NOT A PREFERENCE.
#
# cheaper-desktop/package.json declares:
#
#     "dependencies": { "cheaper": "file:../cheaper-app/cli" }
#
# npm resolves that path RELATIVE TO cheaper-desktop, which means it resolves OUTSIDE
# cheaper-desktop's own repository. The three worktrees must therefore be laid out as
# siblings, under their REAL directory names:
#
#     <destdir>/cheaper-app          <-- ../cheaper-app/cli must land here
#     <destdir>/cheaper-web
#     <destdir>/cheaper-desktop
#
# This is not hypothetical. Getting it wrong is the exact bug that left cheaper-desktop's
# release matrix unable to install its dependencies on every runner until both repos were
# checked out as siblings. And in THIS context the wrong layout has a second, quieter
# failure that is worse: if the sibling is missing from <destdir>, `../cheaper-app/cli`
# does not fail — it escapes <destdir> and may resolve to the MAIN CHECKOUT, so the build
# silently bundles the CLI from the working tree while every log line says "built from
# <ref>". rw_create therefore requires each `file:` dependency to resolve to a path that
# BOTH exists AND lives inside <destdir>, and refuses otherwise. A refusal here costs one
# re-run; the escape costs a release that lied.
#
# ─────────────────────────────────────────────────────────────────────────────────────
# THE dist PROBLEM — say it plainly.
#
# Of the four deploy targets, three are fully tracked and therefore check out honestly
# from any ref:
#
#     cheaper-web/web                22 files, tracked
#     cheaper-app/cli               107 files, tracked
#     cheaper-app/cli/assets/gateway 26 files, tracked
#
# The fourth is not. cheaper-desktop/.gitignore contains `dist/`, so the macOS installers
# EXIST IN NO REF and cannot be checked out at any commit. A worktree of the release ref
# contains no dist/ at all.
#
# So: AN INSTALLER UPLOADED FROM THE MAIN CHECKOUT'S dist/ DIRECTORY CARRIES NO PROOF
# THAT IT CAME FROM THE RELEASE REF. cheaper-deploy.sh's version guard reads the VERSION
# OUT OF THE FILENAME. A filename is a string that electron-builder wrote at some point in
# the past, from some tree, in some state. `Cheaper-0.4.1-arm64.dmg` built from a dirty
# tree, or from a branch that was later abandoned, passes that guard perfectly. The guard
# is worth keeping — it catches stale artifacts — but it is a check on a NAME, and a name
# is not provenance.
#
# The only way "what shipped came from the gated commit" becomes a true statement about
# the installers is to BUILD THEM INSIDE THE WORKTREE. That is rw_build_desktop: npm
# install and npm run dist:mac in <destdir>/cheaper-desktop, whose every tracked input is
# the release ref by construction, and whose `file:` CLI dependency resolves to the
# release ref's cheaper-app because the siblings are checked out together.
#
# ─────────────────────────────────────────────────────────────────────────────────────
# WORKTREE LIFECYCLE IS MANDATORY: create → use → remove, in the same run, always.
#
# A worktree left on disk is the stale-worktree hazard the workspace rules forbid: its
# commits are invisible from the main checkout, two agents in two worktrees editing one
# file is a conflict discovered days later, and anything living only there is one `rm -rf`
# from gone. rw_remove is idempotent and safe to call twice, so the caller's failure path
# can call it without checking whether the success path already did:
#
#     dest="$(mktemp -d)/rel"
#     trap 'rc=$?; rw_remove "$dest" || true; exit $rc' EXIT   # save $? FIRST — do not
#                                                              # let cleanup's status
#                                                              # overwrite the real error
#     rw_create "$ref" "$dest" || exit 1
#     rw_verify "$dest" "$ref" || exit 1
#
# rw_remove NEVER passes --force, and never will. `git worktree remove` refuses a worktree
# holding modified or untracked files, and that refusal is the last thing standing between
# an unsaved edit and oblivion. When it refuses, rw_remove says so loudly, names the path
# and what is holding it, and returns non-zero — a reported blocker, never a silent
# leftover and never a forced delete.
#
# ─────────────────────────────────────────────────────────────────────────────────────
# WHAT THIS FILE WILL NEVER DO
#
#   no `git clean`      no `git stash`       no forced checkout/switch
#   no force push       no `branch -D`       no `worktree remove --force`
#   no rebase           no amend             no `reset --hard`
#
# And one rule that outranks all of them: EVERY git call captures its exit status, and a
# git command that FAILED is reported as a failure — never as "nothing to do". "Could not
# determine" must never render as "fine". That confusion is the single most common defect
# already fixed in cheaper-deploy.sh, and it is exactly how a check that cannot see
# anything reports that there is nothing there.
# ─────────────────────────────────────────────────────────────────────────────────────

# Sourcing this file twice must be harmless — the orchestrator may source it from more
# than one place, and a second definition pass that re-ran side effects would be a
# surprise. Definitions are idempotent; this guard only skips the redundant work.
if [ -n "${RW_SOURCED:-}" ]; then
  return 0 2>/dev/null || true
fi
RW_SOURCED=1

# ---- configuration ---------------------------------------------------------------
#
# The repo list is FIXED and ordered app → web → desktop. Order matters for creation:
# cheaper-desktop's `file:` dependency points at cheaper-app, so cheaper-app exists before
# anything looks for it. It is a plain space-separated string rather than an array so this
# file runs unchanged on macOS's /bin/bash 3.2.
RW_REPOS="cheaper-app cheaper-web cheaper-desktop"

# The directory that holds all three repos as siblings. Derived from THIS file's location
# (<root>/cheaper-app/scripts/release-worktree.sh) rather than from $PWD, because a
# sourced module has no idea what directory the caller was standing in. Overridable so the
# test suite can run against synthetic repos and never the real ones.
if [ -z "${RW_WORKSPACE_ROOT:-}" ]; then
  RW_WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd -P)"
fi

# Tool overrides. Named, not hardcoded, so a test can inject a stub npm and prove the
# build path's ERROR handling without a twenty-minute electron-builder run.
RW_GIT="${RW_GIT:-git}"
RW_NPM="${RW_NPM:-npm}"
RW_NODE="${RW_NODE:-node}"

# Which package script builds the installers. dist:mac is the release target; exposed
# because the same worktree machinery is what a linux/windows lane would want.
RW_DESKTOP_BUILD_SCRIPT="${RW_DESKTOP_BUILD_SCRIPT:-dist:mac}"

# A self-describing marker dropped in <destdir> (NOT inside any worktree, so it cannot
# dirty one). Its job is the day someone finds a leftover directory and has to work out
# what it is: it names the ref, the resolved commits and the workspace it came from.
RW_STAMP_NAME=".cheaper-release-worktree"

# Set by rw_paths / rw_build_desktop for callers that prefer variables to parsing stdout.
RW_PATH_APP=""; RW_PATH_WEB=""; RW_PATH_DESKTOP=""
RW_DESKTOP_VERSION=""; RW_DESKTOP_DIST=""

# ---- output ----------------------------------------------------------------------
# rw_-prefixed on purpose. cheaper-deploy.sh already defines say/ok/warn/err, and a
# library that redefines its host's printers changes the host's output for every OTHER
# caller too. Diagnostics go to stderr so `paths="$(rw_paths "$d")"` captures paths and
# nothing else.
rw__say(){  printf '  %s\n'                 "$*" >&2; }
rw__ok(){   printf '  \033[32m✓\033[0m %s\n' "$*" >&2; }
rw__warn(){ printf '  \033[33m! %s\033[0m\n' "$*" >&2; }
rw__bad(){  printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; }

# ---- small helpers ---------------------------------------------------------------

# Lexical path normalisation — no realpath, no readlink -f (neither is portable to a
# stock macOS), and no `cd` (the path may not exist yet, which is precisely the case we
# need to answer questions about).
rw__normalize(){
  local p="${1:-}" out="" seg
  case "$p" in /*) : ;; *) p="$PWD/$p" ;; esac
  local IFS='/'
  # shellcheck disable=SC2206
  local parts=( $p )
  local i=0 n=${#parts[@]}
  while [ "$i" -lt "$n" ]; do
    seg="${parts[$i]}"
    i=$((i+1))
    case "$seg" in
      ''|.)  continue ;;
      ..)    out="${out%/*}" ;;
      *)     out="$out/$seg" ;;
    esac
  done
  printf '%s' "${out:-/}"
}

rw__repo_dir(){ printf '%s/%s' "$RW_WORKSPACE_ROOT" "${1:?repo}"; }

# Physical path of an EXISTING directory, symlinks resolved. Needed because git reports
# resolved paths while a caller may hand us a symlinked one — on macOS /tmp is a symlink to
# /private/tmp and /var to /private/var, so a purely lexical comparison of "does this
# worktree belong to this repo" answers NO for two spellings of the same directory. Falls
# back to the lexical form when the directory does not exist, so callers still get a usable
# string to put in an error message.
rw__realdir(){
  local p="${1:-}" out
  out="$( cd "$p" 2>/dev/null && pwd -P )"
  if [ -n "$out" ]; then printf '%s' "$out"; else rw__normalize "$p"; fi
}

# Resolve a ref to a commit sha inside a repo. Distinguishes "the ref does not exist"
# (git exits 1) from "the repository could not be read" (git exits 128) because those send
# the operator to two completely different places, and collapsing them into one message is
# how a broken checkout gets diagnosed as a typo.
rw__resolve_ref(){   # $1 repo-dir  $2 ref  -> prints sha, or nothing + rc
  local dir="${1:?}" ref="${2:?}" out rc
  out="$("$RW_GIT" -C "$dir" rev-parse --verify "${ref}^{commit}" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    RW_LAST_GIT_ERR="$out"
    return "$rc"
  fi
  printf '%s' "$out"
  return 0
}

# The absolute path of the repository a worktree belongs to — i.e. the directory holding
# the shared .git. This is what proves <destdir>/cheaper-web is a worktree of cheaper-web
# and not something someone else parked at that path.
rw__common_repo_of(){   # $1 worktree-dir -> prints repo root, or nothing + rc
  local wt="${1:?}" cd_out rc
  cd_out="$( cd "$wt" 2>/dev/null && "$RW_GIT" rev-parse --git-common-dir 2>/dev/null )"; rc=$?
  [ "$rc" -ne 0 ] && return "$rc"
  [ -z "$cd_out" ] && return 1
  case "$cd_out" in /*) : ;; *) cd_out="$wt/$cd_out" ;; esac
  cd_out="$(rw__normalize "$cd_out")"
  # <repo>/.git  ->  <repo>. A bare or unusual layout would not match; that is a refusal,
  # not a guess.
  case "$cd_out" in
    */.git) printf '%s' "$(rw__realdir "${cd_out%/.git}")"; return 0 ;;
    *)      RW_LAST_GIT_ERR="unexpected git-common-dir: $cd_out"; return 1 ;;
  esac
}

# Read the top-level "version" out of a package.json. node is authoritative (it is a JSON
# parser); the sed fallback exists so a missing node degrades to a weaker read rather than
# to a wrong one — and an unreadable version is an ERROR at every call site, never a blank
# that flows onward as if it were a version.
rw__pkg_version(){   # $1 package.json path
  local pj="${1:?}" v rc
  [ -f "$pj" ] || return 1
  if command -v "$RW_NODE" >/dev/null 2>&1; then
    v="$("$RW_NODE" -e 'const v=require(process.argv[1]).version; if(!v){process.exit(3)} process.stdout.write(String(v))' "$pj" 2>/dev/null)"; rc=$?
    if [ "$rc" -eq 0 ] && [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
    return 1
  fi
  v="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pj" 2>/dev/null | head -n 1)"
  [ -n "$v" ] || return 1
  printf '%s' "$v"
}

# ---- errexit shim ----------------------------------------------------------------
# The orchestrator may or may not run under `set -e`. Under it, `x="$(git …)"; rc=$?`
# never reaches the `rc=$?` line — the shell exits on the assignment and every carefully
# captured status in this file becomes unreachable. Each public entry point therefore
# disables errexit for its own duration and restores the caller's setting on the way out,
# so this module's error handling behaves identically under both.
rw__call(){   # $1 internal fn, rest args
  local fn="${1:?}"; shift
  local had_e=0
  case "$-" in *e*) had_e=1 ;; esac
  set +e
  "$fn" "$@"
  local rc=$?
  [ "$had_e" -eq 1 ] && set -e
  return "$rc"
}

# ---- rw_create -------------------------------------------------------------------

rw__preflight_repo(){   # $1 repo  $2 ref  $3 destdir -> 0 usable, 1 not (reasons printed)
  local repo="$1" ref="$2" dest="$3"
  local dir; dir="$(rw__repo_dir "$repo")"
  local target="$dest/$repo"

  # -e, not -d: inside a linked worktree or a submodule, .git is a FILE.
  if [ ! -e "$dir/.git" ]; then
    rw__bad "$repo: $dir is not a git repository — there is no history here to check out"
    return 1
  fi

  local sha
  sha="$(rw__resolve_ref "$dir" "$ref")"
  local rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$sha" ]; then
    if [ "$rc" -eq 128 ]; then
      rw__bad "$repo: git could not read the repository (git exit 128) while resolving '$ref'"
    else
      rw__bad "$repo: ref '$ref' does not exist (git exit $rc) — the promotion track has not reached this repo, or the name is wrong"
    fi
    [ -n "${RW_LAST_GIT_ERR:-}" ] && rw__say "    git said: $RW_LAST_GIT_ERR"
    return 1
  fi

  # A pre-existing target is never adopted. It might be a leftover worktree from an
  # aborted run at a DIFFERENT ref, and a deploy that silently reuses it ships that ref.
  if [ -e "$target" ]; then
    rw__bad "$repo: $target already exists — refusing to reuse or overwrite it"
    rw__say "    if it is a leftover worktree, remove it first: $RW_GIT -C $dir worktree remove $target"
    return 1
  fi

  # git itself will reject a second worktree at a registered path, but its message is
  # about administrative state; this one tells the operator what actually happened.
  local wtlist wt_rc
  wtlist="$("$RW_GIT" -C "$dir" worktree list --porcelain 2>&1)"; wt_rc=$?
  if [ "$wt_rc" -ne 0 ]; then
    rw__bad "$repo: 'git worktree list' FAILED (git exit $wt_rc) — cannot tell what worktrees exist, and 'cannot tell' is not 'none'"
    rw__say "    git said: $wtlist"
    return 1
  fi
  if printf '%s\n' "$wtlist" | grep -q -x -F "worktree $target"; then
    rw__bad "$repo: a worktree is already registered at $target"
    return 1
  fi

  rw__say "$repo: '$ref' is $(printf '%s' "$sha" | cut -c1-12)"
  return 0
}

# Every `file:` dependency in the desktop package.json must resolve INSIDE <destdir>.
# Existence alone is not enough — see the sibling-layout note in the header: a wrong layout
# lets `../cheaper-app/cli` escape upward and land on the MAIN CHECKOUT, which exists, and
# which would then be bundled into an installer labelled with the release ref.
rw__check_siblings(){   # $1 destdir -> 0 ok, 1 refuse
  local dest="$1"
  local desk="$dest/cheaper-desktop"
  local pj="$desk/package.json"

  if [ ! -f "$pj" ]; then
    rw__bad "sibling check: $pj is missing — cannot tell what this build would resolve its dependencies to"
    return 1
  fi

  local specs rc
  specs="$(grep -o '"file:[^"]*"' "$pj" 2>/dev/null | sed -e 's/^"file://' -e 's/"$//')"
  rc=$?
  # grep exits 1 on "no matches", which is legitimate (a package.json may have no file:
  # deps) and 2 on a real error. Only 2 is a failure; treating 1 as one would refuse a
  # perfectly good repo, and treating 2 as "none" would skip the check that matters.
  if [ "$rc" -gt 1 ]; then
    rw__bad "sibling check: could not read $pj (grep exit $rc)"
    return 1
  fi
  if [ -z "$specs" ]; then
    rw__warn "sibling check: cheaper-desktop declares no file: dependencies — expected 'cheaper': 'file:../cheaper-app/cli'"
    rw__warn "  the sibling layout may no longer be load-bearing, or package.json changed shape. Verify before trusting this build."
    return 0
  fi

  local bad=0 spec resolved
  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    resolved="$(rw__normalize "$desk/$spec")"
    if [ ! -e "$resolved" ]; then
      rw__bad "sibling check: 'file:$spec' resolves to $resolved, which DOES NOT EXIST"
      rw__say "    npm would fail here, on every runner, after the deploy had already started."
      bad=1
      continue
    fi
    case "$resolved" in
      "$dest"/*)
        rw__ok "sibling check: file:$spec -> $resolved"
        ;;
      *)
        # The dangerous one. It exists, so npm succeeds, so nothing complains — and the
        # bytes came from outside the release ref.
        rw__bad "sibling check: 'file:$spec' ESCAPES the worktree set — it resolves to $resolved, which is outside $dest"
        rw__say "    that path is not part of this release ref. npm would install it happily and the installer would carry code no gate ever saw."
        bad=1
        ;;
    esac
  done <<EOF
$specs
EOF

  [ "$bad" -eq 0 ] && return 0
  return 1
}

rw__create(){   # $1 ref  $2 destdir
  local ref="${1:-}" dest="${2:-}"
  if [ -z "$ref" ] || [ -z "$dest" ]; then
    rw__bad "rw_create: usage: rw_create <ref> <destdir>"
    return 2
  fi
  dest="$(rw__normalize "$dest")"

  if ! command -v "$RW_GIT" >/dev/null 2>&1; then
    rw__bad "rw_create: '$RW_GIT' not found on PATH"
    return 1
  fi

  # A worktree parked INSIDE one of the repos would appear as an untracked directory in
  # that repo's main checkout — exactly the shape of thing the branch-hopping deploy
  # automation in this workspace has already deleted twice.
  local repo dir dir_real
  for repo in $RW_REPOS; do
    dir="$(rw__repo_dir "$repo")"
    dir_real="$(rw__realdir "$dir")"
    case "$dest/" in
      "$dir"/*|"$dir_real"/*)
        rw__bad "rw_create: <destdir> $dest is INSIDE $dir — a worktree there shows up as untracked work in the main checkout and is exactly what the tree-cleaning automation deletes"
        return 1
        ;;
    esac
  done

  printf '\n' >&2
  rw__say "release worktrees: ref '$ref' -> $dest"
  rw__say "workspace: $RW_WORKSPACE_ROOT"

  # PHASE 1 — check ALL THREE before creating ANY. Same rule as the deploy pre-flight, for
  # the same reason: discovering repo 2 is unusable after repo 1 has been materialised
  # leaves a half-built set, and a half-built set is what the cleanup path then has to
  # reason about. Refusing before the first `worktree add` means there is nothing to undo.
  local blocked=0
  for repo in $RW_REPOS; do
    rw__preflight_repo "$repo" "$ref" "$dest" || blocked=1
  done
  if [ "$blocked" -ne 0 ]; then
    rw__bad "rw_create: refusing — one or more repos cannot provide '$ref'. Nothing was created."
    return 1
  fi

  if ! mkdir -p "$dest" 2>/dev/null; then
    rw__bad "rw_create: could not create $dest"
    return 1
  fi

  # PHASE 2 — materialise. Two deliberate choices:
  #   --detach, so no branch is ever checked out and therefore no branch can ever be
  #             MOVED by anything that happens in these directories.
  #   the SHA, not the ref name: between phase 1 and here a branch could advance, and
  #             "we verified X then checked out Y" is precisely the class of gap this
  #             module exists to close.
  local created="" sha rc out
  for repo in $RW_REPOS; do
    dir="$(rw__repo_dir "$repo")"
    sha="$(rw__resolve_ref "$dir" "$ref")"; rc=$?
    if [ "$rc" -ne 0 ] || [ -z "$sha" ]; then
      rw__bad "$repo: '$ref' stopped resolving between the check and the checkout (git exit $rc)"
      rw__create_unwind "$dest" "$created"
      return 1
    fi
    out="$("$RW_GIT" -C "$dir" worktree add --detach "$dest/$repo" "$sha" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then
      rw__bad "$repo: 'git worktree add' FAILED (git exit $rc)"
      rw__say "    git said: $out"
      rw__create_unwind "$dest" "$created"
      return 1
    fi
    created="$created $repo"
    rw__ok "$repo: worktree at $dest/$repo (detached at $(printf '%s' "$sha" | cut -c1-12))"
  done

  # The stamp is for the human who finds this directory later, and for rw_remove when the
  # caller's RW_WORKSPACE_ROOT has changed underneath it. It lives in <destdir>, never
  # inside a worktree — a file inside one would make it dirty, and a dirty worktree is one
  # that rw_remove is required to refuse to remove.
  {
    printf 'ref=%s\n' "$ref"
    printf 'workspace_root=%s\n' "$RW_WORKSPACE_ROOT"
    printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
    for repo in $RW_REPOS; do
      printf 'repo=%s sha=%s\n' "$repo" "$(rw__resolve_ref "$(rw__repo_dir "$repo")" "$ref" 2>/dev/null)"
    done
  } > "$dest/$RW_STAMP_NAME" 2>/dev/null || rw__warn "rw_create: could not write $dest/$RW_STAMP_NAME (the worktrees are fine; a leftover would just be less self-describing)"

  # PHASE 3 — prove it, rather than trusting that `worktree add` did what it said.
  if ! rw__verify "$dest" "$ref"; then
    rw__bad "rw_create: the worktrees were created but do NOT verify as '$ref' — removing them rather than handing back something unproven"
    rw__create_unwind "$dest" "$created"
    return 1
  fi

  # PHASE 4 — the layout claim, checked against reality rather than assumed from the
  # directory names this function just used.
  if ! rw__check_siblings "$dest"; then
    rw__bad "rw_create: the sibling layout does not hold — refusing now, rather than letting npm discover it mid-deploy"
    rw__create_unwind "$dest" "$created"
    return 1
  fi

  return 0
}

# Undo a partially-created set. Delegates to rw_remove so there is exactly ONE removal
# path in this file, with exactly one set of safety rules, and so the unwind can never
# acquire a --force that the normal path does not have. Its own failure is reported and
# never masks the creation failure that sent us here.
rw__create_unwind(){   # $1 destdir  $2 space-separated repos created so far
  local dest="$1" created="$2"
  [ -z "$created" ] && { rw__say "rw_create: nothing had been created yet — nothing to undo"; return 0; }
  rw__say "rw_create: undoing the partial worktree set ($created )"
  if ! rw__remove "$dest"; then
    rw__bad "rw_create: the partial set could NOT be fully removed. This is a blocker, not a warning — see the paths above and resolve them before the next run."
  fi
  return 0
}

# ---- rw_verify -------------------------------------------------------------------

rw__verify(){   # $1 destdir  $2 ref
  local dest="${1:-}" ref="${2:-}"
  if [ -z "$dest" ] || [ -z "$ref" ]; then
    rw__bad "rw_verify: usage: rw_verify <destdir> <ref>"
    return 2
  fi
  dest="$(rw__normalize "$dest")"

  local repo dir wt want got rc bad=0 sym
  for repo in $RW_REPOS; do
    dir="$(rw__repo_dir "$repo")"
    wt="$dest/$repo"

    if [ ! -d "$wt" ]; then
      rw__bad "$repo: no worktree at $wt"
      bad=1; continue
    fi

    # Is this a worktree of the repo we think it is? Without this, a path collision or a
    # hand-made directory verifies against the wrong history.
    local owner
    owner="$(rw__common_repo_of "$wt")"; rc=$?
    if [ "$rc" -ne 0 ] || [ -z "$owner" ]; then
      rw__bad "$repo: $wt is not a usable git worktree (git exit $rc) — cannot establish what it is checked out to"
      [ -n "${RW_LAST_GIT_ERR:-}" ] && rw__say "    detail: $RW_LAST_GIT_ERR"
      bad=1; continue
    fi
    if [ "$owner" != "$(rw__realdir "$dir")" ]; then
      rw__bad "$repo: $wt belongs to $owner, not $dir — this is somebody else's checkout"
      bad=1; continue
    fi

    # Detached is a requirement, not a detail. A branch checked out here could be advanced
    # by anything running in this directory, and then HEAD is no longer pinned to the ref
    # that was gated.
    sym="$("$RW_GIT" -C "$wt" symbolic-ref -q HEAD 2>/dev/null)"; rc=$?
    if [ "$rc" -eq 0 ] && [ -n "$sym" ]; then
      rw__bad "$repo: $wt has branch '$sym' checked out, not a detached HEAD — its content is not pinned to '$ref'"
      bad=1; continue
    fi

    want="$(rw__resolve_ref "$dir" "$ref")"; rc=$?
    if [ "$rc" -ne 0 ] || [ -z "$want" ]; then
      rw__bad "$repo: cannot resolve '$ref' in $dir (git exit $rc) — 'could not determine' is not 'matches'"
      [ -n "${RW_LAST_GIT_ERR:-}" ] && rw__say "    git said: $RW_LAST_GIT_ERR"
      bad=1; continue
    fi

    got="$("$RW_GIT" -C "$wt" rev-parse --verify HEAD 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] || [ -z "$got" ]; then
      rw__bad "$repo: cannot read HEAD of $wt (git exit $rc)"
      rw__say "    git said: $got"
      bad=1; continue
    fi

    if [ "$got" != "$want" ]; then
      rw__bad "$repo: worktree HEAD is $(printf '%s' "$got" | cut -c1-12), but '$ref' is $(printf '%s' "$want" | cut -c1-12) — this worktree would deploy the WRONG commit"
      bad=1; continue
    fi

    rw__ok "$repo: $wt is exactly '$ref' ($(printf '%s' "$want" | cut -c1-12), detached)"
  done

  [ "$bad" -eq 0 ] && return 0
  rw__bad "rw_verify: the worktree set does NOT prove out as '$ref'"
  return 1
}

# ---- rw_paths --------------------------------------------------------------------

rw__paths(){   # $1 destdir  -> three absolute paths on stdout, app/web/desktop order
  local dest="${1:-}"
  if [ -z "$dest" ]; then
    rw__bad "rw_paths: usage: rw_paths <destdir>"
    return 2
  fi
  dest="$(rw__normalize "$dest")"

  # Missing paths are a refusal, not an omission. A caller doing
  # `read a b c < <(rw_paths "$d")` on a short list would silently point a deploy step at
  # an empty string, and an empty string is the current directory.
  local repo missing=""
  for repo in $RW_REPOS; do
    [ -d "$dest/$repo" ] || missing="$missing $repo"
  done
  if [ -n "$missing" ]; then
    rw__bad "rw_paths: missing worktree(s) under $dest:$missing"
    return 1
  fi

  RW_PATH_APP="$dest/cheaper-app"
  RW_PATH_WEB="$dest/cheaper-web"
  RW_PATH_DESKTOP="$dest/cheaper-desktop"
  printf '%s\n%s\n%s\n' "$RW_PATH_APP" "$RW_PATH_WEB" "$RW_PATH_DESKTOP"
  return 0
}

# ---- rw_build_desktop ------------------------------------------------------------

rw__build_desktop(){   # $1 destdir
  local dest="${1:-}"
  if [ -z "$dest" ]; then
    rw__bad "rw_build_desktop: usage: rw_build_desktop <destdir>"
    return 2
  fi
  dest="$(rw__normalize "$dest")"
  local desk="$dest/cheaper-desktop"

  if [ ! -d "$desk" ]; then
    rw__bad "rw_build_desktop: no worktree at $desk — run rw_create first"
    return 1
  fi

  # Re-checked here, not assumed from rw_create. This function is separately callable, and
  # the whole value of building in the worktree evaporates if the CLI it links against came
  # from somewhere else.
  if ! rw__check_siblings "$dest"; then
    rw__bad "rw_build_desktop: refusing to build — the CLI dependency does not resolve inside $dest, so the installer would not be built from the release ref"
    return 1
  fi

  if ! command -v "$RW_NPM" >/dev/null 2>&1; then
    rw__bad "rw_build_desktop: '$RW_NPM' not found on PATH"
    return 1
  fi

  # The version is read BEFORE the build, from the worktree's own package.json — i.e. from
  # the release ref — so the number reported here is a property of the gated commit and not
  # of whatever electron-builder happened to name a file.
  local version
  version="$(rw__pkg_version "$desk/package.json")"
  if [ -z "$version" ]; then
    rw__bad "rw_build_desktop: could not read the version from $desk/package.json — refusing to build something this run cannot name"
    return 1
  fi

  # `npm install`, not `npm ci`. ci deletes node_modules and installs strictly from the
  # lockfile; with a `file:` dependency pointed at a sibling worktree that is the tighter
  # choice in principle, but ci ABORTS on any lockfile/package.json disagreement, and a
  # release build is the worst possible moment to discover one. install resolves the same
  # sibling and tolerates the drift.
  # npm's own chatter goes to STDERR, not stdout. This function's stdout is its ANSWER (the
  # version), so `v="$(rw_build_desktop "$d")"` must not come back as a version with a few
  # hundred lines of install log welded to the front of it. The log is not suppressed —
  # only redirected — because a build log is exactly what an operator needs when this fails.
  rw__say "cheaper-desktop: npm install (in the worktree, so every input is '$version' from the release ref)"
  local rc
  ( cd "$desk" && "$RW_NPM" install ) >&2 ; rc=$?
  if [ "$rc" -ne 0 ]; then
    rw__bad "rw_build_desktop: npm install FAILED (exit $rc) in $desk"
    return 1
  fi

  rw__say "cheaper-desktop: npm run $RW_DESKTOP_BUILD_SCRIPT"
  ( cd "$desk" && "$RW_NPM" run "$RW_DESKTOP_BUILD_SCRIPT" ) >&2 ; rc=$?
  if [ "$rc" -ne 0 ]; then
    rw__bad "rw_build_desktop: 'npm run $RW_DESKTOP_BUILD_SCRIPT' FAILED (exit $rc) in $desk"
    return 1
  fi

  # A build that exits 0 having produced nothing is the exact shape of the bug that had a
  # publish job reporting success with nothing published. Exit status is a claim; the
  # directory listing is the evidence.
  local dist="$desk/dist"
  if [ ! -d "$dist" ]; then
    rw__bad "rw_build_desktop: '$RW_DESKTOP_BUILD_SCRIPT' exited 0 but $dist does not exist — a build that produced nothing is a FAILED build, not a quiet one"
    return 1
  fi
  local produced
  produced="$(ls -1 "$dist" 2>/dev/null)"
  if [ -z "$produced" ]; then
    rw__bad "rw_build_desktop: '$RW_DESKTOP_BUILD_SCRIPT' exited 0 but $dist is EMPTY"
    return 1
  fi

  # dist/ is gitignored, so it cannot have been checked out — anything here was built in
  # the last few minutes. Matching the filenames against the ref's own version is still
  # worth doing: it is the same string cheaper-deploy.sh's version guard will read, and if
  # they disagree the upload would be refused later, after the reversible steps had run.
  local matched=0 f
  while IFS= read -r f; do
    case "$f" in *"$version"*) matched=1 ;; esac
  done <<EOF
$produced
EOF
  if [ "$matched" -eq 0 ]; then
    rw__bad "rw_build_desktop: nothing in $dist carries version '$version' — the build and the release ref disagree about what this is"
    printf '%s\n' "$produced" | sed 's/^/        /' >&2
    return 1
  fi

  RW_DESKTOP_VERSION="$version"
  RW_DESKTOP_DIST="$dist"
  rw__ok "cheaper-desktop: built $version in the worktree — these installers ARE the release ref, not a filename that resembles it"
  printf '%s\n' "$produced" | sed 's/^/        /' >&2
  rw__say "    dist: $dist"

  # stdout is the answer, so `v="$(rw_build_desktop "$d")"` works.
  printf '%s\n' "$version"
  return 0
}

# ---- rw_remove -------------------------------------------------------------------

rw__remove(){   # $1 destdir
  local dest="${1:-}"
  if [ -z "$dest" ]; then
    rw__bad "rw_remove: usage: rw_remove <destdir>"
    return 2
  fi
  dest="$(rw__normalize "$dest")"

  # Idempotent by design: the caller's failure trap and its success path both call this,
  # and neither should have to know whether the other already ran.
  if [ ! -d "$dest" ]; then
    return 0
  fi

  # If the stamp names a workspace, prefer it. The worktree administrative data lives in
  # the repo that CREATED the worktree; removing it from anywhere else is not possible, so
  # a caller whose RW_WORKSPACE_ROOT has since changed must still be able to clean up.
  # Refusing here would leave the stale worktree the rules forbid.
  local root="$RW_WORKSPACE_ROOT" stamp_root=""
  if [ -f "$dest/$RW_STAMP_NAME" ]; then
    stamp_root="$(sed -n 's/^workspace_root=//p' "$dest/$RW_STAMP_NAME" 2>/dev/null | head -n 1)"
    if [ -n "$stamp_root" ] && [ "$stamp_root" != "$root" ]; then
      rw__warn "rw_remove: $dest was created from $stamp_root, not $root — using the recorded workspace, because that is the only repo that can remove these worktrees"
      root="$stamp_root"
    fi
  fi

  local repo dir wt rc out failed=0
  for repo in $RW_REPOS; do
    dir="$root/$repo"
    wt="$dest/$repo"

    # Prune first, unconditionally: it deletes only ADMIN entries whose directory is
    # already gone. It never touches files, and it is what makes a second call clean up
    # after a first call that removed directories some other way.
    if [ -e "$dir/.git" ]; then
      out="$("$RW_GIT" -C "$dir" worktree prune 2>&1)"; rc=$?
      if [ "$rc" -ne 0 ]; then
        rw__warn "$repo: 'git worktree prune' failed (git exit $rc): $out"
      fi
    fi

    [ -d "$wt" ] || continue

    if [ ! -e "$dir/.git" ]; then
      rw__bad "$repo: worktree $wt exists but its repository $dir does not — it cannot be removed safely from here"
      rw__say "    LEFT ON DISK. Resolve manually; do not delete the directory blind, its content may be the only copy of something."
      failed=1
      continue
    fi

    # NO --force. EVER. git refuses a worktree holding modified or untracked files, and
    # that refusal is the last thing between an unsaved edit and oblivion. This workspace
    # has lost work twice to automation that "handled" this situation.
    out="$("$RW_GIT" -C "$dir" worktree remove "$wt" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then
      rw__bad "$repo: 'git worktree remove' REFUSED (git exit $rc) — $wt is LEFT ON DISK"
      rw__say "    git said: $out"
      local dirty dirty_rc
      dirty="$("$RW_GIT" -C "$wt" status --porcelain 2>&1)"; dirty_rc=$?
      if [ "$dirty_rc" -eq 0 ] && [ -n "$dirty" ]; then
        rw__say "    what is holding it:"
        printf '%s\n' "$dirty" | head -n 10 | sed 's/^/        /' >&2
      elif [ "$dirty_rc" -ne 0 ]; then
        rw__say "    (could not read its status either — git exit $dirty_rc)"
      fi
      rw__say "    THIS IS A BLOCKER, not a warning. Deal with the contents, then:"
      rw__say "      $RW_GIT -C $dir worktree remove $wt"
      rw__say "    Do NOT add --force: it deletes those files, and they exist nowhere else."
      failed=1
      continue
    fi

    # `worktree remove` says it removed the directory; check that it did. A directory that
    # survives is a stale worktree by another name.
    if [ -d "$wt" ]; then
      rw__bad "$repo: git reported success but $wt is still on disk"
      failed=1
      continue
    fi

    out="$("$RW_GIT" -C "$dir" worktree prune 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then
      rw__warn "$repo: post-removal 'git worktree prune' failed (git exit $rc): $out"
    fi
    rw__ok "$repo: worktree removed"
  done
  # The loop deliberately continues past a failure. One repo refusing is not a reason to
  # leave the other two behind — that would turn one blocker into three.

  if [ "$failed" -ne 0 ]; then
    rw__bad "rw_remove: $dest was NOT fully cleaned up. Worktrees remain — see above."
    return 1
  fi

  # Only ever the file this module wrote, by its literal name. Not a glob, not -r.
  [ -f "$dest/$RW_STAMP_NAME" ] && rm -f "$dest/$RW_STAMP_NAME"

  # rmdir, never `rm -rf`: it refuses a non-empty directory, which is exactly the guard
  # wanted. If something unexpected is in there, it stays, and it stays visible.
  if ! rmdir "$dest" 2>/dev/null; then
    rw__say "rw_remove: $dest is not empty — leaving it (it holds something this module did not create)"
  fi
  return 0
}

# ---- integration contract --------------------------------------------------------
#
# Exit codes, uniform across all five: 0 = did the thing, 1 = refused or failed (reasons
# already printed to stderr), 2 = called wrong (bad arguments).
#
# stdout is the ANSWER and nothing else — rw_paths emits three paths, rw_build_desktop
# emits one version, the rest emit nothing. All narration goes to stderr, so a caller can
# capture a value without filtering. Variables are set as a convenience for callers that
# would rather not parse: RW_PATH_APP / RW_PATH_WEB / RW_PATH_DESKTOP (by rw_paths) and
# RW_DESKTOP_VERSION / RW_DESKTOP_DIST (by rw_build_desktop).
#
# The intended shape of a deploy-from-ref run, where <ref> is the release-v<version>
# branch the promotion track produced:
#
#   dest="${TMPDIR:-/tmp}/cheaper-release.$$"
#   trap 'rc=$?; rw_remove "$dest" || true; exit $rc' EXIT INT TERM
#   rw_create "$ref" "$dest"            || exit 1
#   rw_verify "$dest" "$ref"            || exit 1     # belt and braces; rw_create already did
#   rw_build_desktop "$dest"            || exit 1     # the installers, from the ref
#   # then point the existing steps at the worktrees instead of the working tree:
#   #   web     -> wrangler deploy from  $dest/cheaper-web
#   #   cli     -> npm publish from      $dest/cheaper-app/cli
#   #   gateway -> build from            $dest/cheaper-app/cli/assets/gateway
#   #   desktop -> upload from           $RW_DESKTOP_DIST   (built above, not the main tree)
#
# The trap saves $? BEFORE calling rw_remove. Do not simplify that away: without it, a
# successful cleanup returns 0 and the run exits green having failed.
#
# ---- public surface --------------------------------------------------------------
rw_create(){        rw__call rw__create        "$@"; }
rw_verify(){        rw__call rw__verify        "$@"; }
rw_paths(){         rw__call rw__paths         "$@"; }
rw_build_desktop(){ rw__call rw__build_desktop "$@"; }
rw_remove(){        rw__call rw__remove        "$@"; }

# Executed rather than sourced does nothing useful, and says so with a non-zero status —
# an exit 0 here would read as "it ran", which is the same class of false green this file
# exists to prevent.
if [ -z "${BASH_SOURCE[0]:-}" ] || [ "${BASH_SOURCE[0]}" = "$0" ]; then
  printf 'release-worktree.sh is a library: source it, do not run it.\n' >&2
  printf '  source %s\n' "${BASH_SOURCE[0]:-release-worktree.sh}" >&2
  printf '  rw_create <ref> <destdir> / rw_verify <destdir> <ref> / rw_build_desktop <destdir> / rw_paths <destdir> / rw_remove <destdir>\n' >&2
  exit 2
fi
