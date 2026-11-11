# workbuddy2api —— Windows 一键安装（不需要管理员）
# 用法：右键「使用 PowerShell 运行」，或在 PowerShell 里执行：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$dst  = Join-Path $env:LOCALAPPDATA 'workbuddy2api'
$task = 'workbuddy2api'
$port = 7863

Write-Host "[1/6] 安装到 $dst"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Get-Process wb2api -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Copy-Item (Join-Path $here '*') $dst -Recurse -Force

Write-Host "[2/6] 注册登录自启任务（任务计划程序）"
$vbs = Join-Path $dst 'run-hidden.vbs'
$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"') -WorkingDirectory $dst
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Description 'WorkBuddy2API 中转（CodeBuddy -> OpenAI 兼容网关）' -Force | Out-Null

Write-Host "[3/6] 启动"
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WorkingDirectory $dst
Start-Sleep -Seconds 5

Write-Host "[4/6] 放行防火墙 7863（需要管理员，失败不影响本机）"
try {
    if (-not (Get-NetFirewallRule -DisplayName 'workbuddy2api 7863' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName 'workbuddy2api 7863' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private,Domain -ErrorAction Stop | Out-Null
    }
    Write-Host '  已放行（专用/域网络）'
} catch { Write-Host '  跳过：需要管理员权限' }

Write-Host "[5/6] 健康检查"
try {
    $r = Invoke-RestMethod "http://127.0.0.1:$port/healthz" -TimeoutSec 10
    Write-Host ("  " + ($r | ConvertTo-Json -Compress -Depth 5))
} catch { Write-Host "  未响应：$_" ; Write-Host "  看日志：$dst\logs\" }

Write-Host "[6/6] 完成"
Write-Host "  面板  http://127.0.0.1:$port/panel/"
Write-Host "  接口  http://127.0.0.1:$port/v1"
Write-Host "  局域网/ZeroTier 访问：把 127.0.0.1 换成本机 IP"
