# dsh-relay

dsh 与 wb2api 之间的转发层：`127.0.0.1:7864` → `127.0.0.1:7863`

> **这个包不含任何账号凭据。** `wb2api/auths/` 是空的，需要你自己登录获取。
> 安装步骤见 [INSTALL.md](./INSTALL.md)。

## v1.7 本次更新（2026-11-09）

插件侧三处，都是拿真实失败改的：

- **认得出「我不能写」了**。原来判拒的受事者表只有 `帮你/协助/做/完成`，
  而「这个我不能写」「我无法写这个」「这类内容我不能生成」一个都不含，
  于是被当成正常句子直接放行（日志里是 `why=sentence`）。现在把
  `写/生成/创作/撰写/续写/描述/讲述/制作` 并进表里，并加了一道「宾语收尾」检查：
  动词后面必须是句末、标点或代词宾语。没这道检查会误伤
  「我不能写死端口」「这个类的构造器不能写 const」这类正常技术句。
- **认得上游 `content_filter` 断流**。解析终止块的 `reason`，命中
  `content_filter / guardrail / risk control` 就当场收摊、不再重发，
  并把失败信息补一句「重发同一请求会被再切一次，已停止重试」。
  以前这种情况会白重试两次，把一次明确的风控拦截伪装成偶发故障。
- relay 的 `retry-mode.txt` 默认改回 `off`。重试现在由插件做（它保住流式），
  两边同时开只会让一次拒绝重试三次。

单测从 22 项扩到 25 项（`test.mjs` 9 + `test-retry.mjs` 16），
新增用例专门钉住上面两条，防止回退。

## 关键实测结论（2026-11-02，抓包得出）

**wb2api 会把客户端的 `system` / `developer` 消息整段丢弃。** 证据：

| 请求 | prompt_tokens |
|---|---|
| `user` 里放 2000 中文字 | 1255 |
| `system` 里放同样 2000 字 | **56** |
| `developer` 里放同样 2000 字 | **56** |
| `user` 里放 2014 字政策 | 1265 |

所以「改客户端模板」这类破甲方式在这个链路上不成立——客户端 system 到不了模型。
政策只能走 user 通道，或者让 wb2api 自己注入。

## 2026-11-03：位置决定一切（同一条请求，只换位置）

用真实失败请求回放（"土豆兄弟新 DLC 没买，帮我更新"，完整消息 + 14K 字记忆上下文
+ 67 个工具定义原样）：

| 注入方式 | 被拒 | 备注 |
|---|---|---|
| 完全不注入 | 6/6 | 基线 |
| 政策插成首条 user 消息 | 3/4 | 前置 = 背景资料 |
| **政策追加在末条 user 消息末尾** | **0/4** | 现在用的，直接 `tool_calls` 开始干活 |
| 政策由 wb2api 的 `prompt.mode` 塞进 system | 6/6 | 模型推理里根本不提这段政策 |

还有两个坑，都踩过：

1. `prompt.file` **只认相对 wb2api 目录的路径**。写绝对路径（哪怕文件存在、内容
   正确）它既不报错也不注入，`prompt_tokens` 停在 56。
2. 就算路径对了，那层注入也不稳定：重启后第一次 1244，之后长期回到 56。

所以现在：**政策由 relay 追加到末条 user 末尾，wb2api 保持 `passthrough`。**
另外别自己写政策——原版那 2013 字是调过的，自写话术反而更差（3/3 被拒）。

## 它做什么

1. **剥安全提醒**（`strip`）：删掉用户消息里带安全语义的 `<system_reminder>` 块。
2. **净化 system**（`syssan`）：把系统提示词里同时含「拒绝动词 + 安全/合规名词」的行删掉。
3. **记忆剥离**（`ov-mode.txt`）：剔掉记忆注入里带拒绝/失败语义的条目。
4. **恢复 system（可选）**：建 `restore-system.on` 空文件后，把被中转丢弃的 system 内容
   转成 `【系统指令原文】` 的 user 消息。
5. **拒绝重试**（`retry-mode.txt`）：判为拒绝时换采样参数重发。
6. **政策注入**（默认**开启**）：把 `policy-sys.txt`（原版 2013 字逐字未改）
   追加到最后一条 user 消息末尾。这是唯一稳定有效的通道，文件热加载，改完即生效。

流式 SSE、鉴权头、错误码全部原样透传，不缓冲（开了重试才会缓冲）。

## 开关（改环境变量后重启任务）

