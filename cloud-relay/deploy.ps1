# Deploy SwiftSync cloud relay to Fly.io
# Run:  .\cloud-relay\deploy.ps1
#
# First time only:  .\cloud-relay\setup-fly-auth.ps1
# (saves a long-lived deploy token - no repeated fly auth login)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root
Write-Host "Deploying from: $Root"

$fly = "$env:USERPROFILE\.fly\bin\flyctl.exe"
if (-not (Test-Path $fly)) {
  $fly = "flyctl"
}

function Initialize-FlyAuth {
  if ($env:FLY_API_TOKEN) { return }

  $tokenFile = Join-Path $PSScriptRoot ".fly-deploy-token"
  if (Test-Path $tokenFile) {
    $token = (Get-Content $tokenFile -Raw).Trim()
    if ($token) {
      $env:FLY_API_TOKEN = $token
      return
    }
  }

  & $fly auth whoami 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { return }

  Write-Host ""
  Write-Host "Fly.io auth not available in this shell." -ForegroundColor Yellow
  Write-Host "Run once:  .\cloud-relay\setup-fly-auth.ps1" -ForegroundColor Yellow
  Write-Host "That stores a long-lived deploy token (no more fly auth login)." -ForegroundColor Yellow
  exit 1
}

Initialize-FlyAuth

& $fly deploy . --config cloud-relay/fly.toml --dockerfile cloud-relay/Dockerfile
Write-Host "Ensuring single Fly machine (required for in-memory pairing rooms)..."
& $fly scale count 1 -a swiftsync-relay --yes
