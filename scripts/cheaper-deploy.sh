#!/usr/bin/env bash
# cheaper-deploy.sh — one command to ship the whole Cheaper stack.
#
#   ./cheaper-deploy.sh                 # all steps, in order
#   ./cheaper-deploy.sh web             # only the website
#   ./cheaper-deploy.sh cli web docker  # a subset (any order of the names below)
#   ./cheaper-deploy.sh --help
#
# Steps (run in this order):  git → [PRE-FLIGHT] → cli → web → desktop → docker
#   git      commit & push cheaper-app / cheaper-desktop / cheaper-web (asks per repo).
#            This is what pushes the updated README.md to GitHub. It reports a repo
#            "clean & in sync" ONLY when `git status` and `git log @{u}..HEAD` both
#            actually SUCCEEDED and the branch has an upstream to compare against — a
#            git failure (corrupt index, unreadable repo) and a branch with no upstream
#            are errors, not silence. A push that transferred nothing says "already
#            up-to-date", not "pushed".
#   cli      publish `cheaper` to npm. SKIPS automatically if the version already exists
#            on npm (so we never redeploy an unchanged CLI); otherwise ASKS first.
#            Uses npm web auth — a browser window opens for you to approve (no --otp).
#            MUST RUN IN A REAL TERMINAL: npm only offers that browser approval when
#            stdin AND stdout are TTYs, so piping or redirecting this script's stdio
#            (`… | tee`, `>log`, `printf y | …`) makes the publish fail EOTP. The step
#            now detects that up front and says so instead of failing cryptically.
#            It never publishes until it has established who you are, and it only blames
#            your ~/.npmrc token when npm's own error actually says so (ENEEDAUTH/E401/
#            401). When it does, it no longer just prints the fix: it OFFERS to run
#            `npm login --auth-type=web` for you (a real terminal is required — see the
#            TTY note above — and the offer is a confirm() prompt, scope `login`). It runs
#            login ONCE, never in a loop, then re-asks `npm whoami` and publishes only if
#            npm exits 0 AND names a user; a login that fails, or "succeeds" while whoami
#            still fails or names nobody, is an error and the run exits 1. No token,
#            password or OTP is ever handled by this script — the browser flow keeps the
#            secret between you and npm. A whoami that fails for any OTHER reason (DNS,
#            proxy, registry outage) is reported as an unexplained QUERY failure with
#            npm's real error text, is never blamed on the token, and is never offered a
#            login — re-authenticating cannot fix a network outage.
#   web      `wrangler deploy` of cheaper-web  ->  cheaper.app / www.cheaper.app.
#   desktop  upload the built installers in cheaper-desktop/dist  ->  R2 (dl.cheaper.app).
#            Refuses (does not upload) any installer whose filename version doesn't
#            match cheaper-desktop/package.json — see VERSION GUARD below.
#   docker   build the gateway image, `docker save` a tarball, upload it -> R2.
#            Refuses to build or upload anything if cli/package.json's version can't be
#            read — it never invents a placeholder version, because the upload would
#            overwrite cheaper-gateway-latest.tar.gz, the key every self-hoster pulls.
#
# Requires: node, npm, git, and CLOUDFLARE_API_TOKEN in your environment (wrangler/R2).
# The docker step needs a running Docker daemon (it skips gracefully if absent).
#
# RELEASE-READINESS PRE-FLIGHT (runs after `git`, before anything is published):
#   This script deploys the WORKING TREE (web is `wrangler deploy` from cheaper-web/;
#   desktop uploads whatever is in dist/) but pushes the CURRENT BRANCH, whatever that
#   is. Nothing used to tie the two together, so they could describe different software
#   and every line of output would still be true. On 2026-08-09 cheaper-app sat on a
#   feature branch six commits and sixteen uncommitted files ahead of a main that had
#   none of it; a deploy would have shipped all of it to cheaper.app and R2, pushed it to
#   the feature branch, and exited 0 with nothing but green.
#   Before cli/web/desktop/docker run, all THREE repos must be:
#     • on the release branch (main) — not a feature branch, not detached;
#     • clean — no uncommitted or untracked work, because deployed bytes that are in no
#       commit are bytes nothing on GitHub describes;
#     • level with origin — neither ahead (would ship unpushed code) nor behind (would
#       publish something OLDER than the team already has).
#   Any git QUERY that fails is a refusal, never a pass: a failed fetch leaves the
#   remote-tracking refs stale, and "I could not look" is not "there is nothing there".
#   All three repos are checked even for a single-step run, because the surfaces are
#   coupled (desktop reads cli/package.json's version; the website advertises both).
#   The `git` step itself is NOT gated — it is the tool that clears these blockages.
#
# PARTIAL RELEASES (desktop step):
#   Every R2 destination is a STABLE key (cheaper-windows-x64.exe is the same object each
#   release), so a platform with no matching installer in dist/ does not get "skipped"
#   harmlessly — its key keeps serving the PREVIOUS version while the other platforms
#   move to the new one, under a website that has already been relabelled. A missing
#   artifact is therefore an ERROR, not a warning, and names the affected keys.
#
# VERSION GUARD (desktop step):
#   Installers are named by electron-builder as Cheaper-${version}-${arch}.${ext} or
#   Cheaper-Setup-${version}.exe, and electron-builder resolves ${version} from
#   cheaper-desktop/package.json (NOT cli/package.json — those two versions are
#   independently maintained). Before touching dist/, the step first asserts once, up
#   front, that cheaper-desktop/package.json and cli/package.json agree on the version;
#   if they don't, it refuses the WHOLE step with a distinct "VERSION DISAGREEMENT"
#   error naming both files (that's a "two repos disagree" problem, separate from a
#   stale build). Only once they agree does it parse ${version} out of each resolved
#   installer filename and compare it to cheaper-desktop/package.json's version. On a
#   per-file mismatch it refuses that single upload, prints both versions and the
#   rebuild command, and keeps going — it never aborts the whole run for a single stale
#   file and never silently ships a stale build. If dist/ holds more than one file
#   matching a given installer's glob, the step prefers whichever one's filename version
#   equals the expected version; only if none match does it fall back to an arbitrary
#   pick, and it says so explicitly (how many matched, which was chosen, and that stale
#   artifacts should be deleted). The step always prints a final summary, and it
#   separates the two things it must not conflate: REFUSED (the artifact is wrong —
#   stale version or unparseable name; fix it by rebuilding) versus FAILED (dist/ could
#   not be read, or the upload itself failed; the artifacts may be perfect, so fix
#   permissions/CLOUDFLARE_API_TOKEN/the network instead — rebuilding changes nothing).
#   Each count is named only when it is non-zero, so the summary never implies dist/ was
#   read when it could not be.
#
# NON-INTERACTIVE CONFIRMATION (--yes):
#   By default every confirm() prompt (git commit/push per repo, npm login, npm publish)
#   is interactive — unchanged from before. To automate a prompt you must explicitly opt
#   in with a SCOPED flag; there is no way to auto-answer everything by feeding stdin.
#     --yes            auto-confirm every prompt in this run.
#     --yes=<scope>     auto-confirm only prompts in that scope. Repeatable.
#   Scopes: app (cheaper-app git commit/push), desktop (cheaper-desktop git commit/push),
#           web (cheaper-web git commit/push), cli (npm publish),
#           login (run `npm login --auth-type=web` when — and only when — npm's own
#                  whoami error carries an auth signature; this writes a NEW token to
#                  ~/.npmrc, so it is a side effect and gets its own scope: `--yes=cli`
#                  automates the publish WITHOUT also automating an auth flow, and
#                  `--yes=login` authorises only the re-authentication, never a publish.
#                  It still needs a real terminal — npm's browser approval refuses
#                  non-TTY stdio — and this script never sees your token/password/OTP).
#   An unknown scope is rejected before anything runs, for the same reason an unknown
#   step name is: `--yes=dektop` used to be accepted, match no prompt, decline everything
#   in CI and still exit 0.
#
# BREAK-GLASS OVERRIDES:
#   --allow-unreleasable       ship even though the pre-flight refused. Prints, on every
#                              run that uses it, that what goes live will not match
#                              origin/main. Never implied by --yes: --yes automates a
#                              question that was going to be asked, this suppresses a
#                              refusal, and conflating them would let --yes in CI
#                              silently publish an unverified tree.
#   --allow-partial-platforms  accept that some installer keys keep their previous
#                              version. Still prints which ones, and what that means for
#                              anyone downloading them.
#   Both exist so that shipping anyway means NAMING what is being overridden, rather than
#   commenting out the check — which is what actually happens to a gate with no exit.
#
#   Examples:
#     ./cheaper-deploy.sh --yes=cli cli            # auto-approve the npm publish only
#     ./cheaper-deploy.sh --yes=web --yes=app git  # auto-approve two of the three repos
#     ./cheaper-deploy.sh --yes=login cli          # auto-approve re-auth, still ask to publish
#     ./cheaper-deploy.sh --yes                    # auto-approve everything (all scopes)
#   Every auto-answered prompt prints which flag answered it — an auto-yes is never
#   silent. If stdin is not a TTY and no --yes covers a given prompt, confirm() FAILS
#   CLOSED (declines) instead of reading a stray line and proceeding.
#
# EXIT CODE:
#   0 only when nothing errored. Any refused upload, failed commit/push/publish/deploy
#   (including a failed cheaper-gateway-latest.tar.gz upload, which would leave
#   dl.cheaper.app serving the previous gateway), unreadable version file, or failed
#   git/filesystem QUERY that would otherwise be mistaken for "nothing to do" makes the
#   whole run exit 1 — the final human summary still prints first. So
#   `./cheaper-deploy.sh desktop && notify-release-shipped` can no longer report a
#   shipped release that was in fact refused.
#   Unknown step names are rejected before anything runs (a typo like `dektop` used to
#   run nothing at all and still exit 0).
set -u