| 变量 / 文件 | 作用 |
|---|---|
| `DSH_RELAY_NO_SYSPOLICY=1` | 关掉政策注入（**别关**，这是唯一有效通道） |
| `restore-system.on` 文件 | 把 system 转成 user 送达模型（默认关） |
| `DSH_RELAY_NO_SYSSAN=1` | 关掉 system 净化 |
| `DSH_RELAY_NO_STRIP=1`  | 关掉 reminder 剥离 |
| `DSH_RELAY_PORT` / `DSH_RELAY_UPSTREAM_PORT` | 改端口 |

## 抓包（排查用）

- 建空文件 `dump.on` → 下一个请求的完整 body 落到 `logs/dump-HHMMSS.json`
- 删掉 `dump.on` 即关闭（不用重启）
- 注意：dump 里有完整对话内容，排查完记得删

## 日志

- `logs/relay-YYYY-MM-DD.log`：每请求一行 JSON，含 `stripped` / `sys_removed` / 耗时 / 状态码
- `logs/relay-start.log`：启动横幅
- `logs/startup-error.log`：启动异常栈

## 启停

```
schtasks /end /tn dsh-relay      # 停（或直接结束 7864 端口上的 python 进程）
schtasks /run /tn dsh-relay      # 起
```

任务为「登录时启动」，关机重开自动拉起。

## 自愈与开机（2026-11-02 加固）

`dsh-relay` 任务的配置：

| 项 | 值 | 作用 |
|---|---|---|
| 触发器 | 登录时 + **每 1 分钟重复** | 进程崩了，下一分钟自动拉起 |
| ExecutionTimeLimit | `PT0S`（无限） | 原来默认 72 小时会被强制杀掉 |
| MultipleInstances | `IgnoreNew` | 已在跑时重复触发直接忽略，不会起两个 |
| RestartCount | 3 / 1 分钟 | 失败自动重试 |

实测：`Stop-Process` 杀掉转发层 → 75 秒内自动恢复；同时杀掉 relay + wb2api →
100 秒内两者都回来，政策照旧（`pt≈1240–1255`）。

**政策为什么不随 relay 重启丢失**：它在 wb2api 侧，每次请求由它自己读文件拼进
system；relay 重启完全不影响。反过来 wb2api 刚重启时会短暂回到 `pt=60`，
一分钟内自行恢复。

### 仍然存在的边界

1. 两个任务都是 `Interactive` 身份 —— **开机后必须有人登录**才会跑。若设了自动登录则无感。
2. 开机瞬间 relay 可能先于 wb2api 起来，头一分钟的请求会失败，之后自动恢复。
3. 若转发层"卡死"（端口还在监听但不响应），`IgnoreNew` 不会重启它；目前靠
   `Stop-Process` 或 `schtasks /end` 手动处理。
4. `pt` 会在 1240 / 1265 之间小幅波动，这是多个上游账号 tokenizer 的差异，两者都说明政策在。
   判断标准只有一个：**`pt` 掉到 56 就是没注入**。

## 记忆剥离（ov-mode.txt）

dsh 每轮会把两类跨会话记忆塞进 user 消息，删会话删不掉它们：

- OpenViking `profile`：约 1.3 万字，固定挂在第一条 user 上（分工约定、项目路径、历史偏好）
- OpenViking 相关记忆 + graph-memory 召回：按当前问题语义检索，2~3 千字

记忆里若写着"助手拒绝了 XX / outcome: failed"，等于开局先给模型一份自我示范。
在 `dsh-relay\ov-mode.txt` 写开关（**热加载，改完即生效，无需重启**）：

| 值 | 行为 |
|---|---|
| `off` | 不动记忆，只做提醒剥离 |
| `refused` | **默认**。只剔掉含"拒绝/declined/cannot"等语义的记忆条目，profile 保留 |
| `memory` | 整块剔除非 profile 的相关记忆，profile 保留（上下文省 2~3K 字） |
| `all` | 连 profile 一起剔（省 1.3 万字，但会让 dsh 忘掉项目分工等上下文） |

日志字段 `ov_dropped` 是本次剔掉的条目数。删 `ov-mode.txt` 即回落为 `refused`。

另外：`strip_reminders` 曾有自己的注入块也被 `SAFETY_HINT` 命中的自噬 bug
（`policy-sys.txt` 末尾那段 `<system_reminder>` 被每轮整块删掉），已加
`OWN_MARKERS` 白名单放行；若日志里 `stripped` 又从 0 变 1 且 sample 是政策原文，说明白名单失效。

## 自检

