#!/usr/bin/env bash
# Behavioural tests for cheaper-deploy.sh's release-readiness pre-flight.
#
# Runs the REAL script against a synthetic workspace of three throwaway git repos, each
# with its own local bare "origin". Nothing here touches the actual Cheaper repos, and no
# scenario can publish: every negative case blocks before any step runs, and the positive
# case uses `docker`, which returns immediately when no daemon is present.
set -u

T="$(cd "$(dirname "$0")" && pwd)"
WS="$T/.preflight-testws"
PASS=0; FAIL=0

# Writes cheaper-app/CHANGELOG.md with $1 as its newest heading. Called with no argument
# it writes a file containing no '## ' heading at all.
changelog_app(){
  printf '# Changelog\n\nWhat changed in each release of the Cheaper CLI.\n\n' > "$WS/cheaper-app/CHANGELOG.md"
  if [ "$#" -gt 0 ]; then
    printf '%s\nA release happened.\n- a bullet\n\n' "$1" >> "$WS/cheaper-app/CHANGELOG.md"
  fi
  return 0
}

# Re-commits and pushes cheaper-app so a CHANGELOG edit made AFTER fresh_workspace does not
# leave the repo dirty. Without this, every changelog scenario would also trip the DIRTY
# check and pass on the wrong ✗ line — a test that is green for a reason it was not written
# for is worse than no test.
app_commit(){
  git -C "$WS/cheaper-app" add -A
  git -C "$WS/cheaper-app" commit -q -m "${1:-changelog fixture}"
  git -C "$WS/cheaper-app" push -q origin main
}

fresh_workspace(){
  rm -rf "$WS"
  mkdir -p "$WS/remotes"
  local r
  for r in cheaper-app cheaper-web cheaper-desktop; do
    git init -q --bare "$WS/remotes/$r.git"
    git init -q -b main "$WS/$r"
    git -C "$WS/$r" config user.email test@example.invalid
    git -C "$WS/$r" config user.name  "preflight test"
    printf 'v1\n' > "$WS/$r/file.txt"
  done
  # Every file a step might read is written BEFORE the initial commit. Writing them after
  # left the fixture's own repos untracked-dirty, and the gate then (correctly) refused
  # every scenario — including the ones asserting it should pass. A fixture that trips the
  # gate it is testing proves nothing about the gate.
  mkdir -p "$WS/cheaper-app/cli"
  printf '{"name":"cheaper","version":"9.9.9"}\n' > "$WS/cheaper-app/cli/package.json"
  printf '{"name":"cheaper-desktop","version":"9.9.9"}\n' > "$WS/cheaper-desktop/package.json"
  # A CHANGELOG whose newest '## ' heading names the SAME version as cli/package.json, in
  # the exact shape the format contract specifies (## <semver> — <YYYY-MM-DD>, em dash).
  # It is part of the baseline fixture rather than one scenario's setup because the
  # changelog gate runs on every pre-flight: without this, all fourteen pre-existing
  # scenarios would start refusing for a reason none of them was written to test, and the
  # positive ones would go red while proving nothing.
  changelog_app '## 9.9.9 — 2026-08-10'
  # The workspace-root script is deliberately NOT inside any repo, matching the real
  # layout before the symlink section below rearranges it.
  cp "$T/cheaper-deploy.sh" "$WS/cheaper-deploy.sh"
  chmod +x "$WS/cheaper-deploy.sh"
  for r in cheaper-app cheaper-web cheaper-desktop; do
    git -C "$WS/$r" add -A
    git -C "$WS/$r" commit -q -m "init $r"
    git -C "$WS/$r" remote add origin "$WS/remotes/$r.git"
    git -C "$WS/$r" push -q -u origin main
  done
}

# $1 name  $2 expected-exit  $3 grep pattern that MUST appear  $4... args to the script
scenario(){
  local name="$1" want_rc="$2" want_txt="$3"; shift 3
  local out rc
  out="$("$WS/cheaper-deploy.sh" "$@" 2>&1)"; rc=$?
  local ok_rc=false ok_txt=false
  [ "$rc" = "$want_rc" ] && ok_rc=true
  printf '%s' "$out" | grep -q -- "$want_txt" && ok_txt=true
  if $ok_rc && $ok_txt; then
    printf '  PASS  %s  (exit %s)\n' "$name" "$rc"; PASS=$((PASS+1))
  else
    printf '  FAIL  %s\n' "$name"; FAIL=$((FAIL+1))
    $ok_rc  || printf '        expected exit %s, got %s\n' "$want_rc" "$rc"
    $ok_txt || printf '        expected output to contain: %s\n' "$want_txt"
    printf '%s\n' "$out" | sed 's/^/        | /' | head -n 25
  fi
}