# ---- config ---------------------------------------------------------------
# WORKSPACE is the directory that CONTAINS cheaper-app/, cheaper-web/ and
# cheaper-desktop/ — identified by looking for them, not by assuming this script sits
# beside them. It used to be a bare `dirname "$0"`, which is true only while the script
# lives at the workspace root. The canonical copy is now version-controlled inside
# cheaper-app (the workspace root is not a git repository, so a file kept only there is
# a file with no history and no remote), and the root path is a symlink to it. Under the
# old line, invoking the real path instead of the symlink would have set WORKSPACE to
# cheaper-app/scripts and every repo path below would have silently pointed at nothing.
# Walking up for the three directories is true from either entry point.
_start_dir="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE=""
_probe="$_start_dir"
while :; do
  if [ -d "$_probe/cheaper-app" ] && [ -d "$_probe/cheaper-web" ] && [ -d "$_probe/cheaper-desktop" ]; then
    WORKSPACE="$_probe"; break
  fi
  [ "$_probe" = "/" ] && break
  _probe="$(dirname "$_probe")"
done
if [ -z "$WORKSPACE" ]; then
  printf '  \033[31m✗ cannot locate the Cheaper workspace\033[0m\n' >&2
  printf '  looked upward from %s for a directory containing cheaper-app/, cheaper-web/ and cheaper-desktop/ and found none.\n' "$_start_dir" >&2
  printf '  run this script from inside the workspace (or via the cheaper-deploy.sh symlink at its root).\n' >&2
  exit 1
fi
APP="$WORKSPACE/cheaper-app"; CLI="$APP/cli"; GATEWAY="$APP/gateway"
DESKTOP="$WORKSPACE/cheaper-desktop"
WEB="$WORKSPACE/cheaper-web"
# The branch every repo must be on before anything ships. There is no `dev` branch in
# this workspace and never was; the deploy track is main, established by what this script
# does rather than by anything that used to declare it. See the pre-flight gate below.
RELEASE_BRANCH="main"
R2_BUCKET="cheaper-downloads"
NPM_PKG="cheaper"
# The ownasquare Cloudflare account. Set explicitly: an ambient CLOUDFLARE_ACCOUNT_ID
# may point at a different account and silently target the wrong R2/zone.
export CLOUDFLARE_ACCOUNT_ID="84a701a23afcd1b863bbf7f1b29bafa2"
WRANGLER="npx --yes wrangler@4"

# ---- pretty ---------------------------------------------------------------
# FAILED is the machine-readable counterpart of the human summary. Every err() — a
# refused upload, a failed commit, a failed push, a failed publish/deploy, an unreadable
# package.json — flips it, and the run exits non-zero at the very end (AFTER the human summary is
# printed). Without this, `./cheaper-deploy.sh desktop && notify-release-shipped` fired
# the success path while the script's own text said "dl.cheaper.app was NOT fully
# updated": the prose and the exit code disagreed, and CI believes the exit code.
# warn() deliberately does NOT set it — a warning means "nothing to do / informational"
# (no artifact in dist/, repo already in sync), not "the release is incomplete".
FAILED=0
b(){    printf '\n\033[1m%s\033[0m\n' "$*"; }
say(){  printf '  %s\n' "$*"; }
ok(){   printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m! %s\033[0m\n' "$*"; }
err(){  FAILED=1; printf '  \033[31m✗ %s\033[0m\n' "$*"; }
hr(){   printf '\033[2m%s\033[0m\n' "──────────────────────────────────────────────────────────"; }
have(){ command -v "$1" >/dev/null 2>&1; }
die(){ err "$*"; exit 1; }

# ---- version reading -------------------------------------------------------
# EVERY version guard in this file is a `[ -n "$v" ]` test on the output of
# `node -p "require('…/package.json').version"`. That expression does NOT fail when the
# file is present, parseable, and simply has no "version" key — node prints the literal
# string `undefined`, which is non-empty and sails straight through every such guard.
# Verified: {"name":"cheaper"} yields value=[undefined] rc=0. Downstream that fabricated
# a real release identity out of nothing — step_docker built cheaper-gateway:undefined,
# uploaded cheaper-gateway-undefined.tar.gz and OVERWROTE cheaper-gateway-latest.tar.gz,
# printed two green ticks and exited 0 — and it made step_desktop tell the operator its
# correctly-named installer "is v0.3.0 but cheaper-desktop/package.json is vundefined",
# i.e. rebuild forever, which is precisely the dead end the VERSION DISAGREEMENT check
# was added to avoid. Read every version through here instead: it returns the version
# ONLY when it is a genuine non-empty string, and the empty string for every other
# outcome (missing file, malformed JSON, absent key, non-string key, empty string).
read_version(){  # $1 absolute path to a package.json — prints the version or nothing
  node -p "(()=>{try{const v=require('$1').version;return (typeof v==='string'&&v.length)?v:''}catch(e){return ''}})()" 2>/dev/null
}

# ---- --yes scoping (parsed before step-name args) --------------------------
YES_ALL=false
YES_SCOPES=" "   # space-padded list, e.g. " cli web "
VALID_YES_SCOPES="app desktop web cli login"
yes_scope(){ local s="$1"; [ -n "$s" ] && printf '%s' "$YES_SCOPES" | grep -q " $s "; }

# Break-glass overrides. Both exist so that an operator who needs to ship anyway does it
# by NAMING what they are overriding, rather than by commenting out a check — which is
# what actually happens to a gate with no escape hatch. Neither is ever implied by --yes:
# --yes automates a question that was going to be asked, these suppress a refusal, and
# conflating the two would let `--yes` in CI silently ship an unverified tree.
ALLOW_UNRELEASABLE=false
ALLOW_PARTIAL_PLATFORMS=false

ARGS=()
for a in "$@"; do
  case "$a" in
    --yes)      YES_ALL=true ;;
    --allow-unreleasable)     ALLOW_UNRELEASABLE=true ;;
    --allow-partial-platforms) ALLOW_PARTIAL_PLATFORMS=true ;;
    # An unrecognised scope used to be accepted and stored, where it could never match
    # any prompt — the exact shape of the typo'd STEP name this script already dies on.
    # `--yes=dektop git` in CI therefore auto-confirmed NOTHING: confirm() fell through
    # to its non-TTY fail-closed branch, declined every prompt, printed "left as-is" plus
    # two green "clean & in sync" ticks, and exited 0 with an unqualified "Done." while
    # not one line reached GitHub (reproduced). Validate here, on the same principle.
    --yes=*)    yscope="${a#--yes=}"
                case " $VALID_YES_SCOPES " in
                  *" $yscope "*) YES_SCOPES="$YES_SCOPES$yscope " ;;
                  *) die "unknown --yes scope '$yscope' — valid scopes are: $VALID_YES_SCOPES (repeat the flag for several, or pass bare --yes for all)" ;;
                esac ;;
    *)          ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

confirm(){  # $1 prompt  $2 scope (optional: app|desktop|web|cli|login)
  local prompt="$1" scope="${2:-}" a
  if $YES_ALL; then
    say "  (auto-confirmed via --yes) $prompt"
    return 0
  fi
  if [ -n "$scope" ] && yes_scope "$scope"; then
    say "  (auto-confirmed via --yes=$scope) $prompt"
    return 0
  fi
  if [ ! -t 0 ]; then
    warn "stdin is not a TTY and no --yes/--yes=$scope covers this prompt — declining: $prompt"
    return 1
  fi
  read -r -p "  $prompt [y/N] " a
  case "$a" in [yY]|[yY][eE][sS]) return 0;; *) return 1;; esac
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  # Self-maintaining: print the header comment block (from line 2, skipping the
  # shebang) up to the first non-comment line, whatever that line number is —
  # so a future edit to the header can never desync a hardcoded line range again
  # (that desync once silently truncated this help text mid-sentence).
  awk 'NR==1{next} /^#/{line=$0; sub(/^# ?/,"",line); print line; next} {exit}' "$0"
  exit 0
fi

# ---- step-name validation --------------------------------------------------
# wants() only ever greps for the five known names, so an unrecognised argument used to
# match nothing: `./cheaper-deploy.sh dektop` printed the banner and "Done." with exit 0
# while running literally no step. Validate every positional up front and die on the
# first unknown one, naming the valid set.
VALID_STEPS="git cli web desktop docker"
for a in "$@"; do
  case " $VALID_STEPS " in
    *" $a "*) ;;
    *) die "unknown step '$a' — valid steps are: $VALID_STEPS (pass none to run them all, or --help)" ;;
  esac
done

