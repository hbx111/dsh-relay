# 安装指南

链路：

```
客户端(DSH / 任意 OpenAI 兼容客户端)
        │  baseURL = http://127.0.0.1:7864/v1
        ▼
   dsh-relay :7864        ← 本包主体：剥离安全提醒 / 记忆剥离 / 拒绝重试
        │
        ▼
   wb2api :7863           ← 上游中转：账号池 / 指纹清洗（政策不归它管）
        │
        ▼
     上游服务
```

两层都可以独立使用：只装 wb2api 也能跑；relay 负责把客户端塞进来的安全提醒剥掉。

**政策（那段 `<content_policy>`）由 relay 追加到末条 user 消息末尾，wb2api 保持
`passthrough`。** 这不是偏好，是拿真实失败请求回放测出来的（每格 4~6 次）：

| 政策放在哪 | 被拒 |
|---|---|
| 末条 user 消息末尾 | **0/4**，直接 `tool_calls` 开始干活 |
| 首条 user 消息 | 3/4 |
| wb2api 的 `prompt.mode` 塞进 system | 6/6（模型推理里根本不提这段） |
| 完全没有政策 | 6/6 |

顺带两个坑：wb2api 的 `prompt.file` **只认相对它自己目录的路径**，写绝对路径时
不报错也不注入（`prompt_tokens` 停在 56）；而且它的注入本身不稳定，重启后第一次
生效、之后又失效。所以别让它掺和。

---

## 0. 包里有什么

| 文件 | 作用 |
|---|---|
| `proxy.py` | relay 主程序 |
| `verify.py` | 自检脚本（静态 6 项 + 可选端到端） |
| `policy-sys.txt` | 政策文本，原版 2013 字逐字未改，约 5.3 KB |
| `install-policy.ps1` / `.cmd` | 把 wb2api 的 `prompt.mode` 恢复成 `passthrough` |
| `ov-mode.txt` | 记忆剥离档位，默认 `refused` |
| `retry-mode.txt` | relay 侧拒绝重试开关，包内默认 `off`（重试归插件做） |
| `install-relay.ps1` / `.cmd` | 一键注册计划任务 |
| `install-plugin.ps1` / `.cmd` | 装 dsh 侧插件（注入 + 有流式的重试，见 5.5） |
| `plugin/dsh-policy/` | 插件源码：`index.js` / `package.json` / `cordis.patch.yml` / `locale/` / `switch.mjs` / 两份单测 |
| `wb2api/` | wb2api 的配置模板、启动脚本、五份政策文本 |
| `wb2api/auths/` | **空的**，放你自己的账号凭据 |

包里**没有任何账号凭据、API Key、用户名或绝对路径**。

## 1. 前置

- Windows 10 / 11
- Python 3.9+（`python --version` 能跑就行），装在 PATH 里最好
- 一个能用的上游账号
- 不需要管理员权限（除防火墙放行 7863 那一步）

## 2. 先装 wb2api

把 `wb2api\` 整个目录解压到任意位置，进去执行：

```
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

它会复制到 `%LOCALAPPDATA%\workbuddy2api`、注册登录自启任务、后台启动、尝试放行防火墙。

然后**两件必做的事**：

1. 把 `config.example.json` 复制成 `%LOCALAPPDATA%\workbuddy2api\config.json`，
   把 `api_key` 换成你自己的一串随机字符。
2. `login.exe` 不在包里，需要单独获取后放进安装目录，再用它登录账号
   （面板 `http://127.0.0.1:7863/panel/` 也能加）。

确认起来了：

```
curl http://127.0.0.1:7863/v1/models -H "Authorization: Bearer <你的 api_key>"
```

有返回就往下走。

注意 `config.json` 里的 `"prompt"` 保持原样：`{ "mode": "passthrough" }`。
政策由 relay 注入，wb2api 不该掺和（原因见开头那张表）。

## 2.5 确认 wb2api 不掺和注入