# $1 name  $2 expected-exit  $3 grep pattern that must NOT appear  $4... args to the script
# The mirror of scenario(). Some refusals are wrong not because they are missing text but
# because they carry the WRONG diagnosis, and only an absence assertion can catch that.
scenario_absent(){
  local name="$1" want_rc="$2" bad_txt="$3"; shift 3
  local out rc
  out="$("$WS/cheaper-deploy.sh" "$@" 2>&1)"; rc=$?
  local ok_rc=false ok_txt=false
  [ "$rc" = "$want_rc" ] && ok_rc=true
  printf '%s' "$out" | grep -q -- "$bad_txt" || ok_txt=true
  if $ok_rc && $ok_txt; then
    printf '  PASS  %s  (exit %s)\n' "$name" "$rc"; PASS=$((PASS+1))
  else
    printf '  FAIL  %s\n' "$name"; FAIL=$((FAIL+1))
    $ok_rc  || printf '        expected exit %s, got %s\n' "$want_rc" "$rc"
    $ok_txt || printf '        output must NOT contain: %s\n' "$bad_txt"
    printf '%s\n' "$out" | sed 's/^/        | /' | head -n 25
  fi
}

echo "=== 1. all three repos clean, on main, level with origin -> gate PASSES ==="
fresh_workspace
scenario "clean workspace proceeds to the shipping step" 0 "level with origin" docker

echo "=== 2. one repo on a feature branch (the 2026-08-09 condition) -> BLOCKED ==="
fresh_workspace
git -C "$WS/cheaper-app" switch -q -c parity-gates/one-python-launcher
printf 'v2\n' > "$WS/cheaper-app/file.txt"
git -C "$WS/cheaper-app" commit -qam "work on a feature branch"
scenario "feature branch is refused" 1 "not 'main'" docker

echo "=== 3. uncommitted work -> BLOCKED ==="
fresh_workspace
printf 'uncommitted\n' > "$WS/cheaper-web/file.txt"
scenario "dirty tree is refused" 1 "working tree is DIRTY" docker

echo "=== 4. untracked file only -> BLOCKED (it would still be deployed) ==="
fresh_workspace
printf 'new\n' > "$WS/cheaper-web/brand-new-page.html"
scenario "untracked file is refused" 1 "working tree is DIRTY" docker

echo "=== 5. committed but never pushed -> BLOCKED ==="
fresh_workspace
printf 'v2\n' > "$WS/cheaper-desktop/file.txt"
git -C "$WS/cheaper-desktop" commit -qam "local only"
scenario "unpushed commit is refused" 1 "are NOT on origin/main" docker

echo "=== 6. behind origin -> BLOCKED (would publish older software) ==="
fresh_workspace
clone="$T/.preflight-pusher"; rm -rf "$clone"
git clone -q "$WS/remotes/cheaper-web.git" "$clone"
git -C "$clone" config user.email test@example.invalid
git -C "$clone" config user.name "someone else"
printf 'newer\n' > "$clone/file.txt"
git -C "$clone" commit -qam "a teammate pushed this"
git -C "$clone" push -q origin main
scenario "behind origin is refused" 1 "OLDER than what is already on origin" docker
rm -rf "$clone"

echo "=== 7. detached HEAD -> BLOCKED ==="
fresh_workspace
git -C "$WS/cheaper-app" checkout -q --detach HEAD
scenario "detached HEAD is refused" 1 "detached HEAD" docker

echo "=== 8. --allow-unreleasable overrides, loudly, and still ships ==="
fresh_workspace
printf 'uncommitted\n' > "$WS/cheaper-web/file.txt"
scenario "override ships but names the consequence" 0 "will NOT match what origin/main shows" docker --allow-unreleasable

echo "=== 9. the git step is NOT gated (it is what clears the blockage) ==="
fresh_workspace
printf 'uncommitted\n' > "$WS/cheaper-web/file.txt"
# No --yes, stdin not a TTY => confirm() fails closed and declines; the point of this
# scenario is only that the run reaches step_git rather than being stopped by the gate.
scenario "git runs without a pre-flight verdict" 0 "① git" git < /dev/null

echo "=== 10. desktop with no matching installer -> ERROR, not a benign skip ==="
# No upload can occur: dist/ is empty, so every key takes the "no artifact" path and the
# step fails before wrangler is ever invoked.
fresh_workspace
mkdir -p "$WS/cheaper-desktop/dist"
scenario "a missing installer fails the run" 1 "MISSING is not 'nothing to do'" desktop
# Assert on a LOCAL-owned key. This previously grepped for cheaper-windows-x64.exe, which
# went vacuous the moment CI-owned keys started being listed in their own line: the string
# was still present, just no longer as a MISSING key. A test that passes for a reason it
# was not written for is worse than no test.
scenario "and it names the missing LOCAL key" 1 "cheaper-macos-arm64.dmg" desktop