# ---- git: commit & push ---------------------------------------------------
git_repo(){  # $1 dir  $2 friendly-name  $3 --yes scope
  local dir="$1" name="$2" scope="$3"
  # -e, not -d: in a linked worktree (and a submodule checkout) .git is a FILE, and the
  # -d test called such a repo "not a git repo" and skipped it with a warning.
  [ -e "$dir/.git" ] || { warn "$name: not a git repo — skipping"; return; }
  # A failed fetch leaves the remote-tracking refs STALE, and every "has this been
  # pushed?" question below is answered against those refs. `|| true` swallowed that
  # completely, so an auth or network outage silently downgraded the in-sync check to a
  # check against whatever was last fetched. Still not fatal — the push itself is the
  # authority — but it must not be invisible.
  local fetch_out fetch_rc
  fetch_out="$(git -C "$dir" fetch --quiet origin 2>&1)"; fetch_rc=$?
  if [ "$fetch_rc" -ne 0 ]; then
    if [ -n "$fetch_out" ]; then printf '%s\n' "$fetch_out" | sed 's/^/      /'; fi
    warn "$name: git fetch origin FAILED (git exit $fetch_rc) — the checks below compare against possibly-stale remote-tracking refs"
  fi

  # Everything this function claims rests on the two queries below, and both used to
  # discard their exit status (`2>/dev/null`, no rc check). ANY git failure therefore
  # produced the empty string, and empty+empty is the "clean & in sync" branch — so the
  # one path that prints an affirmative claim was the one path that could not tell
  # success from failure. Reproduced: a corrupt .git/index makes `git status` exit 128
  # ("index file smaller than expected") with an uncommitted file sitting right there,
  # and the script reported the repo clean, in sync, and exited 0. Capture the real
  # status, exactly as the add/commit/push blocks below already do.
  local dirty dirty_rc
  dirty="$(git -C "$dir" status --porcelain 2>&1)"; dirty_rc=$?
  if [ "$dirty_rc" -ne 0 ]; then
    if [ -n "$dirty" ]; then printf '%s\n' "$dirty" | sed 's/^/      /'; fi
    err "$name: git status FAILED (git exit $dirty_rc) — cannot tell whether this repo has uncommitted work, so NOT committing, NOT pushing, and NOT claiming it is in sync."
    say "cause is above (commonly a corrupt or unreadable .git/index, or a permissions problem)."
    say "fix it, then re-run:  ./cheaper-deploy.sh git"
    return
  fi

  # No commits at all: nothing can be unpushed and the upstream probe below is
  # meaningless. (A fresh repo holding only untracked files is dirty and takes the
  # commit path instead, which is what we want.)
  if ! git -C "$dir" rev-parse --verify --quiet HEAD >/dev/null 2>&1 && [ -z "$dirty" ]; then
    warn "$name: no commits yet — nothing to push"; return
  fi

  local branch desc
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$branch" = "HEAD" ]; then
    desc="detached HEAD at $(git -C "$dir" rev-parse --short HEAD 2>/dev/null)"
  else
    desc="branch '$branch'"
  fi

  # "0 unpushed commits" and "there is no upstream to compare against" are different
  # answers, but `git log '@{u}..HEAD' 2>/dev/null` returns the empty string for BOTH:
  # with no upstream, rev-parse of @{u} fails and the whole command exits non-zero
  # having printed nothing. A real commit on a fresh release branch, and a detached
  # HEAD carrying a real commit, were therefore both announced as "clean & in sync"
  # (reproduced; the commit never left the machine in either case). Probe the upstream
  # FIRST and only compare against it when it actually exists.
  local upstream upstream_rc unpushed="" have_upstream=false
  upstream="$(git -C "$dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; upstream_rc=$?
  if [ "$upstream_rc" -eq 0 ] && [ -n "$upstream" ]; then
    have_upstream=true
    local unpushed_rc
    unpushed="$(git -C "$dir" log --oneline '@{u}..HEAD' 2>&1)"; unpushed_rc=$?
    if [ "$unpushed_rc" -ne 0 ]; then
      if [ -n "$unpushed" ]; then printf '%s\n' "$unpushed" | sed 's/^/      /'; fi
      err "$name: git log '@{u}..HEAD' FAILED (git exit $unpushed_rc) — cannot tell whether this repo has unpushed commits, so NOT claiming it is in sync."
      say "fix the cause above, then re-run:  ./cheaper-deploy.sh git"
      return
    fi
  fi

  # Claim "in sync" only when BOTH queries actually succeeded AND there was something to
  # compare against.
  if [ -z "$dirty" ]; then
    if $have_upstream; then
      if [ -z "$unpushed" ]; then ok "$name: clean & in sync with $upstream"; return; fi
      # clean tree with real unpushed commits — fall through to the push confirm below.
    else
      # No upstream. HEAD can still already be on the remote (e.g. a detached checkout of
      # an already-pushed commit), and that IS genuinely nothing-to-do — but only a
      # remote-tracking ref containing HEAD can prove it. Anything else means local
      # commits exist that no remote has, and `git push` with no upstream cannot ship
      # them, so this is an error, not a green tick.
      local contains first_ref
      contains="$(git -C "$dir" branch -r --contains HEAD 2>/dev/null)"
      first_ref="$(printf '%s\n' "$contains" | awk 'NF{$1=$1;print;exit}')"
      if [ -n "$first_ref" ]; then
        ok "$name: clean — $desc has no upstream, but HEAD is already on the remote ($first_ref); nothing to push"
        return
      fi
      err "$name: $desc has NO upstream and HEAD is on no remote-tracking branch — this repo holds local commit(s) that never left the machine, and a bare 'git push' cannot ship them."
      say "the working tree is clean, so there is nothing to commit; publish the branch yourself:"
      if [ "$branch" = "HEAD" ]; then
        say "  git -C $dir switch -c <branch> && git -C $dir push -u origin <branch>   # HEAD is detached"
      else
        say "  git -C $dir push -u origin $branch"
      fi
      return
    fi
  fi
  if [ -n "$dirty" ]; then
    say "$name — uncommitted changes:"; git -C "$dir" status --short | sed 's/^/      /'
    if confirm "Commit & push $name?" "$scope"; then
      # `git add -A` can itself fail (stale .git/index.lock, unreadable path). If it does,
      # nothing gets staged, the commit below then fails with an EMPTY index, and the
      # empty-index test would misread that as the harmless "nothing to commit" case —
      # re-opening the exact false-success this block exists to close. So check it here.
      local add_out add_rc
      add_out="$(git -C "$dir" add -A 2>&1)"; add_rc=$?
      if [ "$add_rc" -ne 0 ]; then
        if [ -n "$add_out" ]; then printf '%s\n' "$add_out" | sed 's/^/      /'; fi
        err "$name: git add FAILED (git exit $add_rc) — NOT committing or pushing; nothing reached GitHub."
        say "fix the cause above (commonly a stale .git/index.lock), then re-run:  ./cheaper-deploy.sh git"
        return
      fi
      # A failed commit used to be swallowed as `|| warn "$name: nothing to commit"`, and
      # the push below then pushed an UNCHANGED HEAD — which legitimately succeeds
      # ("Everything up-to-date", rc 0), so the run printed the green "pushed" tick and
      # exited 0 while nothing reached GitHub and the tree was still dirty. That is the
      # same false-success shape as the pipeline-status bug fixed just below, and warn()
      # deliberately does not set FAILED, so `./cheaper-deploy.sh git &&
      # notify-release-shipped` fired on a release that was never committed.
      # Capture the REAL status, exactly as the push does.
      # LC_ALL=C/LANGUAGE= is load-bearing, not cosmetic: the benign-vs-real
      # classification below reads git's own message, and git TRANSLATES it through its
      # gettext catalogs (git 2.48.1 here ships fr). Under LC_ALL=fr_FR.UTF-8 the same
      # in-sync submodule fixture printed "aucune modification n'a été ajoutée à la
      # validation", which matches none of the English patterns, so a repo that was
      # simply in sync was declared a commit FAILURE and the run exited 1 naming a
      # fabricated cause list (hook rejection, gpg, unset user.email, index.lock).
      # It failed SAFE — a false alarm, never a false green — but a release was blocked
      # on nothing and the stated cause was invented. Two ways to make the test
      # locale-independent were available; this one forces git to answer in the language
      # the patterns are written in, which fixes the classification AND every other
      # prose-derived judgement in this block at once, rather than deleting a signal.
      # BOTH assignments are load-bearing. GNU gettext lets LANGUAGE override
      # LC_MESSAGES, and it is not merely theoretical here: verified on this machine,
      # `LC_ALL=en_US.UTF-8 LANGUAGE=fr git status` still answers in French. LC_ALL=C
      # alone would therefore leave the classifier translated for anyone whose
      # environment sets LANGUAGE (common on Linux desktops and in some CI images).
      # The tradeoff is that git's text is shown to the operator in English — correct
      # for a release script whose surrounding output is English anyway. The staged-tree
      # probe below (`git diff --cached --quiet`) is an exit code, never translated, and
      # remains the primary signal.
      local commit_out commit_rc
      commit_out="$(LC_ALL=C LANGUAGE= git -C "$dir" commit -q -m "Release sync $(date +%Y-%m-%d)

Co-Authored-By: Claude <noreply@anthropic.com>" 2>&1)"; commit_rc=$?
      if [ "$commit_rc" -ne 0 ]; then
        if [ -n "$commit_out" ]; then printf '%s\n' "$commit_out" | sed 's/^/      /'; fi
        # Distinguish a REAL failure from the genuinely-empty commit. Do NOT rely on
        # git's prose alone: it says "nothing to commit, working tree clean" for a clean
        # tree but "no changes added to commit" when the only dirtiness is unstaged or
        # submodule content (verified both), and a rejecting hook is free to print any
        # text it likes. So require TWO independent signals to call it benign:
        #   1. the staged tree is empty — `git diff --cached --quiet` exits 0. A hook
        #      rejection, gpg/signing failure or unset user.email all leave the index
        #      staged, so they exit 1 here and are correctly treated as failures.
        #   2. git's own message is the empty-commit message, not a fatal — read from a
        #      commit forced to the C locale above, so this pattern list is compared
        #      against git's untranslated English and never against a gettext catalog.
        # The empty case is in any event near-unreachable in these repos: we only get
        # here after `git status --porcelain` reported the tree dirty AND `git add -A`
        # succeeded, so it takes a dirty-submodule-only state — and none of cheaper-app /
        # cheaper-desktop / cheaper-web has a .gitmodules.
        local staged_empty=false benign=false
        git -C "$dir" diff --cached --quiet 2>/dev/null && staged_empty=true
        if $staged_empty; then
          case "$commit_out" in
            *"nothing to commit"*|*"no changes added to commit"*|*"nothing added to commit"*)
              benign=true ;;
          esac
        fi
        if $benign; then
          # Say only what is known HERE. The old wording ("— nothing new to push") also
          # predicted the outcome of a push that had not run yet, and the very next line
          # could contradict it: this same state can sit on top of unrelated commits that
          # genuinely are unpushed, in which case the push below does ship something
          # (reproduced). Let the push report its own result.
          warn "$name: nothing staged to commit — the modified content above stays uncommitted; checking whether earlier commits still need pushing"
        else
          # RETURN is the load-bearing half: falling through would push an unchanged
          # HEAD, succeed, and re-print the green "pushed" tick over a false claim.
          err "$name: commit FAILED (git exit $commit_rc) — NOT pushing. Nothing reached GitHub and the working tree is still dirty."
          say "cause is above (pre-commit/commit-msg hook rejection, gpg signing, unset user.email, stale .git/index.lock)."
          say "fix it, then re-run:  ./cheaper-deploy.sh git"
          return
        fi
      fi
    else say "$name: left as-is"; return; fi
  else
    confirm "Push $name (has unpushed commits)?" "$scope" || { say "$name: not pushed"; return; }
  fi
  # A pipeline's status is its LAST command's, and `sed` always succeeds — so
  # `if git push | sed …` reported a green "pushed" tick for a push that never left the
  # machine (no remote, non-fast-forward rejection, auth failure, protected branch), and
  # the "pull --rebase and retry" branch was unreachable dead code. Capture the output
  # and the REAL exit status first, then indent it for display.
  local push_out push_rc
  push_out="$(git -C "$dir" push 2>&1)"; push_rc=$?
  if [ -n "$push_out" ]; then printf '%s\n' "$push_out" | sed 's/^/      /'; fi
  if [ "$push_rc" -ne 0 ]; then
    err "$name: push FAILED (git exit $push_rc) — nothing reached GitHub; pull --rebase and retry"
    return
  fi
  # rc 0 is not the same as "refs were transferred". A push with nothing to send prints
  # "Everything up-to-date" and exits 0 — the identical status to a real transfer — so
  # the benign "nothing staged to commit" branch above fell through to here and printed
  # a green "$name: pushed" directly beneath its own warning and git's own
  # "Everything up-to-date" (reproduced with a dirty-submodule-content tree). Nothing
  # downstream broke — the repo really was in sync — but an operator skimming for green
  # ticks reads "pushed" as "that change shipped", and it had not. Reserve the tick for
  # a push that actually moved something. Falling through rather than returning early is
  # deliberate: the same tree can carry unrelated unpushed commits that DO need shipping.
  case "$push_out" in
    *"Everything up-to-date"*)
      warn "$name: already up-to-date — nothing was pushed" ;;
    *)
      ok "$name: pushed" ;;
  esac
}
step_git(){
  b "① git — commit & push all repos (pushes the updated README.md to GitHub)"
  git_repo "$APP"     "cheaper-app (ownasquare/cheaper)" app
  git_repo "$DESKTOP" "cheaper-desktop" desktop
  git_repo "$WEB"     "cheaper-web" web
}