这步只是一道保险，十秒钟。双击 `install-policy.cmd`，或者在终端里：

```
powershell -ExecutionPolicy Bypass -File .\install-policy.ps1
```

它做的事：备份 `config.json` → 把 `prompt.mode` 设成 `passthrough` → 结束 wb2api
进程（watchdog 一分钟拉起）。

- 只想改配置不动进程：`-NoRestart`
- 想在 wb2api 侧也放一份（**不推荐**，实测 6/6 被拒，仅供对照实验）：`-Mode append`

> 写配置时**不能带 BOM**。带 BOM 的 config.json 会让 wb2api 的 Go JSON 解析失败、
> 回落到默认配置，表现是「账号池突然空了、连不上上游」。脚本里已经用
> `UTF8Encoding($false)` 处理过。

## 3. 装 relay

在这个包目录里双击 `install-relay.cmd`，或者在终端里：

```
powershell -ExecutionPolicy Bypass -File .\install-relay.ps1
```

它做四件事：找 `pythonw.exe` → 复制到 `%LOCALAPPDATA%\dsh-relay` → 注册计划任务
`dsh-relay` → 启动并探测 7864。

- 想装到别处：`-InstallDir "D:\dsh-relay"`
- Python 不在标准位置：`-PythonPath "C:\Python311\pythonw.exe"`
- 卸载任务：`-Uninstall`

手动注册也可以（脚本做的就是这套）：

```powershell
$py = "$env:LOCALAPPDATA\Programs\Python\Python311\pythonw.exe"   # 按实际改
$relay = "$env:LOCALAPPDATA\dsh-relay"
$a  = New-ScheduledTaskAction -Execute $py -Argument "`"$relay\proxy.py`"" -WorkingDirectory $relay
$t1 = New-ScheduledTaskTrigger -AtLogOn
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 1)
$s  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "dsh-relay" -Action $a -Trigger $t1,$t2 -Settings $s `
        -RunLevel Limited -Force
Start-ScheduledTask -TaskName "dsh-relay"
```

> `-ExecutionTimeLimit ([TimeSpan]::Zero)` 等于 `PT0S`。少了它任务会在 72 小时后
> 被系统静默杀掉，表现是「用了三天突然不注入了」。
> `-RestartCount 3` 是崩溃自愈。`IgnoreNew` 防止重复触发起两个进程抢端口。

## 4. 让客户端指向 relay

改客户端配置里的 baseURL：

```yaml
baseURL: http://127.0.0.1:7864/v1
```

DSH 的话是 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 provider 的 `baseURL`，
**改前先备份这份 yml**。其它 OpenAI 兼容客户端同理，把端口从 7863 改成 7864 即可。

想临时绕过 relay 直连上游，改回 7863，不用动别的。

## 5. 验证

```powershell
cd $env:LOCALAPPDATA\dsh-relay
python verify.py            # 静态，不花 token
python verify.py --live     # 外加一次真实请求
```

七项：端口、政策文件（大小 / 标签 / 是否被改过字）、wb2api 是否只 passthrough、
开关、最近请求注入率、抓包样本里的位置、端到端。看到这两行就说明通了：

```
✅ 最近 30 次里注入 30 次
✅ 端到端 prompt_tokens=1279（政策在上下文里）
```

判据是 `prompt_tokens` 而不是「模型有没有照做」——政策在不在上下文里，用量数字
最诚实，也不依赖采样运气。`--live` 会花一点 token，它从 wb2api 的 `config.json`
自动取 `api_key`。

## 5.5 可选：把注入和重试都搬进 dsh（插件路线）

relay 注入和插件注入做的是同一件事，**同时只能开一个**。区别只有一句话：

- relay 注入 + relay 重试 = 稳，但**没有流式打字**（必须收完整段才能判断是不是拒绝，
  首字要等 10~25 秒）
- 插件注入 + 插件重试 = **流式正常**（它只改请求、只包住响应流，不看完整段不下结论）

