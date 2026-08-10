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
echo "──────────────────────────────────────────"
printf 'pre-flight: %s passed, %s failed\n' "$PASS" "$FAIL"
rm -rf "$WS"
[ "$FAIL" -eq 0 ]