# ---- pre-flight: is this workspace releasable? ------------------------------
# WHY THIS EXISTS. This script deploys the WORKING TREE (step_web runs `wrangler deploy`
# from $WEB; step_desktop uploads whatever is in dist/) while step_git pushes the CURRENT
# BRANCH, whatever that happens to be. Nothing tied those two together, so the two could
# — and did — describe different software.
#
# On 2026-08-09 cheaper-app sat on a feature branch, `parity-gates/one-python-launcher`,
# six commits and sixteen uncommitted files ahead of a `main` that had none of it. A
# deploy in that state would have shipped every one of those changes to cheaper.app and
# to R2 and then pushed them to the FEATURE branch, leaving origin/main at the commit it
# had held for days. The run would have exited 0 and printed nothing but green: it did
# push the branch it was on, and it did deploy the tree it was given. Both statements
# true, and together a lie about what is live.
#
# The gate is therefore not "is git tidy" — it is "does the git history describe the
# bytes this run is about to publish". Anything that breaks that correspondence stops the
# run: wrong branch, uncommitted work, unpushed commits, or a tree that is BEHIND origin
# (which ships code older than what the team already has).
#
# It is checked for ALL THREE repos even when a single step was requested. The surfaces
# are coupled — the desktop step reads cli/package.json's version, and the website
# advertises both — so "only deploying the web" is not a reason to leave cheaper-app's
# state unexamined. That assumption is precisely what let the divergence run for days.

# Same red as err(), but deliberately does NOT flip FAILED. Whether an unreleasable
# workspace is a FAILURE depends on --allow-unreleasable, and that decision belongs to
# the gate below, not to an individual finding. err() here would make an explicitly
# authorised partial run exit 1 anyway, which would make the flag useless and send the
# operator to edit this file instead.
pf_bad(){ printf '  \033[31m✗ %s\033[0m\n' "$*"; }

preflight_repo(){  # $1 dir  $2 friendly-name  -> 0 releasable, 1 NOT (reasons printed)
  local dir="$1" name="$2" rc
  # -e, not -d: in a linked worktree and a submodule checkout .git is a FILE.
  [ -e "$dir/.git" ] || { pf_bad "$name: not a git repo — there is no history that could describe what would ship"; return 1; }

  # A failed fetch leaves the remote-tracking refs STALE, and EVERY question below is
  # answered against those refs. The old git_repo() learned this the hard way: `|| true`
  # on the fetch silently downgraded "in sync with origin" to "in sync with whatever we
  # last heard". A gate that cannot see the remote must refuse, not guess.
  local fetch_err
  fetch_err="$(git -C "$dir" fetch --quiet --prune origin 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    pf_bad "$name: git fetch FAILED (git exit $rc) — remote-tracking refs are STALE, so 'level with origin' cannot be established. Refusing to ship on a guess."
    [ -n "$fetch_err" ] && say "    git said: $fetch_err"
    return 1
  fi

  local branch
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)"; rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$branch" ]; then
    pf_bad "$name: cannot read the current branch (git exit $rc) — cannot verify the release branch"
    return 1
  fi
  if [ "$branch" = "HEAD" ]; then
    pf_bad "$name: detached HEAD at $(git -C "$dir" rev-parse --short HEAD 2>/dev/null) — not on '$RELEASE_BRANCH'"
    say "    fix: git -C $dir switch $RELEASE_BRANCH"
    return 1
  fi
  if [ "$branch" != "$RELEASE_BRANCH" ]; then
    pf_bad "$name: on branch '$branch', not '$RELEASE_BRANCH' — this run would deploy this tree but push the commits to '$branch', leaving '$RELEASE_BRANCH' describing something else"
    say "    fix: land it, then re-run —"
    say "      git -C $dir switch $RELEASE_BRANCH && git -C $dir merge --ff-only $branch && git -C $dir push origin $RELEASE_BRANCH"
    return 1
  fi

  # Capture the status rc. An unreadable index exits non-zero having printed nothing, and
  # empty output is the "clean" answer — so a discarded rc turns "I could not look" into
  # "there is nothing there", which is the single most dangerous confusion in this file.
  local dirty dirty_rc
  dirty="$(git -C "$dir" status --porcelain 2>/dev/null)"; dirty_rc=$?
  if [ "$dirty_rc" -ne 0 ]; then
    pf_bad "$name: git status FAILED (git exit $dirty_rc) — cannot tell whether this tree holds uncommitted work, and 'cannot tell' is not 'clean'"
    return 1
  fi
  if [ -n "$dirty" ]; then
    local n; n="$(printf '%s\n' "$dirty" | grep -c .)"
    pf_bad "$name: working tree is DIRTY ($n path(s)) — this run would deploy bytes that exist in NO commit, so nothing on GitHub would describe what went live"
    printf '%s\n' "$dirty" | head -n 8 | sed 's/^/        /'
    [ "$n" -gt 8 ] && say "        … and $((n-8)) more"
    say "    fix: commit them (./cheaper-deploy.sh git), or stash/discard them deliberately"
    return 1
  fi

  local upstream up_rc
  upstream="$(git -C "$dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; up_rc=$?
  if [ "$up_rc" -ne 0 ] || [ -z "$upstream" ]; then
    pf_bad "$name: branch '$branch' has NO upstream — its commits have never left this machine and nothing can be compared against origin"
    say "    fix: git -C $dir push -u origin $branch"
    return 1
  fi

  # left = commits only on the upstream (we are BEHIND), right = only on HEAD (AHEAD).
  local counts c_rc ahead behind
  counts="$(git -C "$dir" rev-list --left-right --count "$upstream...HEAD" 2>/dev/null)"; c_rc=$?
  if [ "$c_rc" -ne 0 ] || [ -z "$counts" ]; then
    pf_bad "$name: git rev-list FAILED (git exit $c_rc) — cannot tell whether '$branch' is level with $upstream"
    return 1
  fi
  behind="$(printf '%s' "$counts" | awk '{print $1}')"
  ahead="$(printf '%s' "$counts" | awk '{print $2}')"
  if [ "$ahead" != "0" ]; then
    pf_bad "$name: $ahead commit(s) on '$branch' are NOT on $upstream — this run would deploy them while GitHub still shows the older tree"
    git -C "$dir" log --oneline --no-decorate "$upstream..HEAD" 2>/dev/null | head -n 5 | sed 's/^/        /'
    say "    fix: git -C $dir push origin $branch   (or run: ./cheaper-deploy.sh git)"
    return 1
  fi
  if [ "$behind" != "0" ]; then
    # Being behind is not cosmetic: the tree about to be deployed is missing commits that
    # are already on origin, so this run would publish software OLDER than what the team
    # has, and a later push would look like a revert.
    pf_bad "$name: $behind commit(s) on $upstream are NOT in this tree — deploying now would publish software OLDER than what is already on origin"
    say "    fix: git -C $dir pull --ff-only"
    return 1
  fi

  ok "$name: on '$branch', clean, level with $upstream at $(git -C "$dir" rev-parse --short HEAD 2>/dev/null)"
  return 0
}

# Memoised so a multi-step run pays for the fetches once and prints one verdict.
PREFLIGHT_VERDICT=""   # "" not yet run | ready | blocked
require_releasable(){  # 0 = proceed with the shipping steps, 1 = stop
  if [ -z "$PREFLIGHT_VERDICT" ]; then
    b "⓪ pre-flight — does the git history describe what is about to ship?"
    say "every repo must be on '$RELEASE_BRANCH', clean, and level with origin before anything is published."
    local blocked=0
    preflight_repo "$APP"     "cheaper-app"     || blocked=1
    preflight_repo "$DESKTOP" "cheaper-desktop" || blocked=1
    preflight_repo "$WEB"     "cheaper-web"     || blocked=1
    if [ "$blocked" -eq 0 ]; then PREFLIGHT_VERDICT=ready; else PREFLIGHT_VERDICT=blocked; fi
  fi

  if [ "$PREFLIGHT_VERDICT" = ready ]; then
    ok "pre-flight: all three repos are on '$RELEASE_BRANCH', clean, and level with origin — what ships is what GitHub shows"
    return 0
  fi

  if $ALLOW_UNRELEASABLE; then
    # Loud, and it names the consequence rather than the flag. An override that prints
    # "(overridden)" teaches the operator nothing the next time they read the log.
    warn "pre-flight BLOCKED above, but --allow-unreleasable was passed — shipping anyway."
    warn "what goes live will NOT match what origin/$RELEASE_BRANCH shows. Anyone auditing this release from GitHub will be reading the wrong tree."
    return 0
  fi

  err "pre-flight REFUSED: the git history does not describe what this run would publish (see the ✗ line(s) above) — nothing was deployed."
  say "this is the check that was missing on 2026-08-09, when cheaper-app sat six commits ahead of main on a feature branch and a deploy would have shipped all of it while origin/main showed none of it."
  say "fix the repo(s) above and re-run. To ship anyway, and say so on the record: ./cheaper-deploy.sh --allow-unreleasable"
  return 1
}