v1.7 起默认走插件：`retry-mode.txt` 是 `off`，重试交给插件。

```
双击 install-plugin.cmd
```

它做四件事：

1. 把插件本体拷到 `%USERPROFILE%\.dsh\policy\plugin`（**不是** profile 的
   `node_modules`——pnpm 装依赖时会把它当多余包清掉，实测被清过一次）；
2. 把政策原文、`config.json`、`switch.mjs`、`switch.cmd` 放到 `%USERPROFILE%\.dsh\policy`；
3. 用官方命令把它注册成 profile 组合包：
   `dsh plugin --profile desktop add "file:…\.dsh\policy\plugin"`。
   **只有组合包才会出现在「设置 → 插件」里**（带开关）；patch 层插一行只在加载器里
   生效，没有任何卡片；
4. 跑 25 项单测（`test.mjs` 9 + `test-retry.mjs` 16）。

> 装之前它会自动摘掉老装法留在 `cordis.patch.yml` 里的那条 `file://` insert——
> 那条和包内 patch 撞同一个 id，会启动报错。你自己也别再手工 insert。

**装完必须重启一次 dsh**（组合包不是一个能被热替换的行）。之后切路线不用再重启：

```
%USERPROFILE%\.dsh\policy\switch.cmd status      现在谁在管
%USERPROFILE%\.dsh\policy\switch.cmd plugin      插件接管（relay 建 syspolicy.off 停注入 + 关重试）
%USERPROFILE%\.dsh\policy\switch.cmd relay       中转接管（插件休眠）
%USERPROFILE%\.dsh\policy\switch.cmd retry-on    只把插件重试打开
```

插件默认 `mode=off`（不注入），装完不会抢 relay 的活；重试由 `config.json` 的
`retry.enabled` 控制。想装完立刻切过去：`install-plugin.cmd -Activate`。
卸载：`install-plugin.cmd -Uninstall`（会跑 `dsh plugin remove`，保留政策、配置和日志）。

> 为什么插件不写 system 槽：wb2api 会整段丢弃 system/developer 消息 —— 塞 2000 字
> system，`prompt_tokens` 从 56 到 56，一个 token 都没涨；同样内容放 user 立刻 182。
> 所以插件也只能往 user 上写，只不过它改的是结构化字段，不靠 HTTP 文本匹配。

装完之后两件容易踩的事：

- 改完 `~\.dsh\policy\plugin` 里的代码，要重跑一次 `install-plugin.cmd`（或
  `dsh plugin --profile desktop add` 同一条命令）。`file:` 依赖在 `node_modules`
  里是快照，不重装还在跑旧代码。
- 插件单测里的 `test-retry.mjs` 会**临时改写** `~\.dsh\policy\config.json` 再还原，
  不想让它碰就跑 `install-plugin.cmd -SkipTests`。

## 6. 常见故障

