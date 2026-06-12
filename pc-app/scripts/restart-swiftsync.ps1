# Restart SwiftSync relay (port 4000) and optionally launch the PC app.
# Run in PowerShell:  .\scripts\restart-swiftsync.ps1

$port = 4000
Write-Host "Stopping processes on port $port..."
Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
  ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }

Get-Process SwiftSync, electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*swiftsync*' -or $_.MainWindowTitle -like '*SwiftSync*' } |
  Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 1
Write-Host "Starting SwiftSync PC app (relay starts automatically)..."
Set-Location (Split-Path $PSScriptRoot -Parent)
& npm.cmd start