# ---- cli: npm publish (skip if unchanged, else ask) -----------------------
step_cli(){
  b "② cli — publish '$NPM_PKG' to npm"
  local lv pv
  lv="$(read_version "$CLI/package.json")"
  [ -n "$lv" ] || { err "can't read $CLI/package.json version (missing, malformed, or no \"version\" key)"; return; }
  # `npm view … 2>/dev/null || true` collapsed two different answers into the empty
  # string: "this package has never been published" and "the registry query FAILED".
  # The next line then printed the fabricated "published: <none>" for both. That claim
  # is load-bearing — it is the operator's evidence for whether this version is already
  # live — so a network blip, proxy error or registry outage presented as authoritative
  # fact. Distinguish them: npm answers a genuinely-absent package with E404.
  # stdout stays UNCONTAMINATED on the success path (npm writes notices to stderr, and
  # folding them into $pv would corrupt the version compare and turn a legitimate skip
  # into a doomed publish). Only when npm actually fails do we make a second call to read
  # the error text and classify it.
  local pv_rc pv_known=true pv_err=""
  pv="$(npm view "$NPM_PKG" version 2>/dev/null)"; pv_rc=$?
  if [ "$pv_rc" -ne 0 ]; then
    pv=""
    pv_err="$(npm view "$NPM_PKG" version 2>&1 >/dev/null)"
    case "$pv_err" in
      *E404*|*"404 Not Found"*) ;;   # genuinely never published — pv stays empty
      *) pv_known=false ;;
    esac
  fi
  if $pv_known; then
    say "local: $NPM_PKG@$lv    published: ${pv:-<none>}"
  else
    if [ -n "$pv_err" ]; then printf '%s\n' "$pv_err" | sed 's/^/      /'; fi
    warn "could not query npm for the published version of $NPM_PKG (npm exit $pv_rc) — cannot tell whether $lv is already live, so NOT reporting it as unpublished and NOT skipping."
    say "local: $NPM_PKG@$lv    published: <unknown — registry query failed>"
    say "the registry stays authoritative: if $lv is in fact already published, the publish below fails with EPUBLISHCONFLICT and this run exits 1."
  fi
  if $pv_known && [ -n "$pv" ] && [ "$lv" = "$pv" ]; then
    warn "$NPM_PKG@$lv is already on npm — nothing new to publish."
    say  "(bump \"version\" in cli/package.json to cut a new release.) Skipping CLI publish."
    return
  fi
  # This is the operator's last look at what is about to be published, so an empty
  # listing must mean "nothing changed" and not "the query failed" — printing the header
  # with nothing under it reads as the former either way.
  local cli_status cli_status_rc
  cli_status="$(git -C "$APP" status --short -- cli/ 2>&1)"; cli_status_rc=$?
  if [ "$cli_status_rc" -ne 0 ]; then
    if [ -n "$cli_status" ]; then printf '%s\n' "$cli_status" | sed 's/^/      /'; fi
    warn "could not list changes in cli/ (git exit $cli_status_rc) — the working-tree summary below is unavailable, NOT empty"
  else
    say "changes in cli/ since last commit:"
    if [ -n "$cli_status" ]; then printf '%s\n' "$cli_status" | sed 's/^/      /'
    else say "      (none — the working tree matches the last commit)"; fi
  fi

  # Pre-flight 1: AUTHENTICATION.
  # An expired ~/.npmrc token does not surface as 401 on publish — the registry answers
  # `404 Not Found - PUT /cheaper`, because npm must not disclose whether a package
  # exists to an unauthenticated caller. That 404 reads exactly like "wrong package name"
  # or "you lack permission", and cost a full debugging cycle. Check whoami first so the
  # real cause is named up front.
  # But a FAILED whoami is not by itself evidence about the token. `who="$(npm whoami
  # 2>/dev/null || true)"` discarded BOTH the exit status and npm's error text, so every
  # transport failure (DNS, proxy, corporate MITM, registry outage) arrived here as the
  # empty string and was reported as the affirmative claim that ~/.npmrc is expired —
  # sending the operator to re-authenticate a token that was never the problem.
  # Reproduced: a genuinely logged-out run (ENEEDAUTH) and a DNS-down run with a
  # perfectly valid token produced BYTE-IDENTICAL output, both naming the token, and
  # `grep -c ENOTFOUND` over the second run returned 0 because the 2>/dev/null threw
  # npm's own "getaddrinfo ENOTFOUND" away — so nothing on screen could contradict the
  # fabricated diagnosis. The `|| true` additionally made a failed whoami
  # indistinguishable from one that succeeded and printed no user. This is the same
  # mistake the `npm view` block above was rewritten to eliminate, so classify the same
  # way: capture the status, print npm's REAL error, and only name the token when npm's
  # error actually carries an auth signature. stdout stays uncontaminated on the success
  # path (npm writes notices to stderr); only a failure makes the second call.
  local who who_rc who_err=""
  who="$(npm whoami 2>/dev/null)"; who_rc=$?
  if [ "$who_rc" -ne 0 ]; then
    who_err="$(npm whoami 2>&1 >/dev/null)"
    if [ -n "$who_err" ]; then printf '%s\n' "$who_err" | sed 's/^/      /'; fi
    case "$who_err" in
      *ENEEDAUTH*|*E401*|*"401 Unauthorized"*|*"requires you to be logged in"*)
        # ONLY this branch — the one where npm's OWN error carries an auth signature — may
        # offer to re-authenticate. The fall-through branch below must never reach here:
        # a DNS/proxy/registry failure is not evidence about the token, and offering to
        # run `npm login` on one would resurrect the exact defect this classification was
        # written to kill (both runs used to print byte-identical token-blaming output),
        # only now it would also make the operator sit through a browser auth flow that
        # cannot possibly fix a network outage.
        #
        # The headline is err() on every path that does NOT end in a verified login, and
        # warn() on the path that goes on to attempt one. That split is deliberate:
        # err() sets FAILED, which is checked at the very end and forces exit 1, so an
        # unconditional err() here would let a successful re-auth + publish print the
        # green "published" tick and still exit 1 — the prose/exit-code disagreement this
        # script has been repeatedly repaired to avoid. Every failure path below calls
        # err() itself, so FAILED is set exactly when the step really did fail.
        local tty_ok=false
        if [ -t 0 ] && [ -t 1 ]; then tty_ok=true; fi
        if $tty_ok; then
          warn "npm is not authenticated (npm whoami exit $who_rc) — publishing would fail with a misleading 404."
        else
          err "npm is not authenticated (npm whoami exit $who_rc) — publishing would fail with a misleading 404."
        fi
        say "npm reports auth failure on PUT as '404 Not Found - PUT .../$NPM_PKG', which"
        say "looks like a package-name or permissions problem. It is not: the token in"
        say "~/.npmrc is expired or absent."
        # TTY FIRST — before the offer, not after it. `npm login --auth-type=web` opens a
        # browser (or prints a URL) and polls for approval, and npm refuses that flow when
        # stdin/stdout are not TTYs, exactly as the publish does. Pre-flight 2 already
        # guards the publish, but it runs LATER, so without this test a piped run would be
        # offered a login that could not possibly work. Hoisting Pre-flight 2 above this
        # block was rejected: it would change which error a piped operator with a VALID
        # token sees first. So test here, and on non-TTY keep the previous behaviour
        # exactly — the same ✗ headline, the same fix: line, no login attempt.
        if ! $tty_ok; then
          say "fix:  npm login --auth-type=web    # prints a URL; approve it in your browser"
          say "this run cannot do that for you: npm's web login needs a real terminal (it"
          say "opens a browser and polls for approval, and npm refuses the flow unless stdin"
          say "AND stdout are TTYs) and this run's stdio is piped or redirected."
          say "run it in a terminal, then re-run:  ./cheaper-deploy.sh cli"
          return
        fi
        # CONFIRM — writing a new token to ~/.npmrc is a side effect, and this script
        # never takes one silently. Its own scope, so `--yes=cli` can automate the publish
        # without also automating an auth flow.
        if ! confirm "Run 'npm login --auth-type=web' now to re-authenticate? (a browser opens; writes a new token to ~/.npmrc)" login; then
          err "npm login declined — NOT publishing, and ~/.npmrc is untouched."
          say "fix:  npm login --auth-type=web    # prints a URL; approve it in your browser"
          say "then re-run:  ./cheaper-deploy.sh cli"
          return
        fi
        say "running: npm login --auth-type=web   (approve it in the browser window npm opens)"
        # npm INHERITS this terminal: no pipe, no redirect, no capture. The Pre-flight 2
        # comment below records what a `printf '\n' | npm publish` pipe did — it made
        # stdin a non-TTY and was itself the sole cause of a 100% EOTP failure rate. The
        # identical trap applies to login, and capturing its output would spring it. That
        # is why npm's own text scrolls past unindented here, unlike every other npm call
        # in this step.
        # No credential passes through this script: --auth-type=web keeps the token,
        # password and OTP strictly between npm, your browser and ~/.npmrc.
        local login_rc
        npm login --auth-type=web
        login_rc=$?
        if [ "$login_rc" -ne 0 ]; then
          err "npm login FAILED (npm exit $login_rc) — NOT publishing."
          say "npm's own output is above (it was not captured, so nothing is hidden)."
          say "one attempt only, no retry loop. Fix the cause, then re-run:  ./cheaper-deploy.sh cli"
          return
        fi
        # NEVER ASSUME IT WORKED. `npm login` exiting 0 is not an identity — a cancelled
        # or timed-out browser approval, or a token written for a different registry, can
        # still leave you logged out. Re-ask, and classify the answer with the SAME three
        # tests as the first check above (non-zero exit + auth signature, non-zero exit
        # without one, zero exit naming nobody), so a post-login failure can no more
        # fabricate a cause than the pre-login one could.
        local who2 who2_rc who2_err=""
        who2="$(npm whoami 2>/dev/null)"; who2_rc=$?
        if [ "$who2_rc" -ne 0 ]; then
          who2_err="$(npm whoami 2>&1 >/dev/null)"
          if [ -n "$who2_err" ]; then printf '%s\n' "$who2_err" | sed 's/^/      /'; fi
          case "$who2_err" in
            *ENEEDAUTH*|*E401*|*"401 Unauthorized"*|*"requires you to be logged in"*)
              err "npm login exited 0 but npm STILL reports you as not authenticated (npm whoami exit $who2_rc) — NOT publishing."
              say "the browser approval was not completed, or the token it wrote is not accepted"
              say "by this registry. Nothing was published." ;;
            *)
              err "npm login exited 0 but the follow-up whoami FAILED for an unexplained reason (npm whoami exit $who2_rc) — NOT publishing."
              say "npm's error above carries no auth signature (no ENEEDAUTH, E401 or 401"
              say "Unauthorized), so whether you are now logged in is NOT established here — a"
              say "network, DNS, proxy or registry outage produces exactly this." ;;
          esac
          say "one attempt only, no retry loop. Fix the cause above, then re-run:  ./cheaper-deploy.sh cli"
          return
        fi
        if [ -z "$who2" ]; then
          err "npm login exited 0 and npm whoami exited 0, but npm named no user — NOT publishing."
          say "an empty answer is not an identity, and it is not proof of anything about the"
          say "new token either, so no cause is named here. Check by hand:  npm whoami"
          say "then re-run:  ./cheaper-deploy.sh cli"
          return
        fi
        # Say what happened: the identity that is about to publish, as npm reports it NOW.
        who="$who2"
        ok "re-authenticated — npm now reports user: $who"
        ;;
      *)
        err "could not ask npm who you are (npm whoami exit $who_rc) — NOT publishing."
        say "this is a whoami QUERY failure. It is NOT proof that your token is expired:"
        say "npm's own error is printed above and carries no auth signature (no ENEEDAUTH,"
        say "E401 or 401 Unauthorized). The cause is not established from here — a network,"
        say "DNS, proxy or registry outage produces exactly this, and so does a valid token."
        say "no login is offered for this: re-authenticating cannot fix a transport failure,"
        say "and offering it would blame the token all over again."
        say "read npm's text above, fix that, then re-run:  ./cheaper-deploy.sh cli"
        return ;;
    esac
  fi
  if [ -z "$who" ]; then
    err "npm whoami succeeded (exit 0) but named no user — NOT publishing."
    say "an empty answer is not an identity, and it is equally not proof that the token is"
    say "expired, so no cause is named here. Check by hand, then re-run:  npm whoami"
    return
  fi
  say "npm user: $who"

  # Pre-flight 2: TTY.
  # npm's 2FA browser approval requires stdin AND stdout to be TTYs. npm 11's
  # lib/utils/auth.js::otplease bails BEFORE it ever reaches the web-OTP branch:
  #     if (!process.stdin.isTTY || !process.stdout.isTTY) { throw err }
  # This block previously piped `printf '\n' |` into npm to "auto-answer the Press ENTER
  # prompt". That pipe made stdin a non-TTY and was itself the sole reason the browser
  # never opened — the step failed EOTP 100% of the time, in every terminal. There is no
  # ENTER prompt to answer: npm's opener prints "Authenticate your account at <url>" and
  # opens the browser itself. So npm must inherit the terminal untouched.
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    err "npm publish needs a real terminal — 2FA approval opens a browser, and npm"
    err "refuses that flow unless stdin AND stdout are TTYs."
    say "This run's stdio is piped or redirected, so the publish would fail EOTP."
    say "run it directly in a terminal:  ./cheaper-deploy.sh --yes=cli cli"
    return
  fi

  if confirm "Publish $NPM_PKG@$lv to npm now? (a browser opens to approve — no OTP needed)" cli; then
    ( cd "$CLI" && npm publish --access public ) \
      && ok "published $NPM_PKG@$lv" || err "npm publish failed"
  else say "CLI publish skipped."; fi
}

