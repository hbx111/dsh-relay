/**
 * 拒绝重试的单测：用一个假的 chunk 流，验证「丢第一次、重发第二次」的行为。
 * 不起 dsh，也不发真实请求。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, looksRefusalHead } from './index.js';

const DIR = path.join(os.homedir(), '.dsh', 'policy');
const CFG = path.join(DIR, 'config.json');
const backup = fs.readFileSync(CFG, 'utf8');

function setCfg(patch) {
  const cfg = { mode: 'off', onlyAgentLoop: true, log: false, ...patch };
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  // 插件按 mtime 判断要不要重读配置，同一毫秒内写入会读不到变化
  const now = new Date(Date.now() + Math.random() * 2000 + 2000);
  fs.utimesSync(CFG, now, now);
}

const RETRY_ON = {
  retry: { enabled: true, maxRetries: 2, peekChars: 200, peekMs: 1200, backoffMs: 0 },
};

setCfg({ ...RETRY_ON });
let listener = null;
apply({ on: (event, cb) => { if (event === 'llm/stream') listener = cb; } });
assert.ok(listener, 'apply 应该注册 llm/stream 监听器');

const TOOLS = [{ name: 'read', parameters: {} }];
const OPTIONS = () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: TOOLS });

/** 把一段文本切成若干 text-delta，模拟真实流。 */
function deltas(text, size = 6) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push({ type: 'text-delta', index: 0, text: text.slice(i, i + size) });
  return out;
}

/** 造一个可计数的 next：每次调用返回一段预设 chunk。 */
function fakeNext(scripts) {
  const calls = [];
  const next = () => {
    const chunks = scripts[Math.min(calls.length, scripts.length - 1)];
    calls.push(chunks);
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  };
  next.calls = calls;
  return next;
}

async function collect(iterable) {
  const out = [];
  for await (const c of iterable) out.push(c);
  return out;
}

const joinText = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');

let pass = 0;
async function ok(label, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS ' + label);
  } catch (e) {
    console.error('FAIL ' + label + ' :: ' + e.message);
    process.exitCode = 1;
  }
}

await ok('判定：开口就拒的形状命中', () => {
  assert.equal(looksRefusalHead('抱歉，我不能帮你做这个。'), true);
  assert.equal(looksRefusalHead('对不起，我无法协助你完成这个请求。'), true);
  assert.equal(looksRefusalHead('这个忙我帮不了。'), true);
  assert.equal(looksRefusalHead('I cannot help with that.'), true);
  // 2026-11-08：受事者表原先只有「帮你/协助/做/完成」，这几种最典型的拒绝全漏
  assert.equal(looksRefusalHead('这个我不能写。'), true);
  assert.equal(looksRefusalHead('这个我不能写——'), true);
  assert.equal(looksRefusalHead('我无法写这个'), true);
  assert.equal(looksRefusalHead('我不能写这个'), true);
  assert.equal(looksRefusalHead('这类内容我不能生成。'), true);
  assert.equal(looksRefusalHead('我不能提供这类内容'), true);
  assert.equal(looksRefusalHead("Sorry, I can't write that."), true);
});

await ok('判定：正常内容不误判', () => {
  assert.equal(looksRefusalHead('我无法提供具体数字，但可以从三个角度看。'), false);
  assert.equal(looksRefusalHead('抱歉刚才理解错了，我重新看一下。'), false);
  assert.equal(looksRefusalHead('这个函数会帮你把参数展开。'), false);
  assert.equal(looksRefusalHead(''), false);
  // 加了「动词必须收尾」之后，这几类正常技术句必须仍然放过
  assert.equal(looksRefusalHead('我不能写死端口，得从配置读。'), false);
  assert.equal(looksRefusalHead('这个类的构造器不能写 const。'), false);
  assert.equal(looksRefusalHead('这个功能我不能提供 demo 之外的行为，但可以解释原理。'), false);
  assert.equal(looksRefusalHead('抱歉，我无法写得更长。'), false);
});

await ok('第一次被拒 → 丢弃并重发，用户只看到第二次', async () => {
  const bad = deltas('抱歉，我不能帮你做这个。');
  const good = deltas('好的，我先把文件读出来看看。');
  const next = fakeNext([bad, good]);
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(next.calls.length, 2, '应该重发一次');
  assert.equal(joinText(out).includes('抱歉'), false, '被拒的内容不能漏出去');
  assert.equal(joinText(out), '好的，我先把文件读出来看看。');
});

