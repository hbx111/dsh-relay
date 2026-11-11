# dsh-relay installer -- registers the scheduled task (logon + self-heal)
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install-relay.ps1
#   powershell -ExecutionPolicy Bypass -File .\install-relay.ps1 -PythonPath "C:\path\to\pythonw.exe"
#   powershell -ExecutionPolicy Bypass -File .\install-relay.ps1 -InstallDir "D:\dsh-relay"
#   powershell -ExecutionPolicy Bypass -File .\install-relay.ps1 -Uninstall
#
# No administrator rights required.

param(
    [string]$PythonPath = "",
    [string]$InstallDir = "$env:LOCALAPPDATA\dsh-relay",
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'dsh-relay'
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition

if ($Uninstall) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    $conn = Get-NetTCPConnection -LocalPort 7864 -State Listen -ErrorAction SilentlyContinue
    if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }
    Write-Host "[OK] task '$TaskName' removed; files left in $InstallDir" -ForegroundColor Green
    return
}

# 1) locate pythonw.exe (runs without a console window)
if (-not $PythonPath) {
    $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $cand = Join-Path (Split-Path $cmd.Source) 'pythonw.exe'
        if (Test-Path $cand) { $PythonPath = $cand }
    }
}
if (-not $PythonPath) {
    foreach ($v in @('Python313','Python312','Python311','Python310')) {
        $cand = "$env:LOCALAPPDATA\Programs\Python\$v\pythonw.exe"
        if (Test-Path $cand) { $PythonPath = $cand; break }
    }
}
if (-not $PythonPath -or -not (Test-Path $PythonPath)) {
    Write-Host "[FAIL] pythonw.exe not found. Install Python 3, or pass -PythonPath explicitly." -ForegroundColor Red
    Write-Host "       e.g. .\install-relay.ps1 -PythonPath 'C:\Python311\pythonw.exe'"
    exit 1
}
Write-Host "[1/4] interpreter: $PythonPath"

# 2) copy files into the install dir (skip if already running from there)
$inPlace = $false
if (Test-Path $InstallDir) {
    if ((Resolve-Path $here).Path -eq (Resolve-Path $InstallDir).Path) { $inPlace = $true }
}
if (-not $inPlace) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    foreach ($f in 'proxy.py','verify.py','policy-sys.txt','policy-tail.txt','ov-mode.txt','README.md','INSTALL.md') {
        if (Test-Path (Join-Path $here $f)) { Copy-Item (Join-Path $here $f) $InstallDir -Force }
    }
    Write-Host "[2/4] files copied to $InstallDir"
} else {
    Write-Host "[2/4] running from install dir, skip copy"
}

$proxy = Join-Path $InstallDir 'proxy.py'
if (-not (Test-Path $proxy)) {
    Write-Host "[FAIL] proxy.py missing in $InstallDir" -ForegroundColor Red
    exit 1
}

# 3) register task: at-logon + every minute, unlimited runtime, auto restart
$action   = New-ScheduledTaskAction -Execute $PythonPath -Argument "`"$proxy`"" -WorkingDirectory $InstallDir
$tLogon   = New-ScheduledTaskTrigger -AtLogOn
$tRepeat  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
              -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
              -MultipleInstances IgnoreNew `
              -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $tLogon,$tRepeat `
    -Settings $settings -RunLevel Limited -Force | Out-Null
Write-Host "[3/4] scheduled task '$TaskName' registered"

# 4) start it and probe the port
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$listen = Get-NetTCPConnection -LocalPort 7864 -State Listen -ErrorAction SilentlyContinue
if ($listen) {
    Write-Host "[4/4] listening on 127.0.0.1:7864 (pid $($listen.OwningProcess))" -ForegroundColor Green
} else {
    Write-Host "[4/4] port 7864 not listening yet. Check $InstallDir\logs\relay-start.log" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. make sure wb2api is running on 127.0.0.1:7863"
Write-Host "  2. point your client at http://127.0.0.1:7864/v1"
Write-Host "  3. python `"$InstallDir\verify.py`"         (static check)"
Write-Host "  4. python `"$InstallDir\verify.py`" --live  (end-to-end, costs tokens)"
