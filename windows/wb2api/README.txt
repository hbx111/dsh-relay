workbuddy2api for Windows —— 部署说明
======================================

本目录是 wb2api（WorkBuddy 上游中转）的配置与启动脚本。
随附的 config.example.json 是配置模板，正式使用前要复制成 config.json 并改一行。

一、装（不需要管理员）
  解压到任意目录，然后在该目录里执行：
      powershell -ExecutionPolicy Bypass -File .\install.ps1

  它会做四件事：
    1. 复制到 %LOCALAPPDATA%\workbuddy2api
    2. 注册「登录时自动启动」的计划任务（任务名 workbuddy2api）
    3. 立刻启动（后台无窗口）
    4. 尝试放行防火墙 7863（非管理员会自动跳过）

  复制完成后，把本目录的 config.example.json 复制成
  %LOCALAPPDATA%\workbuddy2api\config.json，然后至少改两处：

      "api_key"              换成你自己的一串随机字符（客户端要用同一个值）
      "prompt": { "mode": "passthrough" }   ← 保持 passthrough

  passthrough 的意思是：政策注入由 dsh-relay 那一层负责，wb2api 不要重复注入。
  如果只想要 wb2api、不用 relay，也可以把 mode 改成 append，让它在
  prompts\unlock-workbuddy-original.txt 上自己注入。

二、用
  面板   http://127.0.0.1:7863/panel/
  接口   http://127.0.0.1:7863/v1
  请求头 Authorization: Bearer <你填的 api_key>

  手机等其它设备要访问：把 127.0.0.1 换成本机局域网 IP，
  并在防火墙放行 7863（管理员执行 install.ps1 会自动做）。
  注意 0.0.0.0 监听意味着同网段设备都能连，公共网络下建议改成 127.0.0.1。

三、账号
  本目录不带任何账号。启动后在面板里添加，或在命令行走 login.exe：
      login.exe url      输出设备授权链接
      login.exe poll     轮询直到拿到 token
  凭据会写进 auths\workbuddy-<uid>.json，服务重启后自动加载。
  详见 auths\README.md。

四、日志与数据
  logs\            请求日志
  data\state.json  账号状态、冷却、用量桶
  auths\           账号凭据（token 会自己刷新）

五、改端口 / 改监听地址
  编辑 config.json 里的 "listen"：
    127.0.0.1:7863   只允许本机
    0.0.0.0:7863     允许局域网（默认）
  改完在「任务计划程序」里把 workbuddy2api 任务结束再运行一次，或重启电脑。

六、卸载
      powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
  （在安装后的目录 %LOCALAPPDATA%\workbuddy2api 里执行）

七、注意
  - login.exe 不在本包内，需要单独获取后放进安装目录；
    没有它就没法加账号。config.json、data\ 缺失会自动重建，不影响启动。
  - 运行程序本身未做代码签名，首次运行 Windows SmartScreen 可能提示，
    点「更多信息 → 仍要运行」。
  - auths\ 里的 token 是明文，等于账号密码，不要外传、不要进公开仓库。