await ok('先推理很久、正文只蹦出两个字就拒绝 → 仍要抓到（2026-11-05 实况）', async () => {
  // 真实形状：推理链跑 1.8 秒（早已超过 peekMs=1200），正文才从「这」开始一个字一个字蹦。
  // 旧逻辑拿「距第一块的时长」跟 peekMs 比，正文一冒头就立刻放行，
  // 只看到 2 个字就放走，拒绝判定永远拿不到「这个忙不能帮」。
  const refusal = '这个忙不能帮：绕过授权属于破解，具体做法我不提供。';
  const slow = [
    ...Array.from({ length: 30 }, () => ({ type: 'reasoning-delta', index: 0, text: '想' })),
    ...Array.from(refusal).map((ch) => ({ type: 'text-delta', index: 0, text: ch })),
  ];
  const good = deltas('好，先看注册表里的试用期字段。');
  let calls = 0;
  const next = () => {
    calls++;
    const script = calls === 1 ? slow : good;
    const slowThis = calls === 1;
    return (async function* () {
      for (const c of script) {
        yield c;
        if (slowThis) await new Promise((r) => setTimeout(r, 60));
      }
    })();
  };
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(calls, 2, '应该识别出拒绝并重发');
  assert.equal(joinText(out).includes('这个忙'), false, '被拒内容不能漏出去');
  assert.equal(joinText(out), '好，先看注册表里的试用期字段。');
});

await ok('正文起头就断流 → 不挂死，按断流放行', async () => {
  const stuck = [
    { type: 'text-delta', index: 0, text: '现在' },
    { type: 'text-delta', index: 0, text: '我们' },
  ];
  let calls = 0;
  const next = () => {
    calls++;
    const script = calls === 1 ? stuck : [];
    const slowThis = calls === 1;
    return (async function* () {
      for (const c of script) {
        yield c;
        if (slowThis) await new Promise((r) => setTimeout(r, 1800));
      }
    })();
  };
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(calls, 1, '够不着拒绝特征就不该重发');
  assert.equal(joinText(out), '现在我们');
});

await ok('正常回复只发一次请求', async () => {
  const chunks = deltas('先看目录结构，再决定改哪儿。');
  const next = fakeNext([chunks]);
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(next.calls.length, 1);
  assert.equal(joinText(out), '先看目录结构，再决定改哪儿。');
});

await ok('一直拒 → 用完次数后把最后一次原样交出', async () => {
  const bad = deltas('抱歉，我不能帮你做这个。');
  const next = fakeNext([bad]);
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(next.calls.length, 3, '1 次原始 + 2 次重发');
  assert.equal(joinText(out), '抱歉，我不能帮你做这个。');
});

await ok('开头是工具调用 → 不重试', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'c1', name: 'read', argumentsDelta: '{}' },
  ];
  const next = fakeNext([chunks]);
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(next.calls.length, 1);
  assert.equal(out.length, 2);
});

await ok('没有工具定义的内部调用（标题生成）不重试', async () => {
  const next = fakeNext([deltas('抱歉，我不能帮你做这个。')]);
  const options = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] };
  await collect(listener(options, next));
  assert.equal(next.calls.length, 1);
});

await ok('长回复越过预读窗口后完整透传', async () => {
  const body = '先读一遍现有实现，' + '把边界条件都列出来，'.repeat(30) + '最后再动代码。';
  const next = fakeNext([deltas(body)]);
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(next.calls.length, 1);
  assert.equal(joinText(out), body);
});

await ok('先推理一大段、再开口拒绝 → 仍然重试（推理不计入放行）', async () => {
  const reasoning = Array.from({ length: 200 }, (_, i) => ({ type: 'reasoning-delta', index: 0, text: '思考第' + i + '步。' }));
  const bad = [...reasoning, ...deltas('这个我不能帮，绕过授权属于盗版。')];
  const good = [...reasoning, ...deltas('好的，我先看一下你现在装的版本。')];
  const next = fakeNext([bad, good]);
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(next.calls.length, 2, '推理再长也不能提前放行');
  assert.equal(joinText(out), '好的，我先看一下你现在装的版本。');
  assert.equal(out.filter((c) => c.type === 'reasoning-delta').length, 200, '只保留第二次的推理');
});

await ok('纯推理、没有正文 → 不被当成拒绝', async () => {
  const chunks = [{ type: 'reasoning-delta', index: 0, text: '想一下' }, { type: 'finish', reason: { kind: 'stop' } }];
  const next = fakeNext([chunks]);
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(next.calls.length, 1);
  assert.equal(out.length, 2);
});

