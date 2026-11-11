# Linux 部署（systemd）

在 Linux 上**不需要 relay**。Windows 那边之所以多一层 `proxy.py`，是因为本机 wb2api 的
`passthrough` 会整段丢弃客户端 system 消息。Linux 上直接让 wb2api 自己用 `custom` 模式
把政策注入 system 槽就行，少一层转发、少一个故障点。

实测环境：Debian 12 / x86_64 / 腾讯云轻量（2C2G）。

## 前置

- root 权限
- `openssl`（生成 api_key）、`curl`（收尾取公网 IP）
- wb2api 二进制。**上游没有提供 Linux Release**，两种方式拿：
  - 自己构建：`CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o wb2api .`
  - 或从别处拷一个 amd64 静态二进制

## 安装

```bash
sudo ./install.sh --build
# 或者用现成的
sudo ./install.sh --binary /path/to/wb2api-linux-amd64
```

脚本会做这些事：

1. 创建系统用户 `wb2api`（nologin）
2. `mkdir -p /opt/wb2api/{auths,prompts,data}`，装二进制
3. 把 `policy-sys.txt` 复制成 `prompts/unlock-workbuddy-original.txt`
4. 从 `config.example.json` 生成 `config.json`，随机生成 64 位 hex api_key，`chmod 600`
5. 装 `wb2api.service`，`enable --now`
6. 打印访问地址和 api_key（**只显示这一次**）

## 验证注入有没有生效

```bash
curl -s --noproxy '*' http://127.0.0.1:7863/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"cn:deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":4}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['usage']['prompt_tokens'])"
```

- 输出 **1240 左右** → 政策已注入，正常
- 输出 **56~60** → 政策没被读到，九成是 `prompt.file` 路径问题

想再确认稳定性，连跑 6 次，应该次次都是 1240。实测本机与服务器各 12 次，零衰减。

## 踩过的坑

### 1. `prompt.file` 必须是相对路径

写绝对路径（`/opt/wb2api/prompts/xxx.txt` 或 Windows 的 `C:/Users/...`）时，wb2api
**既不报错也不注入**，`prompt_tokens` 停在 56~60。看起来像"custom 模式没用"，其实是
文件根本没读到。这也正是 2026-11-03 那次误判「custom 效果差」的真因。

用 `prompts/unlock-workbuddy-original.txt`（相对 `WorkingDirectory`）就正常。

### 2. 别想着用 Wine 跑 Windows 版

本机那份 fork 是 Windows PE，Linux 下要 Wine。**放弃了**：

- Go 1.23 的运行时硬依赖 `bcryptprimitives.dll`，Wine 8.0 没这个 DLL，启动即
  `fatal error: bcryptprimitives.dll not found`
- 装 Wine 11 要拉 100 MB+ 外网包，实测 40 分钟只下到一半

官方 v1.13.0 的 ELF 版在 `custom` 模式下行为与 fork 一致，没必要绕。

### 3. 政策文本不要自己写

`policy-sys.txt` 那 5286 字节是调过的。自写「最高优先级」短块实测 3/3 被拒——模型会
把它当成一段可讨论的文本，而不是规则。

## 安全

- `config.json` 里是 `api_key`（对外唯一凭证），`auths/` 里是账号 token。两者都 `chmod 600/700`。
- **不要把 7863 直接暴露公网**而不加限制。面板 `/panel/` 能改配置、看用量。
- 仓库里 `config.example.json` 的 api_key 是占位符，真实值只在部署机器上。
