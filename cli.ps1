# Cheaper installer (Windows).  Usage:  irm https://cheaper.app/cli.ps1 | iex
Write-Host "`n  Cheaper - adaptive Claude model routing`n"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js 16+ is required. Install from https://nodejs.org and re-run."
  exit 1
}
Write-Host "  Installing via npx cheaperapp ..."
npx --yes cheaperapp@latest install --all