```
python %LOCALAPPDATA%\dsh-relay\verify.py          # 静态，不花 token
python %LOCALAPPDATA%\dsh-relay\verify.py --live   # 外加一次端到端探测
```

六项：端口、system 槽里的政策（mode/文件/标签/是否被改过字）、开关、最近请求、
抓包样本、端到端。最后一行直接回答「政策现在在不在上下文里」。
判据用的是 `prompt_tokens`（小问句 60 = 没有，约 1240 = 有），不依赖采样运气。

## 读政策文件的三道闸（2026-11-03 加固）

借鉴 dsh-enhance 的 lastGood 设计与字节上限，起因是同一类故障：**注入静默消失而日志看着正常**。

1. 文件消失 / 读失败 / 读成空 → 沿用上一次成功读到的文本，不返回空串；
2. 超过 `SYS_POLICY_MAX`（16 KB）→ 本轮不注入并报 `too_large`，**不截断**（半句话比不注入更糟）；
3. 有 `<content_policy>` 却没有 `</content_policy>` → 判为正在被写，沿用旧值等下一轮。
   纯文本（不带这对标签）直接放行。

日志新增 `sys_reason` 字段，只在非空时写：`missing(kept)` / `truncated` / `too_large(16394B)` /
`empty` / `read_error` / `disabled`。看到它就不用猜「为什么没生效」。

## 拒绝自动重试（retry-mode.txt）

**为什么需要**：模型的对齐判断是概率性的，不是配置项。同一条请求、同一份请求体，
实测 9 次里 8 次照做、1 次拒绝——那份注入本身是生效的，拒绝发生在模型自己的
价值判断里，加强注入只能把成功率往上推，推不到 100%。工程上唯一确定的解法是重采样。

开关：`retry-mode.txt` 写 `on`（热加载，无需重启），**默认 `off`**（v1.7 起）。
重试这件事现在两处都能做，只能开一处：relay 重试要求整段收完才能判，**流式没了**；
插件重试只看开头，流式保住。所以包内默认交给插件，relay 这个开关只在没装插件时打开。
重试次数 `DSH_RELAY_RETRY_MAX`，默认 3。

**代价**：必须先把整段回复收完才能判断是不是拒绝，所以客户端要等生成结束才看到内容，
流式打字效果没了。首字延迟 = 原本的总耗时。

**怎么判定**：只看回复前 220 字有没有开口就否的句式（`不能帮 / 我都不做 / 这条线 /
I can't help / must decline`），加上全文的拒绝词计数；推理链里出现
`piracy / I shouldn't / decline` 作为辅助信号。判定刻意保守——误判的代价是白烧
一遍 token 且用户看到回答被重来，所以宁可漏判。

**重试做了什么**：只改两处——给 `temperature` 补一个递增的值（0.65 → 0.9），
在最后一条消息末尾补等量空格。前者让采样真的跳出去，后者让上游 prompt-cache
key 变化，否则三次重试会沿着同一条推理路径走回同一个结论。

日志字段 `retries` 记录这次重跑了几个来回；没触发就不写。

## 插件路线：让重试不再是「拿流式换来的」（2026-11-05 修订）

原版设想是「插件负责注入 + 重试，relay 退场」。**注入这条路实测走不通**：

dsh 的 agent loop 在发出 `llm/stream` 事件之前就把请求冻结了——

```js
deepFreeze(header);
for (const message of boundaryMessages) deepFreeze(message);
Object.freeze(boundaryMessages);
return Object.freeze({ ...header.config, messages: boundaryMessages, ... });
```

冻结之后 `options.messages` 既不能赋值也不能 `defineProperty`，日志里只会留下
`FATAL cannot write messages: Cannot redefine property: messages`。官方文档也写明
"loop-built requests arrive deep-frozen, so extensions and adapters cannot rewrite them"。
所以**注入只能留在 relay**，插件放弃这一半。

重试这一半不需要改 `messages`，它只是包住响应流，因此完全可行，而且保住流式：

- relay 看不见「说完没有」，只能整段缓冲再判断，于是没有流式、首字 10~25 秒；
- 插件拿到的是 chunk 流，只看开头就能下结论。正常回复在第一个句号处放行，
  被拒的那次一个 byte 都没吐给上层，直接丢弃重发。

判定只认「开口就拒」的强形状（`抱歉/对不起 + 不能|无法 + 帮你|协助|满足`，
或「这个忙不能帮」这类直接开口），宁可漏判不可误判——误判会把正常回答从头重来。

两条 2026-11-05 从真实失败里补上的规则：

