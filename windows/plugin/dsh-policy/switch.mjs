#!/usr/bin/env node
/**
 * 在两条注入路线之间切换。两边都在改同一件事，必须一次只开一个，
 * 否则 user 消息里会出现两份政策（实测会把拒绝率抬上去）。
 *
 *   node switch.mjs status    看现在谁在管
 *   node switch.mjs plugin    插件接管（relay 停止注入 + 关重试，流式恢复）
 *   node switch.mjs relay     中转接管（插件休眠）
 *   node switch.mjs retry-on  只把拒绝重试打开（会牺牲流式，首字变慢）
 *   node switch.mjs retry-off 只关重试
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POLICY_DIR = path.join(os.homedir(), '.dsh', 'policy');
const CFG = path.join(POLICY_DIR, 'config.json');
const POLICY = path.join(POLICY_DIR, 'policy-sys.txt');
const LOG = path.join(POLICY_DIR, 'policy.log');
const RELAY = path.join(os.homedir(), 'AppData', 'Local', 'dsh-relay');
const FLAG = path.join(RELAY, 'syspolicy.off');
const RETRY = path.join(RELAY, 'retry-mode.txt');
/** 插件本体：放在 policy 目录下、由 patch 层用绝对路径加载，pnpm 动不到它 */
const PLUGIN = path.join(POLICY_DIR, 'plugin');

const readCfg = () => {
  try {
    return JSON.parse(fs.readFileSync(CFG, 'utf8'));
  } catch {
    return { mode: 'off', onlyAgentLoop: true, log: true };
  }
};

function writeCfg(mode) {
  const cfg = readCfg();
  cfg.mode = mode;
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n');
}

function patchCfg(patch) {
  const cfg = readCfg();
  fs.writeFileSync(CFG, JSON.stringify({ ...cfg, ...patch }, null, 2) + '\n');
}

function retryCfg() {
  const cfg = readCfg();
  return { enabled: false, maxRetries: 2, peekChars: 200, peekMs: 1200, backoffMs: 350, ...(cfg.retry || {}) };
}

function setPluginRetry(enabled) {
  patchCfg({ retry: { ...retryCfg(), enabled } });
}

function retryMode() {
  try {
    return fs.readFileSync(RETRY, 'utf8').trim() || '(空)';
  } catch {
    return '(文件不存在)';
  }
}

function setRetry(v) {
  fs.writeFileSync(RETRY, v + '\n');
}

function status() {
  const cfg = readCfg();
  const flag = fs.existsSync(FLAG);
  const pluginOn = cfg.mode && cfg.mode !== 'off';
  let logTail = '';
  try {
    logTail = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-3).join('\n');
  } catch {}

  console.log('路线状态');
  console.log('  relay 注入 : ' + (flag ? '关（syspolicy.off 存在）' : '开'));
  console.log('  插件注入   : ' + (pluginOn ? `开（mode=${cfg.mode}）` : '关（mode=off）'));
  const rc = retryCfg();
  console.log('  拒绝重试   : ' + retryMode() + (retryMode() === 'on' ? '  ← 会缓冲整段回复，没有流式' : ''));
  const pluginInstalled = fs.existsSync(PLUGIN);
  console.log(
    '  插件重试   : ' +
      (!pluginInstalled
        ? '不可用（~/.dsh/policy/plugin 不存在）'
        : rc.enabled
          ? `开（最多重发 ${rc.maxRetries} 次，正文看够 ${rc.minTextChars || 24} 字才判断，流式保留）`
          : '关'),
  );
  console.log('  政策文件   : ' + (fs.existsSync(POLICY) ? fs.statSync(POLICY).size + ' 字节' : '缺失'));

  // 是不是 profile 组合包，决定 dsh 设置里有没有这张卡片（只有 patch 裸行是看不到的）
  let bundled = false;
  try {
    const profPkg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json'), 'utf8'),
    );
    bundled = ((profPkg.dsh && profPkg.dsh.profile && profPkg.dsh.profile.bundles) || []).includes('dsh-policy');
  } catch {}
  console.log(
    '  设置里可见 : ' +
      (bundled ? '是（组合包 dsh-policy：侧栏「插件」/ 设置 → 插件）' : '否（只是 patch 行；跑 install-plugin.cmd 重装）'),
  );
  if (!pluginInstalled) {
    console.log('\n⚠ 插件本体不在 ~/.dsh/policy/plugin，重试不会发生。');
    console.log('  跑部署包的 install-plugin.cmd 重装，装完重启 dsh。');
  }

  const both = !flag && pluginOn;
  const none = flag && !pluginOn;
  if (both) console.log('\n⚠ 两条路线同时开着 —— 消息里会有两份政策，请关掉一个');
  if (none) console.log('\n⚠ 两条路线都关着 —— 现在没有任何注入');
  if (!both && !none) console.log('\n当前由 ' + (pluginOn ? '插件' : 'relay') + ' 负责注入');

  if (logTail) console.log('\n插件最近日志\n' + logTail);
  else console.log('\n插件还没跑过（装好后要重启一次 dsh 才会加载）');
}

