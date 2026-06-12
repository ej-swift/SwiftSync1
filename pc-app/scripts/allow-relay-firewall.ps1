# Allow SwiftSync relay (port 4000) so phones can load the mobile page over Wi-Fi.
# Must run as Administrator.

$ruleName = 'SwiftSync Relay 4000'

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Write-Host ''
  Write-Host 'Access denied - run PowerShell as Administrator.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Right-click PowerShell, choose Run as administrator, then run:'
  Write-Host '  powershell -ExecutionPolicy Bypass -File C:\dev\swiftsync-relay\pc-app\scripts\allow-relay-firewall.ps1'
  Write-Host ''
  exit 1
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  Remove-NetFirewallRule -DisplayName $ruleName
}

New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 4000 `
  -Profile Private, Public, Domain `
  -ErrorAction Stop

Write-Host ('Firewall rule added: ' + $ruleName + ' on TCP port 4000') -ForegroundColor Green