# ---- web: wrangler deploy -------------------------------------------------
step_web(){
  b "③ web — wrangler deploy (cheaper.app)"
  # Without this, a missing/unreadable cheaper-web made `cd` fail and the run blamed
  # CLOUDFLARE_API_TOKEN — a true failure with a false cause, which sends the operator
  # to re-issue a token that was never the problem.
  [ -d "$WEB" ] || { err "missing $WEB — cannot deploy the website (checkout cheaper-web next to this script)"; return; }
  ( cd "$WEB" && $WRANGLER deploy ) && ok "website deployed" \
    || err "wrangler deploy failed (is CLOUDFLARE_API_TOKEN set?)"
}

# ---- desktop: installers -> R2 --------------------------------------------
# electron-builder names installers Cheaper-${version}-${arch}.${ext} or
# Cheaper-Setup-${version}.exe. Extract ${version} so we can refuse to publish a stale
# build (BLOCKER-2: an old dist/ artifact was once uploaded to the stable R2 keys under
# a newer version's dl.cheaper.app, shipping an app that didn't match the gateway).
extract_version(){  # $1 filename (basename)
  local base="$1"
  # Semver core PLUS an optional prerelease segment (-beta.1, -rc.2, -next-3). Without
  # it, a legitimately-built Cheaper-0.3.0-beta.1-arm64.dmg parsed as "0.3.0" and the
  # step printed the self-contradicting "is v0.3.0 but … is v0.3.0-beta.1", telling the
  # operator to rebuild — which reproduces the identical filename forever. The
  # Setup-*.exe branch takes the same optional segment for the same reason.
  # The arch/ext suffix stays anchored and deliberately admits NO dash
  # ([A-Za-z0-9_]+\.[A-Za-z]+ covers arm64/x64/amd64/x86_64 + dmg/exe/deb/rpm/AppImage),
  # so the greedy prerelease can never swallow the arch token: in
  # Cheaper-0.3.0-beta.1-arm64.dmg the only split that satisfies the anchor is
  # 0.3.0-beta.1 + -arm64.dmg.
  local semver='[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?'
  if [[ "$base" =~ ^Cheaper-Setup-($semver)\.exe$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  elif [[ "$base" =~ ^Cheaper-($semver)-[A-Za-z0-9_]+\.[A-Za-z]+$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

put_r2(){  # $1 glob (in dist/)  $2 stable R2 key  $3 expected version  $4 file that version came from
  # returns: 0 uploaded
  #          1 REFUSED — the ARTIFACT is wrong (stale version, unparseable filename).
  #                      Remediation is a rebuild.
  #          2 no matching file in dist/ (benign skip)
  #          3 FAILED  — we could not LOOK (unreadable dist/) or could not UPLOAD (R2/
  #                      credential/network). The artifacts may be perfect. Remediation
  #                      is NOT a rebuild.
  # 1 and 3 were the same code, and step_desktop's summary then labelled every one of
  # them "version mismatch/unparseable" — asserting a cause it had not established.
  # Reproduced: correctly-named v0.3.0 installers plus a stale CLOUDFLARE_API_TOKEN
  # printed "0 uploaded, 2 REFUSED (version mismatch/unparseable) … fix the refused
  # artifact(s), then re-run", i.e. rebuild six installers to fix a credential.
  local glob="$1" key="$2" expected="$3" vsrc="${4:-cheaper-desktop/package.json}"
  # Same shape as the git queries: a discarded exit status turns "I could not look" into
  # "there is nothing there", and "nothing there" is the benign skip that keeps the run
  # green. find exits non-zero on an unreadable dist/ (permissions, a dangling mount),
  # having printed nothing — which would silently downgrade a real failure to "build it,
  # or it comes from CI". Refuse instead; the two answers are not interchangeable.
  local matches find_rc
  matches="$(find "$DESKTOP/dist" -maxdepth 1 -name "$glob" 2>&1)"; find_rc=$?
  if [ "$find_rc" -ne 0 ]; then
    if [ -n "$matches" ]; then printf '%s\n' "$matches" | sed 's/^/      /'; fi
    # "refusing" is reserved for a bad ARTIFACT now that the summary distinguishes the
    # two; this is a look failure, so it must not borrow the word that means "rebuild".
    err "can't list $DESKTOP/dist (find exit $find_rc) — NOT uploading $key; 'no artifact' and 'could not look' are not the same answer, and nothing here says the artifact is bad"
    return 3
  fi
  if [ -z "$matches" ]; then warn "no $glob in dist/ — skipping $key (build it, or it comes from CI)"; return 2; fi
  local match_count; match_count="$(printf '%s\n' "$matches" | grep -c .)"
  # Prefer whichever match's filename version equals the expected version — a dist/
  # holding both a stale and a fresh installer must pick the fresh one, not whichever
  # `find` happens to list first (directory order is filesystem-dependent).
  local f="" arbitrary=false
  if [ -n "$expected" ]; then
    local cand cbase cver
    while IFS= read -r cand; do
      [ -n "$cand" ] || continue
      cbase="$(basename "$cand")"
      cver="$(extract_version "$cbase")"
      if [ "$cver" = "$expected" ]; then f="$cand"; break; fi
    done <<<"$matches"
  fi
  if [ -z "$f" ]; then
    f="$(printf '%s\n' "$matches" | head -n1)"
    arbitrary=true
  fi
  # Report EVERY excluded sibling, not just the ones excluded on the fallback path. When
  # the preference loop did its job (picked v$expected over a stale v0.1.0 sitting next
  # to it) the operator was previously told nothing at all, so the stale artifact stayed
  # in dist/ into the next cycle — where a version bump can make it the arbitrary pick.
  if [ "$match_count" -gt 1 ]; then
    local ignored="" other
    while IFS= read -r other; do
      [ -n "$other" ] || continue
      [ "$other" = "$f" ] && continue
      ignored="$ignored${ignored:+, }$(basename "$other")"
    done <<<"$matches"
    if $arbitrary; then
      warn "$match_count files matched '$glob' in dist/ and NONE is v$expected — arbitrarily picked $(basename "$f"); ignored: $ignored — delete the stale artifact(s) from dist/ and re-run"
    else
      warn "$match_count files matched '$glob' in dist/ — picked $(basename "$f") (v$expected), $((match_count-1)) stale sibling(s) ignored: $ignored — delete them from dist/"
    fi
  fi
  local base fv
  base="$(basename "$f")"
  fv="$(extract_version "$base")"
  if [ -z "$fv" ]; then
    err "can't parse a version out of '$base' — refusing to upload $key (unrecognized filename pattern)"
    return 1
  fi
  if [ -n "$expected" ] && [ "$fv" != "$expected" ]; then
    # Name the file the expected version actually came from. Hardcoding
    # "cli/package.json" here contradicted the step header two lines earlier
    # ("cheaper-desktop/package.json version: …") and pointed the operator at the file
    # the VERSION GUARD explicitly says electron-builder does NOT read.
    err "VERSION MISMATCH: $base is v$fv but $vsrc is v$expected — refusing to upload $key"
    say  "rebuild first, then re-run:  (cd cheaper-desktop && npm run dist:mac)   # or dist:win / dist:linux"
    return 1
  fi
  say "$base  ->  r2://$R2_BUCKET/$key"
  # RETRY, because these uploads fail transiently and a first-attempt failure was being
  # reported as a release-blocking error.
  #
  # On 2026-08-09 cheaper-macos-x64.dmg (~104 MB) failed THREE separate runs with
  # wrangler's bare `TypeError: fetch failed` — a transport error, carrying no HTTP status
  # and no mention of credentials — then succeeded on the next attempt with the identical
  # bytes. The smaller arm64 dmg beside it uploaded first time on every one of those runs.
  # A single attempt therefore turned a flaky network into "dl.cheaper.app was NOT fully
  # updated", which is both alarming and, on re-run, untrue.
  #
  # Three attempts with a widening pause. Deliberately NOT a longer schedule: a genuine
  # credential or bucket error fails identically every time, and making the operator watch
  # it fail slowly teaches them nothing. The attempt count is printed so a flaky upload
  # that eventually succeeds is visible in the log rather than silently smoothed over — an
  # upload that needed three goes is a fact about the release, not noise.
  local attempt rc=1
  for attempt in 1 2 3; do
    if [ "$attempt" -gt 1 ]; then
      warn "$key: upload attempt $((attempt-1)) failed — retrying (attempt $attempt of 3)"
      sleep $(( (attempt - 1) * 5 ))
    fi
    if $WRANGLER r2 object put "$R2_BUCKET/$key" --file "$f" --remote; then rc=0; break; fi
    rc=1
  done
  if [ "$rc" -eq 0 ]; then
    if [ "$attempt" -gt 1 ]; then
      ok "uploaded $key (succeeded on attempt $attempt of 3 — the earlier failure(s) were transient)"
    else
      ok "uploaded $key"
    fi
    return 0
  fi
  # The artifact passed every check we make — the version matched — and three attempts
  # could not put it. Whatever went wrong happened at the R2 end (credential, network,
  # bucket), so this is a FAILED upload, not a REFUSED artifact, and rebuilding it would
  # change nothing.
  err "upload failed: $key (wrangler could not put $base after 3 attempts — this is an upload failure, NOT a problem with the artifact; see wrangler's output above)"
  return 3
}
step_desktop(){
  b "④ desktop — upload cheaper-desktop/dist installers -> R2 (dl.cheaper.app)"
  [ -d "$DESKTOP/dist" ] || { warn "no cheaper-desktop/dist — run: (cd cheaper-desktop && npm run dist:mac)"; return; }
  local cliv desktopv
  cliv="$(read_version "$CLI/package.json")"
  desktopv="$(read_version "$DESKTOP/package.json")"
  if [ -z "$desktopv" ]; then
    err "can't read $DESKTOP/package.json version — refusing to upload ANY installer (cannot verify version match)"
    return
  fi
  if [ -z "$cliv" ]; then
    err "can't read $CLI/package.json version — refusing to upload ANY installer (cannot verify version match)"
    return
  fi
  # Distinct, up-front check: electron-builder names installers from
  # cheaper-desktop/package.json, not cli/package.json. If the two repos disagree on
  # the release version there is no single "expected version" to check filenames
  # against, so refuse the whole step here rather than producing a per-file mismatch
  # error that would send the operator to rebuild the same (correctly-named) file
  # forever. This is a "your two repos disagree" problem, not a "your dist/ is stale"
  # problem — the remediation is different, so the message is too.
  if [ "$desktopv" != "$cliv" ]; then
    err "VERSION DISAGREEMENT: cheaper-desktop/package.json is v$desktopv but cli/package.json is v$cliv"
    say  "electron-builder names installers from cheaper-desktop/package.json, so these must match before any artifact can be verified."
    say  "fix: bump the version in cheaper-desktop/package.json (or cli/package.json) so both agree, then re-run: ./cheaper-deploy.sh desktop"
    return
  fi
  say "cheaper-desktop/package.json version: $desktopv — installers must match this to be uploaded"
  local uploaded=0 refused=0 failed=0 skipped=0 rc skipped_keys="" ci_keys=""
  # Third field: WHO owns this key.
  #   local — built on this machine (`npm run dist:mac`) and uploaded from here. macOS
  #           only, because the signing identity lives in this Keychain.
  #   ci    — built and uploaded by the 3-OS matrix in
  #           cheaper-desktop/.github/workflows/release.yml on a v* tag. Windows needs a
  #           Windows runner; Linux needs real fpm/AppImage tooling (the one attempt to
  #           build Linux on Apple Silicon produced a 96-byte empty .deb).
  #
  # Without this distinction the step could not tell "this platform's artifact should be
  # here and isn't" from "this platform has never been built here and never will be", and
  # a mac-only workstation got four MISSING errors on every single run. An error that
  # fires every time is an error nobody reads — which is how the genuinely stale Windows
  # and Linux keys stayed unnoticed. `ci` keys are REPORTED, never counted as missing;
  # the release workflow fails its own job if it cannot update them.
  for spec in \
    '*-arm64.dmg|cheaper-macos-arm64.dmg|local' \
    '*-x64.dmg|cheaper-macos-x64.dmg|local' \
    '*.exe|cheaper-windows-x64.exe|ci' \
    '*-amd64.deb|cheaper-linux-amd64.deb|ci' \
    '*-x86_64.rpm|cheaper-linux-x86_64.rpm|ci' \
    '*-x86_64.AppImage|cheaper-linux-x86_64.AppImage|ci' \
    '*-arm64.deb|cheaper-linux-arm64.deb|ci' \
    '*-aarch64.rpm|cheaper-linux-arm64.rpm|ci' \
    '*-arm64.AppImage|cheaper-linux-arm64.AppImage|ci'
  do
    local glob="${spec%%|*}" rest="${spec#*|}"
    local key="${rest%%|*}" owner="${rest#*|}"
    # A ci-owned key with nothing in dist/ is the normal case on a workstation, and is
    # reported rather than counted. If an artifact IS present it is still version-checked
    # and uploaded — a locally-built Linux package is not ignored just because CI usually
    # makes it.
    if [ "$owner" = ci ] && [ -z "$(find "$DESKTOP/dist" -maxdepth 1 -name "$glob" 2>/dev/null)" ]; then
      ci_keys="$ci_keys${ci_keys:+, }$key"
      continue
    fi
    put_r2 "$glob" "$key" "$desktopv" "cheaper-desktop/package.json"; rc=$?
    case $rc in
      0) uploaded=$((uploaded+1)) ;;
      1) refused=$((refused+1)) ;;
      2) skipped=$((skipped+1)); skipped_keys="$skipped_keys${skipped_keys:+, }$key" ;;
      3) failed=$((failed+1)) ;;
      # An unmapped code is itself unexplained, so count it where it cannot claim a
      # cause: FAILED says "something went wrong", REFUSED would say "your build is stale".
      *) failed=$((failed+1)) ;;
    esac
  done
  hr
  # State the CI-owned keys this run did not touch, every time, even on a fully green
  # run. They are not failures — but "this step said nothing about Windows" must never be
  # readable as "Windows is up to date".
  if [ -n "$ci_keys" ]; then
    say "not this step's to upload (built and pushed by the release workflow on a v$desktopv tag): $ci_keys"
  fi
  # A MISSING artifact is not "nothing to do", and warning about it was the bug.
  #
  # Every key in the list above is a STABLE R2 key — cheaper-windows-x64.exe is the same
  # object on every release. If this run has no v$desktopv artifact for a platform, that
  # key is not cleared and not skipped-over-harmlessly: it keeps serving whatever
  # installer was uploaded LAST. So a run that ships macOS 0.4.0 and silently skips
  # Windows leaves dl.cheaper.app handing Windows users the PREVIOUS version, under a
  # download button the website has just relabelled 0.4.0. Nothing in the old output said
  # so — `skipped` was a warn(), which by this file's own convention means "informational,
  # nothing to do", and the step could still print an all-green summary.
  #
  # Reproduced on 2026-08-09: cheaper-desktop/dist held mac 0.4.0 and no .exe at all,
  # because release.yml had been invalid since 2026-08-07 and the 3-OS matrix had never
  # run. The deploy's own summary called that a skip.
  #
  # A deliberately partial release is still legitimate — it just has to be stated.
  local partial_problem=false
  if [ "$skipped" -gt 0 ] && ! $ALLOW_PARTIAL_PLATFORMS; then partial_problem=true; fi

  if [ "$refused" -gt 0 ] || [ "$failed" -gt 0 ] || $partial_problem; then
    # Name ONLY what is known. Each clause appears only when its counter is non-zero:
    # the old line always printed "$skipped not in dist/", so an unreadable dist/ (where
    # nothing could be counted at all) still reported "0 not in dist/" — implying the
    # directory had been read successfully, the exact opposite of what happened.
    local parts="$uploaded uploaded"
    [ "$refused" -gt 0 ] && parts="$parts, $refused REFUSED (bad artifact: version mismatch or unparseable filename)"
    [ "$failed"  -gt 0 ] && parts="$parts, $failed FAILED (could not read dist/, or the upload itself failed)"
    [ "$skipped" -gt 0 ] && parts="$parts, $skipped MISSING from dist/"
    err "desktop summary: $parts"
    if $partial_problem; then
      say "MISSING is not 'nothing to do': $skipped_keys"
      say "  each of those is a STABLE key on dl.cheaper.app, so it keeps serving whatever installer was uploaded LAST — the PREVIOUS version — while the platforms above move to v$desktopv. A user on that platform downloads an older app from a page advertising the new one, and nothing here or on the website says so."
      say "  build the missing platform(s):  (cd cheaper-desktop && npm run dist:win)   # or dist:mac / dist:linux"
      say "  Windows and Linux x86_64 come from the 3-OS matrix in cheaper-desktop/.github/workflows/release.yml (a v* tag, or a workflow_dispatch)."
      say "  or state the partial release explicitly, on the record:  ./cheaper-deploy.sh desktop --allow-partial-platforms"
    fi
    if [ "$refused" -gt 0 ]; then
      say "REFUSED needs a REBUILD — the artifact is wrong: (cd cheaper-desktop && npm run dist:mac)   # or dist:win / dist:linux"
    fi
    if [ "$failed" -gt 0 ]; then
      say "FAILED does NOT need a rebuild — the artifact may be perfect. Fix the cause named on the ✗ line(s) above: dist/ permissions, CLOUDFLARE_API_TOKEN, the bucket, or the network."
    fi
    err "dl.cheaper.app was NOT fully updated — fix the cause(s) above, then re-run: ./cheaper-deploy.sh desktop"
  elif [ "$skipped" -gt 0 ]; then
    # Only reachable with --allow-partial-platforms. Tested BEFORE the uploaded-is-zero
    # branch on purpose: an authorised run where NOTHING matched would otherwise fall
    # through to "nothing uploaded (0 matching files found in dist/)" — true, but it
    # names no key and says nothing about what those keys are still serving, which is the
    # entire fact the flag was used to accept.
    if [ "$uploaded" -gt 0 ]; then
      ok "desktop summary: $uploaded installer(s) uploaded at version $desktopv — 0 refused"
    else
      warn "desktop summary: nothing uploaded — no v$desktopv artifact matched any key"
    fi
    warn "PARTIAL RELEASE (authorised by --allow-partial-platforms): $skipped key(s) left untouched — $skipped_keys"
    warn "those keys still serve their PREVIOUS version from dl.cheaper.app; only the platform(s) uploaded above are on v$desktopv."
  elif [ "$uploaded" -eq 0 ]; then
    warn "desktop summary: nothing uploaded (0 matching files found in dist/)"
  else
    ok "desktop summary: all $uploaded matched installer(s) uploaded at version $desktopv — 0 refused"
  fi
}