echo "=== 11. CI-owned keys are reported, never counted as missing ==="
fresh_workspace
mkdir -p "$WS/cheaper-desktop/dist"
scenario "ci-owned keys are named as not-ours" 1 "not this step's to upload" desktop
# The MISSING count must be 2 — the two macOS keys — not 9. If CI-owned keys leaked into
# it, a mac-only workstation would fail with seven phantom blockers it can do nothing about.
scenario "only the 2 local keys count as MISSING" 1 "2 MISSING from dist/" desktop

echo "=== 12. --allow-partial-platforms accepts it, and still names the keys ==="
fresh_workspace
mkdir -p "$WS/cheaper-desktop/dist"
scenario "authorised partial release exits 0" 0 "PARTIAL RELEASE" desktop --allow-partial-platforms
scenario "and still says what those keys serve" 0 "PREVIOUS version" desktop --allow-partial-platforms

echo "=== 13. verify is NOT pre-flight-gated — it publishes nothing ==="
# The synthetic workspace has no cheaper-app/scripts/verify-live.js, so this exercises the
# missing-verifier branch and makes NO network request. That is deliberate: the point here
# is the WIRING (does verify run at all, and is it reached from a dirty tree), not the
# verification itself, and a test suite that silently depends on the public internet fails
# for reasons that have nothing to do with the code under test.
fresh_workspace
printf 'uncommitted\n' > "$WS/cheaper-web/file.txt"
# If verify were inside the gated block, the pre-flight would refuse and this banner would
# never print. Its presence on a DIRTY tree is the proof.
scenario "verify runs on a dirty tree" 1 "⑥ verify" verify

echo "=== 14. a missing verifier is an ERROR, not a silent skip ==="
fresh_workspace
scenario "missing verify-live.js fails the run" 1 "cannot verify the deploy" verify

echo
echo "=== workspace resolution: invoking through a symlink from elsewhere ==="
fresh_workspace
mkdir -p "$WS/cheaper-app/scripts"
mv "$WS/cheaper-deploy.sh" "$WS/cheaper-app/scripts/cheaper-deploy.sh"
ln -s "cheaper-app/scripts/cheaper-deploy.sh" "$WS/cheaper-deploy.sh"
# Committed and pushed, because that is the whole point of moving it into a repo — and
# because leaving it untracked would dirty cheaper-app and the gate would refuse.
git -C "$WS/cheaper-app" add -A
git -C "$WS/cheaper-app" commit -q -m "move the deploy script into the repo"
git -C "$WS/cheaper-app" push -q origin main
scenario "symlink at the workspace root resolves the workspace" 0 "level with origin" docker
scenario "the real path inside the repo resolves it too" 0 "level with origin" docker
out="$("$WS/cheaper-app/scripts/cheaper-deploy.sh" docker 2>&1)"; rc=$?
if [ "$rc" = 0 ] && printf '%s' "$out" | grep -q "level with origin"; then
  printf '  PASS  invoking the real path directly (not the symlink)  (exit %s)\n' "$rc"; PASS=$((PASS+1))
else
  printf '  FAIL  invoking the real path directly\n'; FAIL=$((FAIL+1))
  printf '%s\n' "$out" | sed 's/^/        | /' | head -n 20
fi

echo "=== 14. step ORDER is the script's, never the order you typed ==="
# The header claims `cli` runs LAST of the publishing steps because an npm version is
# immutable while every other target overwrites. That claim is only true if the dispatch
# order is structural — if naming steps on the command line could reorder them, an
# operator typing `cli web` would publish an irreversible version BEFORE the reversible
# web deploy, which is the exact failure the ordering exists to prevent.
#
# Asserted by asking for them in the WRONG order and reading which banner prints first.
# `web` is used as the marker because its banner is unmistakable and it fails fast in the
# stub workspace without needing credentials.
fresh_workspace
order_out="$("$WS/cheaper-deploy.sh" cli web 2>&1)"
web_line="$(printf '%s' "$order_out" | grep -n 'web — wrangler deploy' | head -1 | cut -d: -f1)"
cli_line="$(printf '%s' "$order_out" | grep -n 'cli — npm publish\|npm publish' | head -1 | cut -d: -f1)"
if [ -n "$web_line" ] && [ -n "$cli_line" ] && [ "$web_line" -lt "$cli_line" ]; then
  printf '  PASS  typing `cli web` still runs web BEFORE cli  (web@%s < cli@%s)\n' "$web_line" "$cli_line"
  PASS=$((PASS+1))