| 现象 | 原因 | 怎么查 |
|---|---|---|
| 政策写了没效果 | relay 没注入：环境变量 `DSH_RELAY_NO_SYSPOLICY=1`，或 `policy-sys.txt` 读不到 | `python verify.py --live` 看 pt 是不是 56；再看日志里的 `sys_reason` |
| 政策塞进 wb2api 的 system 后 100% 被拒 | 那层注入时灵时不灵，且 system 那份实测 6/6 拒 | 跑 `install-policy.ps1` 恢复成 passthrough |
| 改了 wb2api 的 `prompt.file` 却毫无变化 | 绝对路径被静默忽略 | 用相对路径 `prompts/xxx.txt`，或干脆 passthrough |
| 自己写的「最高优先级」短块反而更差 | 单独用 3/3 被拒，叠加在原版上把 1/8 抬到 4/8 | 别自己写政策，用包里这份原版 |
| config.json 改完账号池空了 / 连不上上游 | 文件带了 BOM，Go 的 JSON 解析失败回落默认配置 | 用 `install-policy.ps1` 重写一遍 |
| 日志 `stripped` 从 0 变 1 且 sample 是政策原文 | 剥离规则误伤（旧版自噬） | 检查 `OWN_MARKERS` 白名单 |
| 偶尔被拒、重发一次就过 | 模型的对齐判断是概率性的，不是配置问题 | 装插件（重试有流式）；只用 relay 时把 `retry-mode.txt` 写成 `on` |
| 开了重试后没有打字效果、要等很久才出内容 | 缓冲模式的固有代价：必须收完整段回复才能判断是否拒绝 | 预期行为；嫌慢就改回 `off`，手动重发 |
| 插件装了没反应 | patch 层没写进去，或者 dsh 没重启过 | `switch.cmd status` 看「插件注入」是否开；`~\.dsh\policy\policy.log` 里有没有 `loaded` |
| 明明只开了一条路线，拒绝率反而变高 | 两条都开着，消息里有两份政策 | `switch.cmd status` 会直接给出警告 |
| 7864 不通 | relay 没起 / 端口被占 | `logs\relay-start.log`、`netstat -ano \| findstr 7864` |
| 7863 不通 | wb2api 没起 / 账号全挂了 | 面板看账号状态 |

日志里每行 JSON 的字段含义：

| 字段 | 含义 |
|---|---|
| `stripped` | 剥掉的 `<system_reminder>` 块数 |
| `sys_removed` | 从 system 里删掉的行数 |
| `sys_injected` | 本轮是否把政策追加到末条 user（应为 1） |
| `sys_reason` | 没注入的原因（disabled / missing / half-written），只在非空时出现 |
| `ov_dropped` | 剔掉的记忆条目数 |
| `ms` / `status` | 耗时与上游返回码 |

抓包：在 `%LOCALAPPDATA%\dsh-relay` 建个空的 `dump.on`，下一个请求的完整 body
落到 `logs\dump-HHMMSS.json`；删掉即停，不用重启。**dump 含完整对话，排查完记得删。**

## 7. 目录

```
dsh-relay\
├─ proxy.py             剥离 / 记忆 / 政策注入 / 重试主程序
├─ verify.py            自检：端口 / 政策 / passthrough / 开关 / 请求 / 位置 / 端到端
├─ policy-sys.txt       原版政策块（2013 字逐字未改）
├─ install-policy.ps1   把 wb2api 恢复成 passthrough（第 2.5 步）
├─ install-policy.cmd   双击即装（绕执行策略）
├─ install-plugin.ps1   装 dsh 插件（可选，见 5.5）
├─ install-plugin.cmd   双击即装
├─ retry-mode.txt       relay 侧重试开关，默认 off
├─ plugin\dsh-policy\  插件源码：index.js / package.json / cordis.patch.yml / locale /
│                       switch.mjs / test.mjs / test-retry.mjs（装完只拷运行时要的）
├─ ov-mode.txt          记忆剥离档位：off / refused / memory / all
├─ install-relay.ps1    注册计划任务
├─ install-relay.cmd    双击即装（绕执行策略）
├─ README.md            设计说明与全部开关
├─ INSTALL.md           本文件
├─ wb2api\              上游中转的配置模板与启动脚本
└─ logs\                运行时生成
```

## 8. 卸载

```powershell
cd $env:LOCALAPPDATA\dsh-relay
powershell -ExecutionPolicy Bypass -File .\install-relay.ps1 -Uninstall
```

客户端 baseURL 改回 7863。wb2api 侧用 `wb2api\uninstall.ps1`。
relay 目录可以直接删，它不写注册表、不装服务。

## 9. 跨机器同步

relay 全部状态都在文件里，拷目录即可迁移。要注意的只有一处：
计划任务的 Action 里写的是 `pythonw.exe` 的绝对路径，换机器路径可能不同，
重跑一次 `install-relay.ps1 -Force` 覆盖任务即可（`-Force` 已内置）。