# ---- docker: gateway image -> R2 ------------------------------------------
step_docker(){
  b "⑤ docker — build gateway image + upload tarball -> R2"
  have docker || { warn "docker not installed — skipping"; return; }
  docker info >/dev/null 2>&1 || { warn "docker daemon not running — start Docker, then: ./cheaper-deploy.sh docker"; return; }
  [ -f "$GATEWAY/Dockerfile" ] || { err "missing $GATEWAY/Dockerfile"; return; }
  local gv img tar
  # The `gv="${gv:-0.0.0}"` fallback that used to sit here INVENTED a release identity
  # out of an unreadable file: it built and tagged a local cheaper-gateway:0.0.0, pushed
  # a bogus cheaper-gateway-0.0.0.tar.gz to R2, and then OVERWROTE
  # cheaper-gateway-latest.tar.gz — the key this step's own comment calls "the one every
  # self-hoster actually pulls" — before printing two green ticks and exiting 0.
  # Reproduced with cli/package.json deleted, truncated to malformed JSON, and valid but
  # missing its "version" key (that last one produced cheaper-gateway:undefined). Every
  # unreadable-version run also collided on the same 0.0.0 key. One step earlier,
  # step_desktop refused the whole step over the same unreadable file and the script's
  # own EXIT CODE header promises that an unreadable version file makes the run exit 1 —
  # so the fallback contradicted both. Guard BEFORE docker build, so no local image is
  # tagged with a placeholder either, and no placeholder can ever reach r2 object put.
  gv="$(read_version "$CLI/package.json")"
  if [ -z "$gv" ]; then
    err "can't read $CLI/package.json version — refusing to build or upload ANY gateway image (a placeholder version would overwrite cheaper-gateway-latest.tar.gz, the key every self-hoster pulls)"
    say "this is the same refusal step_desktop makes for the same unreadable file — the two steps must agree."
    say "fix cli/package.json (missing, malformed mid-edit, or no \"version\" key), then re-run:  ./cheaper-deploy.sh docker"
    return
  fi
  img="cheaper-gateway:$gv"
  say "building $img (context: gateway/) ..."
  docker build -q -t "$img" -t "cheaper-gateway:latest" "$GATEWAY" >/dev/null || { err "docker build failed"; return; }
  tar="$WORKSPACE/cheaper-gateway-$gv.tar.gz"
  say "docker save -> $(basename "$tar")"
  # Same pipeline-status trap as the git push above (found while auditing the other
  # pipes in this file): `docker save | gzip` reports gzip's status, and gzip happily
  # succeeds on the empty stream a failed `docker save` leaves behind — which would
  # upload a valid-but-empty tarball to R2 as the release image. Check BOTH stages.
  docker save "$img" | gzip > "$tar"
  local save_rc=${PIPESTATUS[0]} gzip_rc=${PIPESTATUS[1]}
  if [ "$save_rc" -ne 0 ] || [ "$gzip_rc" -ne 0 ]; then
    err "docker save failed (docker save exit $save_rc, gzip exit $gzip_rc)"; rm -f "$tar"; return
  fi
  local ver_ok=false
  if $WRANGLER r2 object put "$R2_BUCKET/cheaper-gateway-$gv.tar.gz" --file "$tar" --remote; then
    ok "uploaded cheaper-gateway-$gv.tar.gz"; ver_ok=true
  else
    err "R2 upload failed: cheaper-gateway-$gv.tar.gz"
  fi
  # The 'latest' key is the one every self-hoster actually pulls
  # (docker load < cheaper-gateway-latest.tar.gz). This was a warn(), which does not set
  # FAILED — so a failed latest upload printed the unqualified "Done." and exited 0 while
  # dl.cheaper.app's latest key still served the PREVIOUS gateway image, silently paired
  # with the newly shipped CLI and desktop. A stale latest IS an incomplete release,
  # which is precisely what err()/FAILED means, so it must exit 1 rather than let
  # `./cheaper-deploy.sh docker && notify-release-shipped` fire. (The alternative —
  # keeping it a warning and adding a third WARNED banner state — was rejected: the
  # banner would still not be an error, and CI reads the exit code, not the banner.)
  if $WRANGLER r2 object put "$R2_BUCKET/cheaper-gateway-latest.tar.gz" --file "$tar" --remote; then
    ok "updated cheaper-gateway-latest.tar.gz"
  else
    err "R2 upload failed: cheaper-gateway-latest.tar.gz"
    if $ver_ok; then
      say "cheaper-gateway-$gv.tar.gz DID upload, but dl.cheaper.app's 'latest' key still serves the PREVIOUS gateway image — anyone pulling latest gets the old gateway alongside the newly shipped CLI/desktop."
    else
      say "neither key uploaded — dl.cheaper.app has no new gateway image at all."
    fi
    say "re-run:  ./cheaper-deploy.sh docker"
  fi
  rm -f "$tar"
  # Only print the self-host instruction for an artifact that is actually in R2. It used
  # to print unconditionally, so a run in which BOTH uploads failed still signed off with
  # a confident "docker load < cheaper-gateway-$gv.tar.gz" for a file nobody can download
  # — an affirmative instruction the two ✗ lines just above it contradict.
  if $ver_ok; then
    say "self-host: docker load < cheaper-gateway-$gv.tar.gz && docker run -p 8787:8787 -v cheaper-data:/data $img"
  else
    say "no self-host instructions: cheaper-gateway-$gv.tar.gz is not on dl.cheaper.app (see the ✗ above)."
  fi
}