const cmd = (process.argv[2] || 'status').toLowerCase();

if (cmd === 'status') {
  status();
} else if (cmd === 'plugin' || cmd === 'hybrid') {
  // 2026-11-05 实测修正：dsh 在交给 llm/stream 之前就 Object.freeze 了 messages，
  // 插件根本写不进去（日志里是 "Cannot redefine property: messages"）。
  // 所以注入只能留在 relay，插件只管它真正擅长的部分——流式重试。
  writeCfg('off');
  setPluginRetry(true);
  try {
    fs.unlinkSync(FLAG);
  } catch {}
  setRetry('off');
  console.log('已切到「relay 注入 + 插件重试」：');
  console.log('  dsh-relay/syspolicy.off    已删除（relay 恢复注入，热生效）');
  console.log('  ~/.dsh/policy/config.json  mode=off（插件不改请求），retry.enabled=true');
  console.log('  dsh-relay/retry-mode.txt   off（relay 不缓冲，流式保住）');
  console.log('\n分工：政策由 relay 在 HTTP 层塞进去（已验证 prompt_tokens 会涨），');
  console.log('      重试由插件在 chunk 层做（只看开头，被拒那次不吐给上层）。');
  console.log('为什么插件不注入：dsh 的 agent loop 把 messages deepFreeze 之后才发事件，');
  console.log('扩展点对请求只读——这是设计约束，不是配置问题。');
} else if (cmd === 'plugin-inject') {
  writeCfg('user');
  setPluginRetry(false);
  fs.writeFileSync(FLAG, 'relay 注入已交给 dsh-policy 插件\n');
  console.log('⚠ 已切到「插件注入」，但这条在 2026-11-05 的 dsh 上不生效：');
  console.log('  llm/stream 拿到的 messages 已被 Object.freeze，赋值会抛 TypeError。');
  console.log('  只用于将来 dsh 放宽冻结后的验证。要恢复请跑 plugin。');
} else if (cmd === 'relay') {
  writeCfg('off');
  setPluginRetry(false);
  try {
    fs.unlinkSync(FLAG);
  } catch {}
  console.log('已切回 relay：插件休眠（注入与重试都关），relay 下一轮恢复注入（热生效）。');
} else if (cmd === 'retry-plugin-on') {
  setPluginRetry(true);
  const c = retryCfg();
  console.log(`插件重试已开：最多重发 ${c.maxRetries} 次，正文看够 ${c.minTextChars || 24} 字才判断，保留流式。`);
} else if (cmd === 'retry-plugin-off') {
  setPluginRetry(false);
  console.log('插件重试已关：被拒时手动重发一次。');
} else if (cmd === 'retry-on') {
  setRetry('on');
  console.log('拒绝重试已开：整段缓冲，首字延迟 10~25 秒，没有流式打字。');
} else if (cmd === 'retry-off') {
  setRetry('off');
  console.log('拒绝重试已关：流式恢复。被拒时手动重发一次即可。');
} else {
  console.log('用法：node switch.mjs [status|plugin|relay|retry-on|retry-off|retry-plugin-on|retry-plugin-off|plugin-inject]');
}
