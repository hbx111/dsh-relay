# 安装 dsh-policy 插件：把政策注入搬到 dsh 进程内（llm/stream 钩子）。
#
# 与 relay 注入的区别：插件改的是结构化 messages，不碰响应流，所以**不影响流式**。
# 代价是装上之后必须重启一次 dsh 才会加载；relay 那边可以热切换。
#
#   install-plugin.ps1            安装并提示重启
#   install-plugin.ps1 -Activate  安装后立刻把路线切到插件（relay 停注入 + 关重试）
#   install-plugin.ps1 -Uninstall 卸载（还原 patch、留数据和日志）
#   install-plugin.ps1 -SkipTests 跳过单测（test-retry 会临时改写 ~/.dsh/policy/config.json，跑完还原）
param(
    [switch]$Activate,
    [switch]$Uninstall,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object Text.UTF8Encoding($false)

$home_ = $env:USERPROFILE
$profileDir = Join-Path $home_ '.dsh\profiles\desktop'
$dataDir = Join-Path $home_ '.dsh\policy'
# 插件放数据目录下，patch 层按绝对路径加载：pnpm 装依赖时会把 node_modules 里
# 不属于任何 dependencies 的包当多余项清掉（2026-11-05 实测被清过一次）
$plugDir = Join-Path $dataDir 'plugin'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$dshCmd = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'

$src = Join-Path $PSScriptRoot 'plugin\dsh-policy'
if (-not (Test-Path $src)) { $src = $PSScriptRoot }   # 在插件目录里直接跑
if (-not (Test-Path (Join-Path $src 'index.js'))) { throw "找不到 index.js：$src" }

if ($Uninstall) {
    # 先摘掉组合包：这一步会把 dsh-policy 从 dependencies 和 dsh.profile.bundles 里移除
    if (Test-Path $dshCmd) {
        & $dshCmd plugin --profile desktop remove dsh-policy | Out-Host
    }
    if (Test-Path $plugDir) { Remove-Item $plugDir -Recurse -Force }
    if (Test-Path $patchFile) {
        $lines = [IO.File]::ReadAllLines($patchFile, [Text.Encoding]::UTF8)
        $kept = @()
        $skip = 0
        foreach ($line in $lines) {
            if ($line -match '^\s*-\s*insert:\s*$') { $skip = 1; $pending = @($line); continue }
            if ($skip -gt 0) {
                $pending += $line
                if ($line -match 'dsh-policy') { $skip = 2; $pending = @(); continue }
                if ($line -match '^\s*-\s') { $kept += $pending; $skip = 0; $pending = @(); continue }
                continue
            }
            $kept += $line
        }
        if ($skip -eq 1 -and $pending) { $kept += $pending }
        [IO.File]::WriteAllText($patchFile, ($kept -join "`r`n") + "`r`n", $utf8NoBom)
    }
    Write-Host '插件已卸载（~/.dsh/policy 下的政策、配置、日志保留）。重启 dsh 生效。' -ForegroundColor Yellow
    return
}

# 1. 插件本体
New-Item -ItemType Directory -Force -Path $plugDir | Out-Null
foreach ($f in 'index.js', 'package.json', 'cordis.patch.yml') {
    Copy-Item (Join-Path $src $f) (Join-Path $plugDir $f) -Force
}
$locSrc = Join-Path $src 'locale'
if (Test-Path $locSrc) {
    New-Item -ItemType Directory -Force -Path (Join-Path $plugDir 'locale') | Out-Null
    Copy-Item (Join-Path $locSrc '*.json') (Join-Path $plugDir 'locale') -Force
}

# 2. 数据目录：政策原文 + 开关 + 切换脚本
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$policyDst = Join-Path $dataDir 'policy-sys.txt'
if (-not (Test-Path $policyDst)) {
    $policySrc = Join-Path $PSScriptRoot 'policy-sys.txt'
    if (Test-Path $policySrc) { Copy-Item $policySrc $policyDst -Force }
    else { throw "找不到 policy-sys.txt，无法安装政策原文" }
}
$cfgPath = Join-Path $dataDir 'config.json'
if (-not (Test-Path $cfgPath)) {
    $cfgJson = @(
        '{'
        '  "mode": "off",'
        '  "onlyAgentLoop": true,'
        '  "log": true,'
        '  "retry": {'
        '    "enabled": false,'
        '    "maxRetries": 2,'
        '    "peekChars": 200,'
        '    "peekMs": 1200,'
        '    "minTextChars": 24,'
        '    "textStallMs": 1500,'
        '    "backoffMs": 350'
        '  }'
        '}'
    ) -join "`r`n"
    [IO.File]::WriteAllText($cfgPath, $cfgJson + "`r`n", $utf8NoBom)
}
foreach ($f in 'switch.mjs') {
    $p = Join-Path $src $f
    if (Test-Path $p) { Copy-Item $p (Join-Path $dataDir $f) -Force }
}
$cmdBody = "@echo off`r`nchcp 65001 >nul`r`nnode `"%~dp0switch.mjs`" %*`r`nif `"%~1`"==`"`" pause`r`n"
[IO.File]::WriteAllText((Join-Path $dataDir 'switch.cmd'), $cmdBody, $utf8NoBom)

# 3. 注册成 profile 组合包 —— 只有这样 dsh「设置 → 插件」里才会出现这一项（带开关）。
#    开关状态由 dsh 自己写进 cordis.patch.yml 的 disabled，脚本不再碰那个文件。
if (-not (Test-Path $dshCmd)) { throw "找不到 dsh.cmd：$dshCmd（dsh 不是装在默认位置？）" }

# 老装法在 profile patch 里塞过一条 file:// 的 insert，会和组合包 patch 撞同一个 id，先摘掉
if (Test-Path $patchFile) {
    $lines = [IO.File]::ReadAllLines($patchFile, [Text.Encoding]::UTF8)
    if (($lines -join "`n") -match 'policy/plugin/index\.js') {
        $kept = @()
        $skip = 0
        $pending = @()
        foreach ($line in $lines) {
            if ($skip -eq 0) {
                if ($line -match '^\s*-\s*insert:\s*$') { $skip = 1; $pending = @($line); continue }
                $kept += $line
                continue
            }
            $pending += $line
            if ($line -match 'dsh-policy') { $skip = 2; $pending = @(); continue }
            if ($line -match '^\s*-\s') { $kept += $pending; $skip = 0; $pending = @(); continue }
        }
        if ($skip -eq 1 -and $pending) { $kept += $pending }
        [IO.File]::WriteAllText($patchFile, ($kept -join "`r`n") + "`r`n", $utf8NoBom)
        Write-Host '已从 cordis.patch.yml 摘掉旧的 file:// insert' -ForegroundColor Yellow
    }
}

$spec = 'file:' + ($plugDir -replace '\\', '/')
& $dshCmd plugin --profile desktop add $spec | Out-Host
if ($LASTEXITCODE -ne 0) { throw "注册组合包失败，pnpm 退出码 $LASTEXITCODE" }
Write-Host "已注册组合包 dsh-policy（$spec）" -ForegroundColor Green

# 4. 自检（在包里跑：包目录同时有 index.js 和两份单测，装好的目录只需要运行时代码）
if (-not $SkipTests) {
    Push-Location $src
    try {
        if (Test-Path (Join-Path $src 'test.mjs')) {
            Write-Host '跑单测…'
            node test.mjs
        }
        if (Test-Path (Join-Path $src 'test-retry.mjs')) {
            Write-Host '跑重试单测…'
            node test-retry.mjs
        }
    } finally { Pop-Location }
}

Write-Host ''
Write-Host '装好了。' -ForegroundColor Green
Write-Host "  插件目录 : $plugDir"
Write-Host "  数据与开关: $dataDir"
Write-Host '  dsh 里看 : 侧栏「插件」→ 已安装插件，或 设置 → 插件；那一行的开关会写进 cordis.patch.yml'
if ($Activate) {
    Push-Location $dataDir
    try { node switch.mjs plugin } finally { Pop-Location }
}
Write-Host ''
Write-Host '组合包要重启一次 dsh 才会挂上（不是一个能被热替换的行）。之后切路线不用再重启：' -ForegroundColor Yellow
Write-Host "  $dataDir\switch.cmd status"