# ---- run ------------------------------------------------------------------
have node || die "node is required"; have npm || die "npm is required"; have git || die "git is required"
STEPS="${*:-git cli web desktop docker}"
wants(){ printf ' %s ' "$STEPS" | grep -q " $1 "; }

b "Cheaper deploy — running: $STEPS"
$WRANGLER whoami >/dev/null 2>&1 || warn "wrangler not authenticated — set CLOUDFLARE_API_TOKEN (web/desktop/docker R2 will fail)"

# git runs FIRST and is deliberately NOT gated: it is the step whose whole job is to fix
# the conditions the gate checks for (uncommitted work, unpushed commits). Gating it
# would deadlock the only tool that can clear the blockage.
wants git     && { step_git;     }

# Everything below PUBLISHES — to npm, to cheaper.app, to dl.cheaper.app. The gate runs
# once, after git has had its chance, and refuses the whole publishing half rather than
# letting some surfaces go live from a tree nothing on GitHub describes. A blocked
# pre-flight has already called err(), so the run exits 1 through the normal summary.
if wants cli || wants web || wants desktop || wants docker; then
  if require_releasable; then
    wants cli     && { step_cli;     }
    wants web     && { step_web;     }
    wants desktop && { step_desktop; }
    wants docker  && { step_docker;  }
  fi
fi

# The human summary prints first, then the exit code agrees with it. Anything that
# called err() — a REFUSED installer, a push/publish/deploy failure, an unreadable
# version file — makes this run exit 1 so `… && notify-release-shipped` and CI cannot
# treat a refused or partial release as shipped.
if [ "$FAILED" -ne 0 ]; then
  b "Done — WITH FAILURES."
  say "one or more steps errored or REFUSED (see the ✗ lines above) — exiting 1; nothing downstream should treat this run as a shipped release."
  exit 1
fi
b "Done."
exit 0