elif [ -n "$web_line" ] && [ -z "$cli_line" ]; then
  # cli can legitimately not reach its banner in the stub (no npm identity); web having
  # run at all still proves it was dispatched first.
  printf '  PASS  typing `cli web` still runs web first (cli never reached its banner)\n'
  PASS=$((PASS+1))
else
  printf '  FAIL  step order followed the command line instead of the script\n'
  printf '        web banner at line %s, cli banner at line %s\n' "${web_line:-none}" "${cli_line:-none}"
  printf '%s\n' "$order_out" | sed 's/^/        | /' | head -n 20
  FAIL=$((FAIL+1))
fi

echo
echo "=== 15. CHANGELOG.md naming the shipping version -> gate PASSES ==="
# The gate must be satisfiable, and satisfied for the RIGHT reason. Asserting on the
# version number in the ok line, not on a generic "pre-flight ready", so a gate that
# stopped reading the file entirely could not still print a tick.
fresh_workspace
scenario "changelog naming 9.9.9 matches cli/package.json" 0 "newest entry is 9.9.9" docker

echo "=== 16. CHANGELOG.md two releases stale -> BLOCKED (the 2026-08-10 condition) ==="
# Live on 2026-08-10: cheaper-web/web/changelog.html's newest entry was 0.3.0 and its
# intro asserted "The currently published CLI is cheaper@0.3.0", while npm served 0.4.1
# and dl.cheaper.app served 0.4.1 installers. Two releases of a public page stating a
# false current version, because nothing had ever compared the two numbers.
fresh_workspace
changelog_app '## 0.3.0 — 2026-07-02'
app_commit "leave the changelog two releases behind"
scenario "a stale changelog is refused" 1 "newest entry is 0.3.0" docker
# BOTH numbers, or the operator cannot tell what to write without going and looking.
scenario "and it names the version actually shipping" 1 "cli/package.json says 9.9.9" docker
scenario "and nothing was published" 1 "nothing was deployed" docker

echo "=== 17. CHANGELOG.md missing -> BLOCKED with the DISTINCT could-not-determine message ==="
# Deleted and COMMITTED: an uncommitted deletion would also trip the DIRTY check, and the
# scenario would then pass off the wrong ✗ line while proving nothing about this gate.
fresh_workspace
rm -f "$WS/cheaper-app/CHANGELOG.md"
app_commit "remove the changelog entirely"
scenario "a missing changelog is refused" 1 "cannot determine which version CHANGELOG.md describes" docker
scenario "and it says the file does not exist" 1 "DOES NOT EXIST" docker
# The load-bearing half. "Could not determine" reported as a version mismatch would send
# the operator to bump a number in a file that is not there — and reported as nothing at
# all would render as "fine", which is the original defect.
scenario_absent "and it is NOT dressed up as a version mismatch" 1 "cli/package.json says" docker

echo "=== 18. CHANGELOG.md with no parseable '## ' heading -> BLOCKED, same distinct message ==="
fresh_workspace
changelog_app '## Unreleased'
app_commit "a heading that names no version"
scenario "an unparseable heading is refused" 1 "cannot determine which version CHANGELOG.md describes" docker
scenario "and it quotes the heading it could not read" 1 "Unreleased" docker
scenario "and it tells the operator NOT to bump anything" 1 "NOT a version mismatch" docker
scenario_absent "and it is NOT dressed up as a version mismatch" 1 "cli/package.json says" docker

echo "--- 18b. no '## ' heading at all is the same could-not-determine answer ---"
fresh_workspace
changelog_app          # prose only, zero '## ' headings
app_commit "a changelog that names no release at all"
scenario "a headingless changelog is refused" 1 "cannot determine which version CHANGELOG.md describes" docker
scenario "and it says there is no heading" 1 "NO '## ' heading at all" docker

echo "=== 19. --allow-unreleasable ships, and NAMES the changelog consequence ==="
# The override must survive the new gate, and — like every other refusal here — it must
# name what it is overriding rather than printing "(overridden)". A stale changelog waved
# through silently is indistinguishable from the two releases that shipped that way.
fresh_workspace
changelog_app '## 0.3.0 — 2026-07-02'
app_commit "stale changelog, overridden"
scenario "override ships past a stale changelog" 0 "release notes overridden" docker --allow-unreleasable
scenario "and names what the site will keep saying" 0 "keep naming 0.3.0 as the current release" docker --allow-unreleasable
# git is spotless here, so the git consequence would be a FALSE statement pointing the
# operator at the wrong file. Each override line is printed only for the check it covers.
scenario_absent "and does not claim git diverged when it did not" 0 "will NOT match what origin/main shows" docker --allow-unreleasable

echo
echo "──────────────────────────────────────────"
printf 'pre-flight: %s passed, %s failed\n' "$PASS" "$FAIL"
rm -rf "$WS"
[ "$FAIL" -eq 0 ]