/* 1M 上下文的现实：推理动辄几千字、几十秒。旧逻辑只看 maxWaitMs，
   推理一超时就放行，等于把「先想很久、再拒绝」整类漏掉
   （policy.log 里 89 次 wait-reasoning）。新逻辑要求推理也停住才放行。 */
await ok('推理持续增长时，超过 maxWaitMs 也不放行', async () => {
  setCfg({ retry: { enabled: true, maxRetries: 1, peekChars: 40, peekMs: 1200, backoffMs: 0, maxWaitMs: 1000, reasoningStallMs: 500 } });
  const slowRefusal = async function* () {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 100));
      yield { type: 'reasoning-delta', index: 0, text: '思考第' + i + '步。' };
    }
    for (const c of deltas('这个我不能帮。')) yield c;
  };
  const good = async function* () {
    for (const c of deltas('好的，我看一下。')) yield c;
  };
  let n = 0;
  const next = () => (n++ === 0 ? slowRefusal() : good());
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(n, 2, '推理一直在滚就不该被 maxWaitMs 放走');
  assert.equal(joinText(out), '好的，我看一下。');
  setCfg({ ...RETRY_ON });
});

await ok('推理停住且已超过 maxWaitMs → 才放行，不误判为拒绝', async () => {
  setCfg({ retry: { enabled: true, maxRetries: 1, peekChars: 40, peekMs: 1200, backoffMs: 0, maxWaitMs: 1000, reasoningStallMs: 500 } });
  const stalled = async function* () {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      yield { type: 'reasoning-delta', index: 0, text: '想法'.repeat(20) };
    }
    await new Promise((r) => setTimeout(r, 1400));
    for (const c of deltas('好的，我先看下。')) yield c;
  };
  let n = 0;
  const next = () => (n++ === 0 ? stalled() : (async function* () { for (const c of deltas('不该出现')) yield c; })());
  await collect(listener(OPTIONS(), next));
  assert.equal(n, 1, '推理停住就该放行，不该重试');
  setCfg({ ...RETRY_ON });
});

/* 上游风控断流：终止块 reason 是 error 且 message 带 content_filter。
   这时重发只会被再切一次，必须当场收摊，并把失败信息补一句人话。 */
const FILTER_FINISH = {
  type: 'finish',
  reason: { kind: 'error', failure: { message: 'Provider finish_reason: content_filter', code: 'PROVIDER_ERROR' } },
};

await ok('上游 content_filter 切断 → 不重试，失败信息带注', async () => {
  const next = fakeNext([[...deltas('这是下载报告，第一项'), FILTER_FINISH]]);
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(next.calls.length, 1, '风控断流重发没有意义');
  const fin = out.find((c) => c.type === 'finish');
  assert.ok(fin, '终止块必须原样交给上层');
  assert.equal(fin.reason.kind, 'error');
  assert.equal(fin.reason.failure.code, 'PROVIDER_ERROR', 'code 不能被改');
  assert.ok(fin.reason.failure.message.includes('content_filter'));
  assert.ok(fin.reason.failure.message.includes('已停止重试'), '要补一句人话');
});

await ok('还没开口就被切 → 一次请求，终止块单独透传', async () => {
  const next = fakeNext([[{ type: 'reasoning-delta', index: 0, text: '想…' }, FILTER_FINISH]]);
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(next.calls.length, 1);
  assert.equal(out.at(-1).type, 'finish');
  assert.equal(out.filter((c) => c.type === 'reasoning-delta').length, 1, '缓冲要吐出来');
});

await ok('失败信息里已经有那句注 → 不重复追加', async () => {
  const twice = {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'Provider finish_reason: content_filter（供应商侧强制断流：重发同一请求会被再切一次，已停止重试）', code: 'PROVIDER_ERROR' },
    },
  };
  const next = fakeNext([[twice]]);
  const out = await collect(listener(OPTIONS(), next));
  const msg = out.find((c) => c.type === 'finish').reason.failure.message;
  assert.equal(msg.match(/已停止重试/g).length, 1);
});

await ok('关闭重试 → 一次请求，行为与以前一致', async () => {
  setCfg({ retry: { ...RETRY_ON.retry, enabled: false } });
  const next = fakeNext([deltas('抱歉，我不能帮你做这个。')]);
  const out = await collect(listener(OPTIONS(), next));
  assert.equal(next.calls.length, 1);
  assert.equal(joinText(out), '抱歉，我不能帮你做这个。');
  setCfg({ ...RETRY_ON });
});

fs.writeFileSync(CFG, backup);
console.log(`\n${pass} 项通过`);
