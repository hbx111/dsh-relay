# install-policy.ps1 —— 把 wb2api 的提示词注入关掉（政策改由 relay 注入）
#
# 背景（2026-11-03 用真实失败请求回放得出，每格 4~6 次）：
#   政策追加在末条 user 消息后   拒绝 0/4   ← 唯一有效
#   政策插成首条 user 消息       拒绝 3/4
#   政策塞进 wb2api 的 system    拒绝 6/6
#   完全没有政策                 拒绝 6/6
#
# 而且 wb2api 的 prompt 注入自己就不稳定：重启后第一次请求 prompt_tokens=1244，
# 之后长期回到 56 —— 说明它并没有每轮都注入。更糟的是它只认「相对 wb2api 目录」
# 的路径：给绝对路径（哪怕文件存在）既不报错也不注入，整整一天政策没到模型。
#
# 结论：wb2api 只当 passthrough 用，政策一律由 relay 追加到末条 user 末尾。
# 本脚本只做一件事：把 config.json 的 prompt.mode 设成 passthrough。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-policy.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-policy.ps1 -NoRestart

param(
    [string]$WbDir = "",
    [switch]$NoRestart,
    # 逃生口：想把政策塞回 wb2api 的 system 槽（不推荐，实测更差）时用
    [ValidateSet("passthrough", "append", "custom")]
    [string]$Mode = "passthrough",
    [string]$PolicyFile = ""
)

$ErrorActionPreference = "Stop"

if (-not $WbDir) { $WbDir = Join-Path $env:LOCALAPPDATA "workbuddy2api" }
$cfgPath = Join-Path $WbDir "config.json"
if (-not (Test-Path $cfgPath)) {
    Write-Host "找不到 $cfgPath" -ForegroundColor Red
    Write-Host "先装 wb2api（本包 wb2api\ 目录里有部署说明），或者用 -WbDir 指定目录。" -ForegroundColor Yellow
    exit 1
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$bak = "$cfgPath.bak-$stamp"
Copy-Item $cfgPath $bak -Force
Write-Host "已备份 config.json -> $(Split-Path -Leaf $bak)" -ForegroundColor DarkGray

# 读：容忍 BOM（本机曾因为 PowerShell 写文件带 BOM，导致 wb2api 读配置失败、账号池清空）
$raw = [IO.File]::ReadAllText($cfgPath, [Text.Encoding]::UTF8)
$raw = $raw.TrimStart([char]0xFEFF)
$cfg = $raw | ConvertFrom-Json

$cfg.prompt.mode = $Mode
if ($Mode -eq "passthrough") {
    Write-Host "prompt.mode = passthrough（wb2api 不再往 system 里塞政策）" -ForegroundColor Green
} else {
    if (-not $PolicyFile) { $PolicyFile = Join-Path $PSScriptRoot "policy-sys.txt" }
    if (-not (Test-Path $PolicyFile)) {
        Write-Host "找不到政策文件：$PolicyFile" -ForegroundColor Red
        exit 1
    }
    # 必须落到 wb2api 目录内并用相对路径，绝对路径会被静默忽略
    $dstDir = Join-Path $WbDir "prompts"
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
    $body = [IO.File]::ReadAllText((Resolve-Path $PolicyFile).Path, [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText((Join-Path $dstDir "relay-policy.txt"), $body, (New-Object System.Text.UTF8Encoding($false)))
    $cfg.prompt.file = "prompts/relay-policy.txt"
    Write-Host "prompt.mode = $Mode，file = prompts/relay-policy.txt" -ForegroundColor Yellow
    Write-Host "注意：实测这条路 6/6 被拒，只在排查时用。" -ForegroundColor Yellow
}

# 写：不带 BOM。BOM 会让 wb2api 的 Go JSON 解析失败，回落到默认配置（账号池全空）
$json = $cfg | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "config.json 已写入（无 BOM）" -ForegroundColor Green

if ($NoRestart) {
    Write-Host "`n按 -NoRestart，没动进程。手动重启 wb2api 后生效。" -ForegroundColor Yellow
    exit 0
}

$p = Get-Process wb2api -ErrorAction SilentlyContinue
if ($p) {
    $p | Stop-Process -Force
    Write-Host "已结束 wb2api，watchdog 会在一分钟内拉起它。" -ForegroundColor Yellow
} else {
    Write-Host "wb2api 当前没在跑；watchdog 拉起时会读到新配置。" -ForegroundColor Yellow
}

Write-Host @"

验证（等一分钟再看）：
  python verify.py --live
  期望：'relay 侧 user 尾部政策注入 开启' + '端到端 prompt_tokens≈1240'
  如果 pt 只有 56 左右，说明 relay 没注入，检查 DSH_RELAY_NO_SYSPOLICY 或 policy-sys.txt。
"@ -ForegroundColor Cyan
