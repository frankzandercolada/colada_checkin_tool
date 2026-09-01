# colada365 Check-in — Windows installer (per-user)
# Installs the binary and a Scheduled Task that starts the server at logon.
# Run from PowerShell:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Port 3000]
param([int]$Port = 3000)
$ErrorActionPreference = 'Stop'

$AppDir  = Join-Path $env:LOCALAPPDATA 'ColadaCheckin'
$DataDir = Join-Path $AppDir 'data'
$Bin     = Join-Path $AppDir 'colada-checkin.exe'
$Starter = Join-Path $AppDir 'start-colada-checkin.cmd'
$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path (Join-Path $Here 'colada-checkin.exe'))) {
  Write-Error 'colada-checkin.exe not found next to install.ps1'
}

Write-Host "-> Installing to $AppDir"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# Stop a running instance before replacing the binary (upgrade path)
Get-Process colada-checkin -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Here 'colada-checkin.exe') $Bin -Force

# Starter script carries the environment (Scheduled Tasks cannot set env vars)
@"
@echo off
set CHECKIN_DATA_DIR=$DataDir
set PORT=$Port
"$Bin"
"@ | Set-Content -Path $Starter -Encoding ASCII

Write-Host '-> Registering Scheduled Task (starts at logon)'
$Action  = New-ScheduledTaskAction -Execute $Starter
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'ColadaCheckin' -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName 'ColadaCheckin'

Start-Sleep -Seconds 2
Write-Host ''
Write-Host "Installed and started."
Write-Host "  App:  http://localhost:$Port"
Write-Host "  Data: $DataDir"
Write-Host '  The server starts automatically at logon. Uninstall with uninstall.ps1'
