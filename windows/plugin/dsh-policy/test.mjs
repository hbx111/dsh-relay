/**
 * dsh-policy 单测：不起 dsh，用假 ctx 抓住 llm/stream 监听器直接调。
 * 重点是四种真实会遇到的形态：普通字符串、块数组、冻结消息、末条是 tool。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from './index.js';

const DIR = path.join(os.homedir(), '.dsh', 'policy');
const CFG = path.join(DIR, 'config.json');
const backup = fs.readFileSync(CFG, 'utf8');

function setMode(mode) {
  fs.writeFileSync(CFG, JSON.stringify({ mode, onlyAgentLoop: true, log: false }, null, 2));
  // 清 mtime 缓存：插件按 mtime 判断是否重读，同一毫秒内写入会读不到变化
  const now = new Date(Date.now() + Math.random() * 1000 + 1000);
  fs.utimesSync(CFG, now, now);
}

let listener = null;
// 先静音日志再 apply，否则单测会在真实 policy.log 里留下 loaded 记录，
// 看着像「dsh 已经加载了插件」，其实是测试自己写的。
fs.writeFileSync(CFG, JSON.stringify({ mode: 'off', onlyAgentLoop: true, log: false }, null, 2));
apply({ on: (event, cb) => { if (event === 'llm/stream') listener = cb; } });
assert.ok(listener, 'apply 应该注册 llm/stream 监听器');

const POLICY = fs.readFileSync(path.join(DIR, 'policy-sys.txt'), 'utf8').trim();
const NEEDLE = POLICY.slice(0, 80);
const TOOLS = [{ name: 'read', parameters: {} }];

function run(messages, extra = {}) {
  const options = { messages, tools: TOOLS, ...extra };
  let nextCalled = false;
  listener(options, () => { nextCalled = true; });
  assert.equal(nextCalled, true, '必须调用 next()');
  return options;
}

const f = (o) => Object.freeze(o);
const deep = (o) => {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deep(v);
    Object.freeze(o);
  }
  return o;
};

let pass = 0;
function ok(label, fn) {
  try {
    fn();
    pass++;
    console.log('PASS ' + label);
  } catch (e) {
    console.error('FAIL ' + label + ' :: ' + e.message);
    process.exitCode = 1;
  }
}

setMode('user');

ok('mode=off 不动', () => {
  setMode('off');
  const msgs = [{ role: 'user', content: 'hi' }];
  const out = run(msgs);
  assert.equal(out.messages[0].content, 'hi');
  setMode('user');
});

ok('字符串 content 追加', () => {
  const out = run([{ role: 'user', content: '帮我看看' }]);
  assert.ok(out.messages[0].content.endsWith(POLICY), '应追加政策原文');
  assert.ok(out.messages[0].content.startsWith('帮我看看'));
});

ok('块数组追加到最后一个 text 块', () => {
  const out = run([{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', data: 'x' }] }]);
  const blocks = out.messages[0].content;
  assert.equal(blocks.length, 2, '块数量不应变');
  assert.ok(blocks[0].text.includes(NEEDLE), '政策应在 text 块里');
  assert.equal(blocks[1].type, 'image', '图片块位置不变');
});

ok('已注入不重复', () => {
  const msgs = [{ role: 'user', content: '问题\n\n' + POLICY }];
  const out = run(msgs);
  assert.equal(out.messages, msgs, '应原样返回，不复制不追加');
  assert.equal(out.messages[0].content.split(NEEDLE).length, 2, '只出现一次');
});

ok('冻结消息不抛错且原对象不变', () => {
  const original = deep({ role: 'user', content: deep([{ type: 'text', text: '冻结的' }]) });
  const msgs = deep([original]);
  const out = run(msgs);
  assert.equal(original.content[0].text, '冻结的', '原消息必须保持不可变');
  assert.ok(out.messages[0].content[0].text.includes(NEEDLE), '新消息应带政策');
  assert.notEqual(out.messages[0], original, '必须是新对象');
});

ok('末条是 tool：剥掉旧注入并在末尾补一条 user', () => {
  const msgs = [
    { role: 'user', content: '旧问题\n\n' + POLICY },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
    { role: 'tool', content: [{ type: 'text', text: '输出' }], toolCallId: 't1' },
  ];
  const out = run(msgs);
  assert.equal(out.messages.length, 4, '应在末尾新增一条');
  assert.equal(out.messages[0].content, '旧问题', '历史里的旧政策要剥掉，避免两份');
  assert.equal(out.messages[3].role, 'user');
  assert.equal(out.messages[3].content[0].text, POLICY, '末尾只有政策原文，不加别的字');
  const flat = out.messages
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text || '').join('')))
    .join('\n');
  assert.equal(flat.split(NEEDLE).length, 2, '全文只能有一份');
});

ok('末条是 assistant 且前一条是 user：不连发两条 user', () => {
  const msgs = [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
  ];
  const out = run(msgs);
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[2].role, 'user');
  assert.equal(out.messages[1].role, 'assistant');
});

ok('无 tools 时跳过（标题生成等内部调用）', () => {
  const out = run([{ role: 'user', content: '生成标题' }], { tools: undefined });
  assert.equal(out.messages[0].content, '生成标题');
});

ok('next 只调用一次', () => {
  let n = 0;
  listener({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }, () => { n++; });
  assert.equal(n, 1);
});

fs.writeFileSync(CFG, backup);
console.log(`\n${pass} 项通过`);
