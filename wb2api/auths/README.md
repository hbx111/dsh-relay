# auths/ —— 账号凭据目录

**这个目录在分享包里是空的，这是故意的。**

wb2api 靠这里的 JSON 文件识别可用的上游账号。每个文件对应一个账号，
文件名形如 `workbuddy-<uid>.json`，内容结构见 `example.json`。

## 怎么得到自己的

1. 装好 wb2api，打开面板 `http://127.0.0.1:7863/panel/`
2. 用「登录 / 添加账号」，走一遍官方登录流程（需要一个 WorkBuddy 账号）
3. 登录成功后，凭据会由 wb2api 自己写进本目录，不需要手工拼 JSON

多账号就重复第 2 步。账号数量不限，池子会自动做权重和冷却。

## 结构说明（`example.json` 只是字段骨架，值是空的）

| 字段 | 含义 |
|---|---|
| `account.uid` / `account.nickname` | 账号标识与显示名 |
| `account.enterpriseId` | 企业/组织 ID，个人号可能为空 |
| `auth.accessToken` | 访问令牌，短效，几小时后过期 |
| `auth.refreshToken` | 刷新令牌，凭它续期。**泄露等于账号被接管** |
| `auth.expiresAt` | accessToken 到期时间（Unix 秒） |
| `auth.domain` / `auth.realm` | 上游域名与租户标识 |

## 安全提醒

- 这两个 token 是明文，别提交到公开仓库、别贴截图、别发给别人。
- 真泄露了不用慌：去上游重新登录一次，旧 token 会失效。
- `config.json` 里的 `api_key` 是中转自己的入口密钥，同样别外传；
  自己用的话，换成任意一串随机字符即可（客户端要用同一个值）。
