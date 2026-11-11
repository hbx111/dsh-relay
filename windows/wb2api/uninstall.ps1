# workbuddy2api -- uninstall
$ErrorActionPreference = 'Continue'
$dst = Join-Path $env:LOCALAPPDATA 'workbuddy2api'

Write-Host "[1/5] stopping process"
Get-Process wb2api -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host "[2/5] removing startup tasks"
Unregister-ScheduledTask -TaskName 'workbuddy2api-watchdog' -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'workbuddy2api'          -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "[3/5] removing firewall rule"
Remove-NetFirewallRule -DisplayName 'workbuddy2api 7863' -ErrorAction SilentlyContinue

Write-Host "[4/5] stopping watchdog"
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*watchdog.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "[5/5] deleting data directory $dst"
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }

Write-Host "done. accounts and usage data removed."
