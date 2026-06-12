# One-time Fly.io auth setup for local deploys.
# Creates a long-lived deploy token so deploy.ps1 works without fly auth login.
#
# Run once (while logged into Fly in your browser):
#   .\cloud-relay\setup-fly-auth.ps1

$ErrorActionPreference = "Stop"
$AppName = "swiftsync-relay"
$TokenFile = Join-Path $PSScriptRoot ".fly-deploy-token"

$fly = "$env:USERPROFILE\.fly\bin\flyctl.exe"
if (-not (Test-Path $fly)) {
  $fly = "flyctl"
}

Write-Host "Checking Fly login..."
& $fly auth whoami 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Not logged in - opening browser for fly auth login..."
  & $fly auth login
  if ($LASTEXITCODE -ne 0) {
    throw "fly auth login failed"
  }
}

Write-Host "Creating deploy token for '$AppName' (valid 10 years)..."
$json = & $fly tokens create deploy -a $AppName -n "swiftsync-local-deploy" -x 87600h -j
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create deploy token: $json"
}

$token = $null
try {
  $parsed = $json | ConvertFrom-Json
  if ($parsed.token) { $token = $parsed.token }
  elseif ($parsed.Token) { $token = $parsed.Token }
} catch {
  $token = ($json | Out-String).Trim()
}

if (-not $token -or $token.Length -lt 20) {
  throw "Could not read token from flyctl output: $json"
}

Set-Content -Path $TokenFile -Value $token -NoNewline -Encoding utf8
[Environment]::SetEnvironmentVariable("FLY_API_TOKEN", $token, "User")
$env:FLY_API_TOKEN = $token

Write-Host ""
Write-Host "Done. Saved deploy token to:" -ForegroundColor Green
Write-Host "  $TokenFile"
Write-Host "Also set Windows user env var FLY_API_TOKEN (new terminals pick this up automatically)."
Write-Host ""
Write-Host "Deploy anytime with:"
Write-Host '  .\cloud-relay\deploy.ps1'
