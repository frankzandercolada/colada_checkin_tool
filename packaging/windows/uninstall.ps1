# colada365 Check-in — Windows uninstaller. Data is KEPT unless -Purge is passed.
param([switch]$Purge)
$ErrorActionPreference = 'SilentlyContinue'
$AppDir = Join-Path $env:LOCALAPPDATA 'ColadaCheckin'
Unregister-ScheduledTask -TaskName 'ColadaCheckin' -Confirm:$false
Get-Process colada-checkin | Stop-Process -Force
Remove-Item (Join-Path $AppDir 'colada-checkin.exe'), (Join-Path $AppDir 'start-colada-checkin.cmd') -Force
if ($Purge) {
  Remove-Item $AppDir -Recurse -Force
  Write-Host 'Uninstalled (including data).'
} else {
  Write-Host "Uninstalled. Data kept in $AppDir\data (remove with -Purge)."
}
