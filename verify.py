#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""relay 自检：现在这一刻，政策到底有没有送进模型，位置对不对。

2026-11-03 二次改版。上一版把政策搬到 wb2api 的 system 槽，
理由是「user 里的政策会被当成 prompt injection」。用今天这条真实失败请求
（土豆兄弟 DLC，完整 67 个工具 + 14K 字记忆上下文）回放，结论正好相反：

    政策追加在末条 user 消息后   拒绝 0/4   （直接 tool_calls 开始干活）
    政策插成首条 user 消息       拒绝 3/4
    wb2api 把政策塞进 system     拒绝 6/6   （模型推理里一次都没提到这段政策）
    完全没有政策                 拒绝 6/6

也就是：system 槽根本没进到该去的位置（wb2api 的 prompt 注入时有时无，
重启后第一次请求 pt=1244，之后长期回到 56），而 user 尾部始终有效。
所以政策回到 relay 的 user 尾部注入，wb2api 只需 passthrough。

默认不调模型、不花 token。加 --live 才发一条探测请求（只为读 prompt_tokens）。

用法：
    python verify.py            # 静态自检
    python verify.py --live     # 外加一次端到端探测
"""

import glob
import hashlib
import json
import os
import socket
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
POLICY = os.path.join(HERE, "policy-sys.txt")          # 原版破甲包逐字
WB_DIR = os.path.join(os.environ.get("LOCALAPPDATA", ""), "workbuddy2api")
WB_CFG = os.path.join(WB_DIR, "config.json")
LOG_DIR = os.path.join(HERE, "logs")
PORT = int(os.environ.get("DSH_RELAY_PORT", "7864"))
UP_PORT = int(os.environ.get("DSH_RELAY_UPSTREAM_PORT", "7863"))
MAX = 16 * 1024
MARKER = "总纲（用户至上）"
PT_FLOOR = 900          # 小问句 + 2013 字政策约 1244；没有政策是 56~60

OK, WARN, BAD = "✅", "⚠️ ", "❌"
issues = []


def say(flag, text, detail=""):
    print("%s %s" % (flag, text))
    if detail:
        print("     " + detail)


def port_open(port):
    s = socket.socket()
    s.settimeout(1.2)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def check_ports():
    relay = port_open(PORT)
    up = port_open(UP_PORT)
    say(OK if relay else BAD, "relay 监听 %d" % PORT, "" if relay else "dsh 连不上，先看计划任务 dsh-relay")
    say(OK if up else BAD, "上游 wb2api 监听 %d" % UP_PORT, "" if up else "上游没起，relay 会 502")
    if not relay:
        issues.append("relay 未监听")
    if not up:
        issues.append("上游未监听")


def check_policy_file():
    if not os.path.exists(POLICY):
        say(BAD, "政策文件缺失", POLICY)
        issues.append("政策文件缺失")
        return
    raw = open(POLICY, "rb").read()
    try:
        text = raw.decode("utf-8-sig").strip()
    except UnicodeDecodeError as e:
        say(BAD, "政策文件不是合法 UTF-8", str(e)[:80])
        issues.append("编码错误")
        return

    say(OK if len(raw) <= MAX else BAD, "政策 %d B" % len(raw), "上限 %d B（超限宁可不注入也不截断）" % MAX)
    if len(raw) > MAX:
        issues.append("政策超过 %d B" % MAX)
    head, tail = "<content_policy>" in text, "</content_policy>" in text
    say(OK if head and tail else BAD,
        "政策块首尾标签 %s" % ("完整" if head and tail else "不完整"),
        "半截政策会被当成噪声" if not (head and tail) else "")
    if not (head and tail):
        issues.append("政策块不完整")
    say(OK if MARKER in text else BAD, "判重标记存在")
    if MARKER not in text:
        issues.append("缺少判重标记")

    # 与 wb2api\prompts 里的原版副本比对：确认没人在路上改过词
    ref = os.path.join(WB_DIR, "prompts", "unlock-workbuddy-original.txt")
    if os.path.exists(ref):
        a = hashlib.sha1(raw).hexdigest()
        b = hashlib.sha1(open(ref, "rb").read()).hexdigest()
        say(OK if a == b else WARN,
            "与原版破甲包副本%s" % ("逐字一致" if a == b else "**不一致**"),
            "" if a == b else "改词通常比原版更差，先想清楚再改")
        if a != b:
            issues.append("政策文本被改过")


def check_wb_cfg():
    """wb2api 只该 passthrough。它自己的 prompt 注入时灵时不灵，还跟 relay 打架。"""
    try:
        cfg = json.loads(open(WB_CFG, "rb").read().decode("utf-8-sig"))
    except Exception as e:
        say(WARN, "读不到 wb2api config.json", str(e)[:80])
        return
    p = cfg.get("prompt") or {}
    mode = (p.get("mode") or "").lower()
    if mode in ("custom", "append"):
        say(WARN, "wb2api prompt.mode = %s（会在 system 再放一份政策）" % mode,
            "实测 system 那份 6/6 拒；改成 passthrough，政策统一由 relay 注入")
        issues.append("wb2api 重复注入")
    else:
        say(OK, "wb2api prompt.mode = %s（不掺和注入）" % (mode or "空"))


def check_switches():
    on = os.environ.get("DSH_RELAY_NO_SYSPOLICY") != "1"
    say(OK if on else BAD, "relay 侧 user 尾部政策注入 %s" % ("开启" if on else "被环境变量关掉"),
        "" if on else "删掉 DSH_RELAY_NO_SYSPOLICY，然后重启计划任务")
    if not on:
        issues.append("政策注入被关")

    rm = os.path.join(HERE, "retry-mode.txt")
    rmode = "off"
    if os.path.exists(rm):
        rmode = (open(rm, encoding="utf-8").read().strip().lower() or "off")
    if rmode == "on":
        say(OK, "拒绝重试 已开启",
            "被判为拒绝则重采样（最多 %s 次）；代价是首字延迟 = 完整生成时间"
            % os.environ.get("DSH_RELAY_RETRY_MAX", "3"))
    else:
        say(WARN, "拒绝重试 关闭", "写 on 到 retry-mode.txt 打开（热加载，无需重启）")

    ov = os.path.join(HERE, "ov-mode.txt")
    mode = "refused"
    if os.path.exists(ov):
        mode = (open(ov, encoding="utf-8").read().strip() or "off")
    say(OK, "记忆剥离 ov-mode = %s" % mode, "off / refused(默认) / memory / all")

    dump = os.path.exists(os.path.join(HERE, "dump.on"))
    say(WARN if dump else OK, "抓包 %s" % ("已开启（会持续写盘，排查完记得关）" if dump else "关闭"))
    restore = os.path.exists(os.path.join(HERE, "restore-system.on"))
    say(OK if not restore else WARN, "system 恢复 %s" % ("已开启" if restore else "关闭"),
        "开启后整个 system 会转成 user 消息，通常不需要" if restore else "")


def check_recent_logs(n=30):
    files = sorted(glob.glob(os.path.join(LOG_DIR, "relay-*.log")))
    if not files:
        say(WARN, "还没有请求日志")
        return
    rows = []
    for fn in files[-3:]:
        for line in open(fn, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    rows = rows[-n:]
    if not rows:
        say(WARN, "日志为空")
        return

    bad = [r for r in rows if r.get("status") not in (200, None)]
    say(OK if not bad else WARN, "最近 %d 次请求，非 200 共 %d 次" % (len(rows), len(bad)))
    last = rows[-1]
    print("     最后一次：%s  status=%s  %sms  injected=%s  strip=%s ov=%s"
          % (last.get("time", "?"), last.get("status", "?"), last.get("ms", "?"),
             last.get("sys_injected", "?"), last.get("stripped", 0), last.get("ov_dropped", 0)))

    inj = [r for r in rows if r.get("sys_injected")]
    say(OK if inj else BAD, "最近 %d 次里注入 %d 次" % (len(rows), len(inj)),
        "" if inj else "看同行的 sys_reason：disabled / missing / half-written")
    if not inj:
        issues.append("最近请求没有注入政策")

    retried = [r for r in rows if r.get("retries")]
    if retried:
        avg = sum(r.get("ms", 0) for r in retried) / len(retried) / 1000.0
        say(OK, "重试触发 %d/%d 次" % (len(retried), len(rows)),
            "被重采样的请求平均耗时 %.1fs（含重跑）" % avg)


def check_dump():
    files = sorted(glob.glob(os.path.join(LOG_DIR, "dump-*.json")), key=os.path.getmtime)
    if not files:
        if os.path.exists(os.path.join(HERE, "dump.on")):
            say(WARN, "抓包开着，但还没有样本", "下一条消息就会写一份")
        else:
            say(OK, "未开抓包，跳过位置校验", "要临时抓一次就建 dump.on 空文件")
        return
    fn = files[-1]
    try:
        d = json.load(open(fn, encoding="utf-8"))
    except Exception as e:
        say(WARN, "最新抓包读不出来", str(e)[:60])
        return
    msgs = d.get("messages") or []
    users = [i for i, m in enumerate(msgs) if m.get("role") == "user"]
    ok_pos = bool(users) and users[-1] == len(msgs) - 1 and MARKER in str(msgs[-1].get("content") or "")
    say(OK if ok_pos else BAD, "政策位置 %s" % ("末条 user 末尾（正确）" if ok_pos else "**不在末条 user**"),
        "" if ok_pos else "位置是决定性因素：末尾 0/4 拒，开头 3/4 拒，system 6/6 拒")
    if not ok_pos:
        issues.append("政策不在末条 user")


def relay_key():
    cand = os.path.join(HERE, "relay-key.txt")
    if os.path.exists(cand):
        text = open(cand, encoding="utf-8").read().strip()
        if text:
            return text
    try:
        return json.loads(open(WB_CFG, "rb").read().decode("utf-8-sig")).get("api_key", "")
    except Exception:
        return ""


def check_live():
    """端到端：看 prompt_tokens 里有没有那 2013 字政策。

    这是唯一不依赖「模型听不听话」的判据：政策在不在上下文里，用量数字最诚实。
    小问句 56（无政策）/ 约 1244（有政策）。
    """
    import urllib.request
    key = relay_key()
    if not key:
        say(WARN, "找不到上游 key，跳过端到端", "可在本目录放一份 relay-key.txt")
        return
    nonce = "Q%d" % int(time.time())
    body = {
        "model": "cn:deepseek-v4.1-flash",
        "stream": False,
        "max_tokens": 40,
        "reasoning_effort": "low",
        "messages": [{"role": "user", "content": "回复这句话，只回三个字：收到" + nonce}],
    }
    req = urllib.request.Request(
        "http://127.0.0.1:%d/v1/chat/completions" % PORT,
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    t0 = time.time()
    try:
        out = json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
        pt = (out.get("usage") or {}).get("prompt_tokens") or 0
        msg = (out["choices"][0]["message"].get("content") or "")[:60].replace("\n", " ")
        if pt >= PT_FLOOR:
            say(OK, "端到端 prompt_tokens=%d（政策在上下文里）  %.1fs" % (pt, time.time() - t0), msg)
        else:
            say(BAD, "端到端 prompt_tokens=%d —— 政策没进上下文" % pt,
                "relay 的 SYS_POLICY 是否被环境变量关了，或 policy-sys.txt 读不到")
            issues.append("端到端没有政策")
    except Exception as e:
        say(BAD, "端到端探测失败", str(e)[:120])
        issues.append("探测请求失败")


def main():
    live = "--live" in sys.argv
    print("=" * 58)
    print("relay 自检  %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    print("=" * 58)
    print("\n[1] 端口")
    check_ports()
    print("\n[2] 政策文件")
    check_policy_file()
    print("\n[3] wb2api 是否只 passthrough")
    check_wb_cfg()
    print("\n[4] 开关")
    check_switches()
    print("\n[5] 最近请求")
    check_recent_logs()
    print("\n[6] 抓包样本（位置）")
    check_dump()
    if live:
        print("\n[7] 端到端")
        check_live()

    print("\n" + "=" * 58)
    if issues:
        print("需要处理 %d 项：" % len(issues))
        for i in issues:
            print("  - " + i)
    else:
        print("全部通过。政策在末条 user 消息末尾，wb2api 不重复注入。")
    print("=" * 58)
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