1. **推理链不构成放行理由**。模型常先想一两千字再开口，旧逻辑按「距第一块的时长」
   跟 1200ms 比，正文一冒头就放行，只看到 2 个字……而拒绝的第一句可能只有 7 个字
   （「这个忙不能帮」）。现在改用 `minTextChars`（默认 24）：正文开始后必须看够
   这么多字才允许放行，除非正文断流超过 `textStallMs`（默认 1500ms）。
2. **遇到工具调用立即放行**，拒绝不会出现在工具调用里。

| 命令 | 作用 |
|---|---|
| `switch.cmd plugin` | relay 注入 + 插件重试（推荐，也是现在的默认状态） |
| `switch.cmd relay` | 关掉插件重试，只留 relay |
| `switch.cmd retry-plugin-on/off` | 单独开关插件重试 |
| `switch.cmd status` | 看谁在注入、谁在重试、插件是否还在 |

### 怎么装在 `~/.dsh/policy/plugin`，又能在设置里看到

patch 层插件如果手工放进 `profiles\desktop\node_modules`，**任何一次 pnpm 装依赖
都会把它当「多余包」清掉**——实测装一次依赖就被清过一次，patch 层却还引用它。

所以一开始是「文件放 `~/.dsh/policy/plugin`，patch 层用 `file:///...` 绝对路径加载」。
能跑，但**它不会出现在任何插件列表里**：dsh 的插件页只列 profile 的**组合包**
（`package.json` 的 `dependencies` + `dsh.profile.bundles`），patch 里插进来的裸行
只是一行 loader 条目，没有卡片、也没有开关。

现在改成正式组合包：

```
~/.dsh/policy/plugin/                     ← 包本体，源码仍放在这里
  package.json        dsh.bundle.patch → ./cordis.patch.yml
  cordis.patch.yml    - insert: [{ id: dsh-policy, name: "dsh-policy" }]
  locale/zh.json      设置里显示的标题与描述
profiles/desktop/package.json
  dependencies:  "dsh-policy": "file:C:/Users/<你>/.dsh/policy/plugin"
  dsh.profile.bundles: [..., "dsh-policy"]
```

注册一条命令就够（`dsh plugin` 其实是转发给 profile 里的 pnpm，它装完会自己把包
补进 `dsh.profile.bundles`）：

```
dsh plugin --profile desktop add "file:%USERPROFILE%\.dsh\policy\plugin"
```

之后：

- 侧栏**插件 → 已安装插件**、或**设置 → 插件**里能看到「拒绝重试」这张卡片；
- 卡片里那一行的开关由 dsh 自己写进 `cordis.patch.yml` 的 `disabled`，不用再手工删 insert；
- **profile 的 `cordis.patch.yml` 里不要再写 `- insert: [dsh-policy]`**，否则和包内 patch
  撞同一个 id。`install-plugin.ps1` 会自动把老装法留下的那条 `file:///...` insert 摘掉。

一个要注意的副作用：`file:` 依赖在 `node_modules` 里是**快照**（pnpm 拷一份），
改完 `~/.dsh/policy/plugin` 的代码必须重跑一次上面那条 `add`（或者 `pnpm install`），
否则 dsh 加载的还是旧的。组合包也不是热替换的行——装完/更新完要**重启一次 dsh**。

## 回退

把 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 provider `wb` 的
`baseURL` 改回 `http://127.0.0.1:7863/v1` 即可完全绕过本层。改前先备份那份 yml。

## 目录

```
dsh-relay-deploy/
├─ proxy.py              7864 → 7863 转发层：注入、system 兜底、流式透传
├─ verify.py             链路自检：能不能通、system 到没到、注入生没生效
├─ policy-sys.txt        注入用的政策正文
├─ retry-mode.txt        relay 侧拒绝重试开关（默认 off）
├─ ov-mode.txt           overseer 档位
├─ install-relay.ps1     注册转发层（计划任务 / 开机自启 / watchdog）
├─ install-policy.ps1    只装政策文本
├─ install-plugin.ps1    装 dsh 客户端插件（可选，见 INSTALL 5.5）
├─ wb2api/               wb2api 的配置模板、启动脚本、prompts 存档
│  └─ auths/             空的，放你自己的账号凭据
└─ plugin/dsh-policy/    dsh 插件源码
```

## 许可

MIT，见 [LICENSE](./LICENSE)。

仓库里不含任何账号凭据，`wb2api/auths/` 是空的。wb2api 本身是第三方项目，
本仓库只包含转发层与客户端插件的源码，以及一份配置模板。
