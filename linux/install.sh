#!/usr/bin/env bash
#
# wb2api Linux 安装脚本 —— 以 systemd 常驻，用 custom 模式注入政策文本。
#
# 实测环境：Debian 12 / x86_64 / 腾讯云轻量。Windows 那套（relay + 插件）在
# 这里不需要：Linux 上直接让 wb2api 自己注入，少一层转发。
#
# 用法：
#   sudo ./install.sh --binary /path/to/wb2api-linux-amd64
#   sudo ./install.sh --build          # 从源码构建（需要 go 1.21+）
#
# 可选：
#   --dir /opt/wb2api     安装目录
#   --port 7863           监听端口
#   --policy FILE         自定义政策文件（默认用本目录的 policy-sys.txt）
#
set -euo pipefail

INSTALL_DIR=/opt/wb2api
SERVICE_USER=wb2api
SERVICE_NAME=wb2api.service
PORT=7863
BINARY=""
BUILD=0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_SRC="$HERE/policy-sys.txt"

die()  { printf '\033[31m错误\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --binary) BINARY="${2:-}"; shift 2 ;;
    --build)  BUILD=1; shift ;;
    --dir)    INSTALL_DIR="${2:-}"; shift 2 ;;
    --port)   PORT="${2:-}"; shift 2 ;;
    --policy) POLICY_SRC="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数: $1（用 --help 看用法）" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo $0 ..."

# ---------- 1. 准备二进制 ----------
TMP_BIN=""
cleanup() { [ -n "$TMP_BIN" ] && rm -rf "$(dirname "$TMP_BIN")" || true; }
trap cleanup EXIT

if [ -n "$BINARY" ]; then
  [ -f "$BINARY" ] || die "--binary 指向的文件不存在: $BINARY"
  info "使用现成二进制: $BINARY"
elif [ "$BUILD" -eq 1 ]; then
  command -v go >/dev/null 2>&1 || die "--build 需要 go，未找到"
  TMP_BIN="$(mktemp -d)/wb2api"
  info "从源码构建（CGO_ENABLED=0，静态链接）..."
  ( cd "$(mktemp -d)" && \
    git clone --depth 1 https://github.com/linguo2625469/workbuddy2api.git src && \
    cd src && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$TMP_BIN" . ) \
    || die "构建失败"
  BINARY="$TMP_BIN"
  ok "构建完成"
else
  die "需要 --binary <路径> 或 --build。上游仓库没有提供 Linux Release，二进制得自己出。"
fi

# ---------- 2. 用户与目录 ----------
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  info "创建系统用户 $SERVICE_USER"
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
else
  info "用户 $SERVICE_USER 已存在"
fi

info "准备目录 $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"/{auths,prompts,data}
install -m 0755 "$BINARY" "$INSTALL_DIR/wb2api"

# ---------- 3. 政策文本 ----------
if [ -f "$POLICY_SRC" ]; then
  # wb2api 的 prompt.file 必须是相对工作目录的路径；写绝对路径会静默不生效。
  install -m 0644 "$POLICY_SRC" "$INSTALL_DIR/prompts/unlock-workbuddy-original.txt"
  ok "政策文本已放入 prompts/（$(wc -c <"$POLICY_SRC") 字节）"
else
  die "找不到政策文件: $POLICY_SRC"
fi

# ---------- 4. 配置 ----------
CONFIG="$INSTALL_DIR/config.json"
if [ -f "$CONFIG" ]; then
  info "config.json 已存在，保留不动（备份见 config.json.bak）"
  cp -a "$CONFIG" "$CONFIG.bak.$(date +%Y%m%d-%H%M%S)"
else
  [ -f "$HERE/config.example.json" ] || die "缺少 config.example.json"
  API_KEY="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed "s/PUT-YOUR-OWN-RANDOM-64-HEX-HERE/$API_KEY/" "$HERE/config.example.json" \
    | sed "s/\"listen\": \"0.0.0.0:7863\"/\"listen\": \"0.0.0.0:$PORT\"/" > "$CONFIG"
  chmod 0600 "$CONFIG"
  ok "已生成 config.json（api_key 见下方）"
  GENERATED_KEY="$API_KEY"
fi

# ---------- 5. systemd ----------
if [ -f "$HERE/$SERVICE_NAME" ]; then
  install -m 0644 "$HERE/$SERVICE_NAME" "/etc/systemd/system/$SERVICE_NAME"
else
  die "缺少 $SERVICE_NAME"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 0700 "$INSTALL_DIR/auths"

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "服务已启动：$(systemctl is-active "$SERVICE_NAME")"
else
  systemctl status "$SERVICE_NAME" --no-pager -l | tail -20
  die "服务启动失败，先看上面的日志"
fi

# ---------- 6. 收尾提示 ----------
IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

cat <<EOF

────────────────────────────────────────
 安装完成

   服务      $SERVICE_NAME（systemctl status / journalctl -u $SERVICE_NAME -f）
   目录      $INSTALL_DIR
   监听      $PORT   →  http://$IP:$PORT
   API Key   ${GENERATED_KEY:-（沿用原有 config.json，请自行查 api_key 字段）}

 下一步：
   1. 把 auths/*.json 放进去（从 Windows 的 wb2api/auths 复制，或用 /panel/ 登录）
   2. 验证注入：
        curl -s --noproxy '*' http://127.0.0.1:$PORT/v1/chat/completions \\
          -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \\
          -d '{"model":"cn:deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":4}'
        → usage.prompt_tokens 应该在 1240 上下（政策已注入）；停在 56~60 说明没读到政策文件
   3. 端口对外前先确认防火墙，别把带 key 的面板直接暴露公网

 注意：API Key 只在上面显示一次。丢了就改 config.json 的 api_key 再重启。
────────────────────────────────────────
EOF
