# workbuddy2api watchdog
# Keeps the gateway alive. Runs from Task Scheduler every minute.
# - process missing            -> start it
# - process alive but unhealthy -> count failures, restart after 3 consecutive
$ErrorActionPreference = 'SilentlyContinue'

$dir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$logD  = Join-Path $dir 'logs'
$log   = Join-Path $logD 'watchdog.log'
$state = Join-Path $dir 'data\watchdog-fails.txt'
$port  = 7863

if (-not (Test-Path $logD))  { New-Item -ItemType Directory -Force -Path $logD  | Out-Null }
if (-not (Test-Path (Split-Path $state))) { New-Item -ItemType Directory -Force -Path (Split-Path $state) | Out-Null }

function Write-Log([string]$msg) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
    Add-Content -Path $log -Value $line
}

function Start-Gateway {
    $vbs = Join-Path $dir 'run-hidden.vbs'
    if (-not (Test-Path $vbs)) { Write-Log 'FATAL: run-hidden.vbs missing'; return $false }
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WorkingDirectory $dir
    Start-Sleep -Seconds 6
    $p = Get-Process wb2api -ErrorAction SilentlyContinue
    if ($p) {
        Write-Log ('STARTED pid=' + (($p | Select-Object -ExpandProperty Id) -join ','))
        return $true
    }
    Write-Log 'START FAILED: no wb2api process after launch'
    return $false
}

# keep the log bounded
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 2MB)) {
    Remove-Item $log -Force -ErrorAction SilentlyContinue
}

$proc = Get-Process wb2api -ErrorAction SilentlyContinue

if (-not $proc) {
    Write-Log 'process absent -> starting'
    $null = Start-Gateway
    Remove-Item $state -Force -ErrorAction SilentlyContinue
    exit 0
}

# process is alive - probe health
$healthy = $false
try {
    $r = Invoke-RestMethod ("http://127.0.0.1:" + $port + "/healthz") -TimeoutSec 8
    if ($null -ne $r -and [int]$r.healthy -ge 1) { $healthy = $true }
} catch { }

if ($healthy) {
    Remove-Item $state -Force -ErrorAction SilentlyContinue
    exit 0
}

$fails = 0
if (Test-Path $state) { $fails = [int]((Get-Content $state -Raw).Trim()) }
$fails++
Set-Content -Path $state -Value $fails -Force
Write-Log ('unhealthy (consecutive=' + $fails + ')')

if ($fails -ge 3) {
    Write-Log 'restarting unresponsive gateway'
    Get-Process wb2api -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    $null = Start-Gateway
    Remove-Item $state -Force -ErrorAction SilentlyContinue
}

exit 0
