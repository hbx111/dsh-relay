/**
 * dsh-policy — 在 dsh 客户端侧把政策块注入到模型请求里。
 *
 * 为什么是插件而不是中转：wb2api 会整段丢弃 system/developer 消息，
 * 只有 user 消息能到模型。中转层只能在 HTTP 文本里找「最后一条 user」再拼字符串，
 * 一旦消息结构变了就静默失效；插件拿到的是结构化对象，改的是字段，
 * 而且完全不碰响应流 —— 所以流式打字、首字延迟都和没装插件时一样。
 *
 * 钩子：llm/stream（waterfall）。监听器在原地改 options，然后 next()。
 * waterfall 的 next 不接受新参数，所以只能改对象字段，不能替换参数。
 *
 * 消息是不可变的（deepFreeze），所以任何改动都是「复制一份再替换引用」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-policy';
/** llm/stream 由 llm 服务发起，等它就绪再挂监听。 */
export const inject = ['llm'];

const DIR = path.join(os.homedir(), '.dsh', 'policy');
const POLICY_PATH = path.join(DIR, 'policy-sys.txt');
const CONFIG_PATH = path.join(DIR, 'config.json');
const LOG_PATH = path.join(DIR, 'policy.log');
const MAX_LOG = 256 * 1024;

const DEFAULT_CONFIG = {
  /** off | user | system | both —— user 是唯一稳定送达模型的位置 */
  mode: 'off',
  /** 只在带工具定义的 agent-loop 请求上注入，标题生成之类的内部调用不动 */
  onlyAgentLoop: true,
  log: true,
  /**
   * 拒绝重试：只看开头，发现是拒绝就丢掉这次尝试、静默重发。
   * 缓冲窗口只覆盖开头一两句，所以正常回复的流式只慢一点点，
   * 而不是 relay 那种「整段生成完才判断、完全没有流式」。
   */
  retry: {
    enabled: false,
    /** 重发次数上限（不含第一次） */
    maxRetries: 2,
    /** 预读字符上限：正文超过这个长度就认定不是拒绝，立刻放行 */
    peekChars: 200,
    /** 预读时间上限（从收到第一块算起），防止模型吐字慢时卡住 */
    peekMs: 1200,
    /** 正文起头后至少要看够这么多字才下结论（「这个忙不能帮」只有 7 个字） */
    minTextChars: 24,
    /** 正文刚起头就断流超过这么久，才认输放行 */
    textStallMs: 1500,
    /** 正文迟迟不出现时的总等待上限：模型可能先推理很久再开口。
     *  1M 上下文下推理动辄 5000+ 字、几十秒，10s 会把这类请求直接放走
     *  （旧值让 policy.log 里出现 89 次 wait-reasoning，即 89 次没判定就放行）。 */
    maxWaitMs: 30000,
    /** 推理停住这么久、且已超过 maxWaitMs，才认输放行；推理还在滚就继续等 */
    reasoningStallMs: 4000,
    /** 重发前的退避，毫秒 */
    backoffMs: 350,
  },
};

let policyCache = { mtimeMs: 0, text: '' };
let configCache = { mtimeMs: 0, value: DEFAULT_CONFIG };

function readPolicy() {
  try {
    const st = fs.statSync(POLICY_PATH);
    if (st.mtimeMs !== policyCache.mtimeMs) {
      const text = fs.readFileSync(POLICY_PATH, 'utf8').replace(/\r\n/g, '\n').trim();
      // 半截写入保护：没有收尾标签就继续用上一份完整文本
      if (text.includes('<content_policy>') && text.length > 200) {
        policyCache = { mtimeMs: st.mtimeMs, text };
      }
    }
  } catch {
    /* 文件不在就返回缓存（首次为空则跳过注入） */
  }
  return policyCache.text;
}

function readConfig() {
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (st.mtimeMs !== configCache.mtimeMs) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      configCache = { mtimeMs: st.mtimeMs, value: { ...DEFAULT_CONFIG, ...raw } };
    }
  } catch {
    /* 配置坏了就用默认值，不因为读配置失败把请求搞挂 */
  }
  return configCache.value;
}

function log(line) {
  try {
    const cfg = readConfig();
    if (!cfg.log) return;
    try {
      if (fs.statSync(LOG_PATH).size > MAX_LOG) fs.renameSync(LOG_PATH, LOG_PATH + '.1');
    } catch {}
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

/** 政策前 80 字，用来判断「这段已经注入过了」。比只认标签更不容易误判。 */
function needleOf(policy) {
  return policy.slice(0, 80);
}

/** 从一段文本里剥掉之前注入的政策尾巴，返回剥完的结果。 */
function stripPolicy(text, needle) {
  const at = text.indexOf(needle);
  if (at < 0) return text;
  return text.slice(0, at).replace(/\s+$/, '');
}

function textOf(block) {
  return block && block.type === 'text' && typeof block.text === 'string' ? block.text : null;
}

/**
 * 把政策挂到末条 user 消息末尾。
 * 消息与 content 数组都可能被冻结，所以逐层复制再替换。
 * @returns {messages, changed, where}
 */
function injectIntoLastUser(messages, policy) {
  const needle = needleOf(policy);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;

    const content = message.content;
    if (typeof content === 'string') {
      if (content.includes(needle)) return { messages, changed: false, where: 'present' };
      const next = messages.slice();
      next[i] = { ...message, content: `${content}\n\n${policy}` };
      return { messages: next, changed: true, where: `user#${i}/string` };
    }
    if (!Array.isArray(content)) continue;

    let last = -1;
    for (let j = content.length - 1; j >= 0; j--) {
      if (textOf(content[j]) !== null) {
        last = j;
        break;
      }
    }

    const next = messages.slice();
    if (last < 0) {
      next[i] = { ...message, content: [...content, { type: 'text', text: `\n\n${policy}` }] };
      return { messages: next, changed: true, where: `user#${i}/new-block` };
    }
    const block = content[last];
    if (block.text.includes(needle)) return { messages, changed: false, where: 'present' };
    const blocks = content.slice();
    blocks[last] = { ...block, text: `${block.text}\n\n${policy}` };
    next[i] = { ...message, content: blocks };
    return { messages: next, changed: true, where: `user#${i}/block${last}` };
  }
  return { messages, changed: false, where: 'no-user' };
}

/**
 * 末条不是 user（多步工具调用时会是这样）时，把历史上旧的那份剥掉，
 * 再在末尾补一条只含政策的 user 消息 —— 保证「只有一份、且永远贴着当前位置」。
 */
function reinjectAtTail(messages, policy) {
  const needle = needleOf(policy);
  let touched = 0;
  const stripped = messages.map((message) => {
    const content = message?.content;
    if (typeof content === 'string') {
      const t = stripPolicy(content, needle);
      if (t !== content) {
        touched++;
        return { ...message, content: t };
      }
      return message;
    }
    if (!Array.isArray(content)) return message;
    let dirty = false;
    const blocks = content.map((block) => {
      const t = textOf(block);
      if (t === null) return block;
      const s = stripPolicy(t, needle);
      if (s === t) return block;
      dirty = true;
      return { ...block, text: s };
    });
    if (!dirty) return message;
    touched++;
    return { ...message, content: blocks };
  });

  const last = stripped[stripped.length - 1];
  if (last && last.role === 'user') {
    return injectIntoLastUser(stripped, policy); // 前一条就是 user，不能连发两条
  }
  const withTail = stripped.concat([{ role: 'user', content: [{ type: 'text', text: policy }] }]);
  return { messages: withTail, changed: true, where: `tail-new-user(strip=${touched})` };
}

function applyPolicy(options) {
  const cfg = readConfig();
  if (cfg.mode === 'off' || !cfg.mode) return;
  if (!options || !Array.isArray(options.messages)) return;
  if (cfg.onlyAgentLoop && !(Array.isArray(options.tools) && options.tools.length > 0)) return;

  const policy = readPolicy();
  if (!policy) {
    log('skip: policy file empty or unreadable');
    return;
  }

  const last = options.messages[options.messages.length - 1];
  const atTail = last && last.role === 'user';
  const result = atTail
    ? injectIntoLastUser(options.messages, policy)
    : reinjectAtTail(options.messages, policy);

  let changedSystem = false;
  if (cfg.mode === 'system' || cfg.mode === 'both') {
    const current = typeof options.system === 'string' ? options.system : '';
    if (!current.includes(needleOf(policy))) {
      try {
        options.system = current ? `${current}\n\n${policy}` : policy;
        changedSystem = true;
      } catch {}
    }
  }

  if (result.changed) {
    try {
      options.messages = result.messages;
    } catch {
      try {
        Object.defineProperty(options, 'messages', {
          value: result.messages,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch {
        // dsh 在把请求交给 llm/stream 之前就 Object.freeze 了 messages，
        // 这里必然写不进去。不是配置问题，是这个扩展点根本不支持改请求。
        // 留一条明确的日志，免得以后又误判成「插件已接管」。
        log('skip: options.messages frozen by loop — 注入只能走 relay');
        return;
      }
    }
  }

  if (!result.changed && !changedSystem) {
    log(`noop where=${result.where} n=${options.messages.length}`);
    return;
  }
  log(
    `inject where=${result.where} mode=${cfg.mode} chars=${policy.length} ` +
      `n=${options.messages.length}${changedSystem ? ' +system' : ''}`,
  );
}

/* ------------------------------------------------------------------ *
 * 拒绝重试
 *
 * 为什么要自己做，而不是用 relay 的重试：
 * relay 在 HTTP 层看不到「说完了没有」，只能把整段回复缓冲下来再判断，
 * 代价是彻底没有流式。插件拿到的是 chunk 流，可以只看开头一两句就下结论，
 * 正常回复几乎无感，被拒的那次用户根本看不见——因为在放行之前一个 byte
 * 都没吐给上层。
 *
 * 重发的机制不是什么私有 API：cordis 的 waterfall 里 next() 每次调用都会
 * 消耗掉一个 listener，链走空之后再调用就落到最内层的 adapterStream，
 * 也就是「同一个请求再发一次」。而 adapterStream 的 finally 在流没跑完时
 * 会调用底层 iterator.return()，所以丢弃第一次尝试时底层连接会被关掉。
 * ------------------------------------------------------------------ */

/**
 * 「开口就拒」的形状。只测开头一小段，宁可漏判也不误判——
 * 误判的代价是把正常回答从头重来一次，白烧 token 还会闪屏。
 * 每条都要求否定词后面跟受事者（帮你 / 写 / 生成…），
 * 免得「我无法提供具体数字，但…」这种正常内容被当成拒绝。
 *
 * 2026-11-08：原来受事者表里只有 帮你/协助/做/完成 一类，
 * 而「这个我不能写」「我无法写这个」这种最典型的拒绝里一个都不含，
 * 于是四条中文正则全部落空、被判成正常句子放行。补了两类：
 *   a) 写/生成/创作/撰写/续写/描述/讲述/制作 —— 进受事者表，但必须再过一道
 *      「宾语收尾」检查 VERB_TAIL。没有这道检查会误伤技术句：
 *      「我不能写死端口，得从配置读」「这个类的构造器不能写 const」
 *      都是正常内容，却会被当成拒绝整段重发。
 *   b) 提供/回答/输出/给出 —— 另起一条，要求后面紧跟限定词
 *      （这类/这种/该/此/相关/任何/这个），
 *      「我无法提供具体数字，但是可以估算」「这个功能我不能提供 demo 之外的行为」
 *      都不会命中。
 */
const REFUSAL_OPEN = [
  /* 抱歉/遗憾 … 不能/无法 + 受事者（帮/做/完成 一类） */
  /^[\s"'“”‘’「」]*(?:非常|很)?(?:抱歉|对不起|很遗憾|遗憾)[，,。.！!、；;\s]*(?:我)?[^。！？\n]{0,30}?(?:不能|无法|不会|没办法|不便|拒绝)(?:帮你|帮您|协助|为你|为您|向你|向您|满足|参与|做|完成)/,
  /* 抱歉/遗憾 … 不能/无法 + 动作词 + 宾语收尾 */
  /^[\s"'“”‘’「」]*(?:非常|很)?(?:抱歉|对不起|很遗憾|遗憾)[，,。.！!、；;\s]*(?:我)?[^。！？\n]{0,30}?(?:不能|无法|不会|没办法|不便|拒绝)(?:写|生成|创作|撰写|续写|描述|讲述|制作)(?!得)(?=$|[。！？!?，,、；;…—]|这个|这些|这类|这种|那种|它|任何|相关|你的|您的)/,
  /* 我不能/无法 + 受事者（帮你 / 做这个 / 完成该…） */
  /^[\s"'“”‘’「」]*(?:我)?(?:不能|无法|不会|没办法|不便|拒绝)(?:帮你|帮您|协助你|协助您|为你|为您|向你|向您|满足你|满足您|参与这个|做这个|完成这个|完成该)/,
  /* 我不能/无法 + 动作词 + 宾语收尾（「我不能写」「我无法写这个」「我不能写。」） */
  /^[\s"'“”‘’「」]*(?:我)?(?:不能|无法|不会|没办法|不便|拒绝)(?:写|生成|创作|撰写|续写|描述|讲述|制作)(?!得)(?=$|[。！？!?，,、；;…—]|这个|这些|这类|这种|那种|它|任何|相关|你的|您的)/,
  /* 我不能/无法 + 提供/回答/输出/给出 + 限定词（防误伤：必须有「这类/这个…」） */
  /^[\s"'“”‘’「」]*(?:我)?(?:不能|无法|不会|没办法|不便|拒绝)(?:提供|回答|输出|给出)(?:这类|这种|该|此|相关|任何|这个|这些|你的|您的要求|你要求|你提的|您提的)/,
  /* 抱歉，这个…不能/做不到 */
  /^[\s"'“”‘’「」]*(?:非常|很)?(?:抱歉|对不起)[，,。.！!、；;\s]*(?:这个|这件事|这)[^。！？\n]{0,20}(?:做不了|帮不了|不行|不可以|做不到|不能)/,
  /* 这个/这件事/这类… + 我 + 不能/无法 + 动作（「这个我不能写」「这类内容我不能生成」）
     必须带「我」：否则「这个类的构造器不能写 const」也会命中 */
  /^[\s"'“”‘’「」]*(?:这个|这件事|这类|这种|该类)[^。！？\n]{0,12}?我(?:不能|无法|不会|没法|不便|不)(?:写|生成|创作|撰写|续写|描述|讲述|提供|回答|输出|给出|做|帮|完成)(?=$|[。！？!?，,、；;…—]|这个|这些|这类|这种|它|任何|相关|你的|您的)/,
  /* 这个… + 帮不了/做不了/做不到 */
  /^[\s"'“”‘’「」]*(?:这个|这件事|这)[^。！？\n]{0,12}(?:我)?(?:帮不了|做不了|做不到|不能帮|无法帮)/,
  /^[\s"'“”]*(?:i'?m sorry|sorry)[,.! ]*(?:but )?(?:i )?(?:can'?t|cannot|won'?t|am unable|'m unable|'m not able)/i,
  /^[\s"'“”]*(?:i )?(?:can'?t|cannot|won'?t|am unable to|'m unable to)(?: help| assist| do| provide| participate| write| create| generate| produce)/i,
  /* 「抱歉，我不能提供…」——开头带「抱歉」的提供类拒绝，原规则只覆盖了「抱歉+帮你/协助」 */
  /^[\s"'“”‘’「」]*(?:非常|很)?(?:抱歉|对不起|很遗憾|遗憾)[，,。.！!、；;\s]*(?:我)?[^。！？\n]{0,20}?(?:不能|无法|不会|没办法|不便|拒绝)(?:提供|回答|输出|给出|协助|参与)/,
  /* 中文后置否定：主题在前、否定在后
     「继母与继子这类家庭亲属关系的性内容我不写——这条线我换掉了」
     前面几条都以「抱歉/我不能/我无法」开头，抓不到这种句式。 */
  /^[^。！？\n]{0,50}?(?:这类|这种|此类|该类|这个题材|这个话题|题材|内容|关系)[^。！？\n]{0,30}?我(?:不写|不做|不参与|不提供|不协助|不生成|不创作|不碰|不接|换掉|替换)(?:了)?(?=$|[。！？!?，,、；;—…])/,
  /* 「……这条线/这部分 我换掉了 / 略过 / 跳过」
     只认「这条线/这部分/这块」，且否定词后必须是标点或「了」，
     避免「这个函数我不写注释」这类技术表述误命中。 */
  /^[^。！？\n]{0,60}?(?:这条线|这部分|这块)[^。！？\n]{0,12}?我(?:换掉|去掉|略过|跳过|不写|不做)(?:了)?(?=$|[。！？!?，,、；;—…])/,

  /* ================= 2026-11-10 扩充：公开语料中的拒绝形态 =================
   * 语料来源：arXiv 2409.18025 / 2510.17006（208 条拒绝短语）、
   * 2406.12975（四类拒绝模板）、2506.04975（中文拒绝模式）、
   * 以及常见「换话题式」偏转。按句式归纳，不为每句单列。
   */

  /* 英文：道歉/遗憾 + 拒绝
     I'm sorry, but I can't / I apologize, but I cannot / My apologies, but I can't /
     I'm afraid I can't / Sorry, I'm unable to */
  /^[\s"'“”]*(?:(?:i'?m|i am)\s+)?(?:really\s+|very\s+|so\s+|truly\s+|terribly\s+)?(?:sorry|apolog(?:y|ies|ize|ise)|afraid)\b[^.!?\n]{0,50}?\b(?:can'?t|cannot|can not|won'?t|will not|unable|not able|must\s+(?:decline|refuse)|not\s+(?:allowed|permitted|authori[sz]ed|comfortable))\b/i,

  /* 英文：直接拒绝动词 + 受事者
     I cannot assist / I won't provide / I must decline / I refuse to ... */
  /^[\s"'“”]*(?:but\s+|however,?\s+)?(?:i\s+)?(?:can'?t|cannot|can not|won'?t|will not|am unable to|am not able to|refuse to|must\s+(?:decline|refuse)|have to\s+(?:decline|refuse)|need to\s+(?:decline|refuse))\s+(?:help|assist|provide|comply|fulfil|answer|respond|do|create|generate|write|share|give|offer|support|process|complete|address|disclose|participate|engage|discuss|continue|elaborate)/i,

  /* 英文：Unfortunately / Regrettably / Sadly 开头 */
  /^[\s"'“”]*(?:unfortunately|regrettably|sadly|i'?m afraid)\b[,.:;\s]+(?:i\s+)?(?:can'?t|cannot|am (?:not\s+)?(?:able|unable)|won'?t|must\s+decline)/i,

  /* 英文：AI 身份声明（As an AI / As a language model） */
  /^[\s"'“”]*(?:as an? (?:ai|a\.i\.|language model|ai assistant|ai model|artificial intelligence|llm))\b/i,

  /* 英文：政策/原则/条款类拒绝
     This request violates my guidelines / That goes against my policies */
  /^[\s"'“”]*(?:(?:this|that|it)\s+(?:request|query|question|topic|content|kind of request)\s*)?(?:is\s+|violates\s+|breaches\s+|goes against\s+|is against\s+|falls outside\s+|is outside\s+|is beyond\s+)[^.!?\n]{0,40}?\b(?:my|our|the)\b[^.!?\n]{0,25}?(?:polic|guideline|principle|rule|term|ethic|programming|design|scope|capabilit)/i,

  /* 英文：against / outside / beyond my guidelines|scope|capabilities */
  /^[\s"'“”]*(?:against|contrary to|outside of|beyond|not within)\s+(?:my|our|the|what i)\b[^.!?\n]{0,30}?\b(?:polic|guideline|principle|term|ethic|scope|capabilit|ability|design|programming)/i,

  /* 英文：I'm not allowed/permitted/authorized/comfortable/willing to ... */
  /^[\s"'“”]*(?:i'?m|i am)\s+(?:not\s+)?(?:allowed|permitted|authori[sz]ed|comfortable|willing|going)\s+to\s+(?:help|assist|provide|discuss|share|create|generate|write|answer|respond|engage|participate|do|give|offer)/i,

  /* 英文：偏转 — That's not something I can help with / This isn't a topic I can cover */
  /^[\s"'“”]*(?:that'?s|this is|it'?s|that is|this isn'?t|that isn'?t)\s+(?:not\s+)?(?:something|a topic|a subject|an area|a request|a question)\s+(?:i|we)\s+(?:can|could|'?m able|are able|will|would|am able)/i,

  /* 英文：I'd rather not / I'd prefer not to */
  /^[\s"'“”]*(?:i'?d rather not|i would rather not|i'?d prefer not to|i would prefer not to|i don'?t feel comfortable|i do not feel comfortable)\b/i,

  /* 英文：换话题式（Let's talk about something else / Let's switch topics） */
  /^[\s"'“”]*(?:let'?s|maybe we should|perhaps we should|we should|i'?d suggest we|how about we)\s+(?:talk about|discuss|focus on|choose|pick|move on|switch|change|stay on|keep|pivot|redirect|move our)[^.!?\n]{0,40}?\b(?:something else|another|different|other|topic|subject|elsewhere|direction)/i,

  /* 英文：Due to legal/ethical/policy ... I cannot */
  /^[\s"'“”]*(?:due to|because of|given)\s+(?:legal|ethical|policy|safety|privacy|security|the nature of|my (?:programming|design|guidelines|limitations))/i,

  /* 英文：This is outside/beyond my scope|capabilities|knowledge
     只认「my/what I」或「the + 直接跟 scope」，
     否则「This is beyond the current scope of the project」这种技术描述会误判。 */
  /^[\s"'“”]*(?:this|that|it)\s+(?:is\s+)?(?:outside|beyond)\s+(?:(?:my|what i)\b[^.!?\n]{0,25}?(?:scope|capabilit|ability|knowledge|expertise|bounds|remit|jurisdiction)|the\s+(?:scope|capabilit|ability|remit|bounds))/i,

  /* 中文：超出能力/知识/服务范围（「这个问题超出了我的知识范围」） */
  /^[\s"'“”‘’「」]*(?:这个|这|此|该|这个问题|该问题|这种|这类)?[^。！？\n]{0,18}?(?:超出|超出了|超过|超越了)(?:我的|我|自身|自己的)?(?:能力|知识|认知|服务|职责|专业|范围|权限)/,

  /* 中文：作为 AI / 作为语言模型（「作为一个人工智能助手，我不能…」） */
  /^[\s"'“”‘’「」]*(?:作为|身為|身为)(?:一个|一名|一位)?\s*(?:AI|ai|人工智能|语言模型|大模型|语言大模型|智能助手|AI助手|人工智能助手|聊天机器人)/,

  /* 中文：必须/不得不 拒绝 */
  /^[\s"'“”‘’「」]*(?:我)?(?:必须|必須|不得不|只好|只能择|只能)(?:拒绝|拒絕|婉拒|谢绝|回避|中止)/,

  /* 中文：出于安全/合规/法律/政策/伦理考虑，我不能 */
  /^[\s"'“”‘’「」]*(?:出于|基于|鉴于|考虑到)(?:安全|合规|法律|政策|伦理|道德|隐私|版权|相关规定)[^。！？\n]{0,12}?(?:考虑|原因|要求|规定|限制)?[，,]?\s*(?:我)?(?:不能|无法|不便|不会|拒绝)/,

  /* 中文：换话题式（我们换个话题 / 不如聊点别的） */
  /^[\s"'“”‘’「」]*(?:我们|咱们|不如|要不|或许我们|也许我们)[^。！？\n]{0,12}?(?:换个话题|换一个话题|聊点别的|说点别的|谈点别的|讨论别的|换个方向|聊别的|换个内容|换个主题)/,

  /* 中文：请理解，我不能/无法 */
  /^[\s"'“”‘’「」]*请(?:你|您)?理解[，,][^。！？\n]{0,20}?(?:我)?(?:不能|无法|不便|不会)/,

  /* 中文：我 + 拒绝类动词 + 拒绝类受事者
     受事者只收「回答/提供/处理/讨论」这类，不收「连接/解析/加载/编译」，
     否则「无法连接数据库」「无法解析文件」这类技术故障会被误判成拒绝。 */
  /^[\s"'“”‘’「」]*(?:我)?(?:不能|无法|没办法|没法|不会|不便|拒绝|拒絕)(?:回答|回复|回覆|答复|處理|处理|執行|执行|完成|满足|滿足|支持|参与|參與|讨论|討論|展开|展開|继续|繼續|给出|給出|告诉你|告訴你|向你|向您)/,

  /* ================= DeepSeek-V4.1 实测拒答形态（2026-11-10 采集） =================
   * 用 20 条会触发拒绝的请求实调 cn:deepseek-v4.1-flash（挂 5286 字节破甲文本），
   * 拿到的是「破甲后仍然拒绝」的硬样本。它的句式跟通用语料差别很大：
   * 句子极短、宾语是具体名词而不是「这类/这个」，且常用「帮你/给你/把字句」。
   */

  /* 我 + 否定 + 提供/给出/输出/说明 + 任意宾语
     「我不能提供甲基苯丙胺的合成步骤、前体清单、配比…」
     「我不能提供简易爆炸装置的配方、配比或组装步骤。」
     「我不能提供制作指南。」
     现有规则要求「提供」后必须跟「这类/这个」，这三条全部漏判。
     宾语段排除逗号/分号：拒绝句是一条路走到底（中间只可能有顿号），
     而「我无法提供实时数据，但可以按公开资料估算」会在逗号处断掉，不误判。 */
  /^[\s"'“”‘’「」]*(?:我)?(?:不能|不会|无法|没办法|没法|不便)(?:提供|给出|输出|说明|列出|教授)(?:你|您)?[^。！？\n，,；;]{0,45}?(?=$|[。！？!?；;—…])/,

  /* 我 + 否定 + 帮你/帮您 + 动词
     「这个我没法帮你写。」「我不能帮你设计规避监管的方案。」 */
  /^[\s"'“”‘’「」]*(?:我)?(?:不能|不会|无法|没法|没办法|不便)(?:帮你|帮您|为你|为您|代你|替你)[^。！？\n]{0,12}?(?:写|做|设计|提供|生成|创作|处理|完成|绕过|实现|搞|弄|编|改)/,

  /* 我 + 不会 + 给你/您 + 名词
     「我不会给你方法。」 */
  /^[\s"'“”‘’「」]*(?:我)?(?:不会|不能|无法|没法|没办法)(?:给你|给您|向你|向您)[^。！？\n]{0,25}?(?=$|[。！？!?，,、；;—…])/,

  /* 我 + 否定 + 把字句
     「我没办法把整章逐字复现出来。」 */
  /^[\s"'“”‘’「」]*(?:我)?(?:不能|不会|无法|没法|没办法|不便)把[^。！？\n]{0,45}?(?:出来|给你|给您|写|复现|输出|提供|生成|讲|说)/,

  /* 抱歉/对不起 + 我 + 不能 + 动作 + 任意宾语（放宽尾部）
     「抱歉，我不能写煽动对任何民族仇恨的内容。」
     「写」后面跟「得」的排除掉：「抱歉，我无法写得更长」是能力说明不是拒绝。 */
  /^[\s"'“”‘’「」]*(?:非常|很|实在|真的)?(?:抱歉|对不起|不好意思)[，,。.！!、；;\s]*(?:我)?[^。！？\n]{0,15}?(?:不能|不会|无法|没法|没办法)(?:写(?!得)|提供|生成|创作|回答|协助|帮你|帮您)[^。！？\n，,；;]{0,45}?(?=$|[。！？!?，,、；;—…])/,

  /* 这个/这类 + 我 + 否定 + 帮你/给你 + 动词
     「这个我不能帮你做」「这个我没法帮你写」
     现有「这个+我+不能+动作」要求否定词后直接跟动作，漏了「帮你」这个中间词。 */
  /^[\s"'“”‘’「」]*(?:这个|这件事|这类|这种|该|此)[^。！？\n]{0,12}?我(?:不能|不会|无法|没法|没办法|不便)(?:帮你|帮您|给你|给您|替你|代你)[^。！？\n]{0,10}?(?:写|做|提供|生成|处理|完成|设计|搞|弄|编)?/,
];

/** 一段开头文本是不是拒绝。 */
export function looksRefusalHead(text) {
  const head = String(text || '').replace(/\r/g, '').slice(0, 200);
  if (!head.trim()) return false;
  return REFUSAL_OPEN.some((re) => re.test(head));
}

/** 句末标点：到这里就算「第一句说完了」，可以下结论。 */
const SENTENCE_END = /[。！？!?\n]/;

/**
 * 供应商侧强制断流（不是模型拒答）的特征词。
 *
 * 这类终止来自上游风控，重发同一个请求只会被再切一次，
 * 重试纯属白烧 token，还会把「被切」伪装成「模型不肯答」。
 * 命中就把这次当作终局，不再重试，并在日志里单独打一行。
 */
const FILTER_HINTS = [
  'content_filter',
  'content_filtered',
  'content management policy',
  'guardrail_intervened',
  'safety system',
  'risk control',
  'sensitive',
  '不合规',
  '敏感',
];

/** 附在被风控切掉的失败信息尾巴上的人话。只加 message，不动 code。 */
const FILTER_NOTE = '（供应商侧强制断流：重发同一请求会被再切一次，已停止重试）';

/**
 * 解析终止块。返回 null 表示「这不是终止块」或「正常结束」。
 *
 * 流协议里终止块的形状是 `{ type:'finish', reason }`：
 *   reason.kind = 'stop' | 'tool-calls' | 'max-tokens' | 'error' | 'aborted'
 *   error/aborted 时带 reason.failure = { code, message, status? }
 */
export function terminalOutcome(chunk) {
  if (!chunk || chunk.type !== 'finish') return null;
  const reason = chunk.reason || {};
  if (reason.kind === 'aborted') return { kind: 'aborted', message: '' };
  if (reason.kind !== 'error') return null;
  const failure = reason.failure || {};
  const probe = `${failure.code || ''} ${failure.message || ''}`.toLowerCase();
  if (!FILTER_HINTS.some((hint) => probe.includes(hint))) return null;
  return { kind: 'filter', message: failure.message || '', code: failure.code || '' };
}

/**
 * 给终止块的失败信息补一句人话。
 * 只加在 message 尾部，code / status 原样不动，不影响上层的错误归类。
 */
function annotateFilterChunk(chunk, note) {
  const reason = chunk && chunk.reason;
  const failure = reason && reason.failure;
  if (!failure || typeof failure.message !== 'string') return chunk;
  if (failure.message.includes(note)) return chunk;
  return { ...chunk, reason: { ...reason, failure: { ...failure, message: `${failure.message}${note}` } } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 包住一次模型调用，发现开头是拒绝就丢弃并重发。
 *
 * 放行判定（任一满足即可）：
 *   - 第一句说完（句末标点）
 *   - 正文累计到 peekChars
 *   - 出现工具调用或非文本块
 *   - 正文只蹦了几个字就断流超过 stallMs（真拒绝不会中途停住）
 * 推理链不算正文：它再长也不构成放行理由，否则「想很久、然后拒绝」这种
 * 最常见的形状就会被漏掉。正文迟迟不来的兜底是 maxWaitMs。
 * 正文一旦开始，至少要看够 minText 字才允许放行 —— 只看到两个字就放行，
 * 正是 2026-11-05 那次漏判（正文 2 字时被时间上限放走）的原因。
 * 在放行之前，一个 chunk 都不往上传——所以重试对用户是无痕的。
 *
 * 终止块优先于上面一切判定：收到 finish 且 reason 指向供应商侧断流
 * （content_filter 一类）时，这次尝试当场结束、绝不重发，并把失败信息
 * 补一句人话交给上层。否则会出现「重试两次、三次一样的断流、最后报错」，
 * 让一次明确的风控拦截看起来像偶发故障。
 *
 * @param {() => AsyncIterable} next waterfall 的下一环；重复调用会重发请求
 * @param {object} options 请求参数（含 signal）
 * @param {object} cfg 已合并默认值的配置
 */
export async function* guardedStream(next, options, cfg) {
  const retry = cfg.retry || DEFAULT_CONFIG.retry;
  const max = Math.max(0, Number(retry.maxRetries) || 0);
  const peekChars = Math.max(24, Number(retry.peekChars) || 200);
  const peekMs = Math.max(200, Number(retry.peekMs) || 1200);
  const maxWaitMs = Math.max(1000, Number(retry.maxWaitMs) || 30000);
  const reasoningStallMs = Math.max(500, Number(retry.reasoningStallMs) || 4000);
  const backoffMs = Math.max(0, Number(retry.backoffMs) || 0);
  /** 正文起头后至少要看够这么多字才允许下结论（「这个忙不能帮」才 7 个字节） */
  const minText = Math.max(8, Number(retry.minTextChars) || 24);
  /** 正文断流这么久还没够字，才认输放行（真拒绝不会中间停住） */
  const stallMs = Math.max(300, Number(retry.textStallMs) || peekMs);
  /** 兜底：无论卡在哪，到这里都必须放行，不能把请求挂着 */
  const hardMs = maxWaitMs + 20000;
  const signal = options && options.signal;

  for (let attempt = 0; ; attempt++) {
    const iterator = next()[Symbol.asyncIterator]();
    const buffered = [];
    let text = '';
    let reasoningChars = 0;
    let chunks = 0;
    let firstAt = 0;
    let lastTextAt = 0;
    let lastReasoningAt = 0;
    let decided = false;
    let refused = false;
    let leaked = false;
    let why = '';

    try {
      while (true) {
        const step = await iterator.next();
        if (step.done) break;
        const chunk = step.value;
        if (firstAt === 0) firstAt = Date.now();

        // 终止块优先：上游风控断流时重发没有意义，直接收摊。
        const terminal = terminalOutcome(chunk);
        if (terminal) {
          chunks++;
          if (terminal.kind === 'filter') {
            log(
              `filter stop text=${text.length} chunks=${chunks} decided=${decided ? why : 'no'} ` +
                `code=${terminal.code} msg=${JSON.stringify(terminal.message.slice(0, 90))}`,
            );
          } else {
            log(`aborted chunks=${chunks} text=${text.length} decided=${decided ? why : 'no'}`);
          }
          const out = terminal.kind === 'filter' ? annotateFilterChunk(chunk, FILTER_NOTE) : chunk;
          if (!decided) {
            decided = true;
            why = terminal.kind;
            for (const c of buffered) {
              leaked = true;
              yield c;
            }
            buffered.length = 0;
          }
          leaked = true;
          yield out;
          break;
        }

        if (!decided) {
          buffered.push(chunk);
          chunks++;
          if (chunk && chunk.type === 'text-delta') {
            text += chunk.text || '';
            lastTextAt = Date.now();
            if (looksRefusalHead(text)) {
              refused = true;
              decided = true;
              why = 'refusal';
            } else if (text.length >= 12 && SENTENCE_END.test(text)) {
              decided = true;
              why = 'sentence';
            } else if (text.length >= peekChars) {
              decided = true;
              why = 'chars';
            }
          } else if (chunk && chunk.type === 'reasoning-delta') {
            // 推理不是正文：模型完全可能先想几千字再拒绝，这里不拿它当放行条件，
            // 只累计长度用于日志。真正的等待上限是下面的 maxWaitMs。
            reasoningChars += (chunk.text || '').length;
            lastReasoningAt = Date.now();
          } else if (chunk && chunk.type === 'block-start' && chunk.blockType !== 'text' && chunk.blockType !== 'reasoning') {
            decided = true;
            why = 'tool-block';
          }
          if (!decided && firstAt > 0) {
            const waited = Date.now() - firstAt;
            if (text.length === 0) {
              // 正文还没出现：给推理链 maxWaitMs。它再长也不构成放行理由。
              // 但只等时间会误放：1M 上下文下推理本来就长，所以要求
              // 「已超过 maxWaitMs」且「推理已经停住 reasoningStallMs」两条同时成立。
              // 推理还在往下滚就继续等，说明模型在工作，不是卡死。
              const idle = Date.now() - (lastReasoningAt || firstAt);
              if (waited > maxWaitMs && idle > reasoningStallMs) {
                decided = true;
                why = 'wait-reasoning';
              }
            } else if (text.length < minText && Date.now() - lastTextAt > stallMs) {
              // 正文只蹦了几个字就断流：不能再等，否则请求会一直挂着不响
              decided = true;
              why = 'text-stall';
            } else if (waited > hardMs) {
              decided = true;
              why = 'hard-cap';
            }
          }

          if (refused) break;
          if (decided) {
            log(`peek ok chunks=${chunks} text=${text.length} reasoning=${reasoningChars} why=${why}`);
            for (const c of buffered) {
              leaked = true;
              yield c;
            }
            buffered.length = 0;
          }
          continue;
        }

        leaked = true;
        yield chunk;
      }
    } finally {
      // 没被放行就丢弃这次尝试：关掉底层请求，别让它在后台继续烧 token
      if (!leaked) {
        try {
          await iterator.return?.();
        } catch {
          /* 关不掉就算了，重点是别把它吐给上层 */
        }
      }
    }

    if (!refused) {
      if (!decided) log(`peek ok chunks=${chunks} text=${text.length} reasoning=${reasoningChars} why=eof`);
      for (const c of buffered) yield c;
      return;
    }

    if (attempt >= max) {
      // 次数字了：把最后一次的拒绝原样交给上层，至少用户看得见
      log(`retry exhausted after ${attempt} retries head=${JSON.stringify(text.slice(0, 40))}`);
      for (const c of buffered) yield c;
      return;
    }

    log(`retry ${attempt + 1}/${max} head=${JSON.stringify(text.slice(0, 40))}`);
    if (signal && signal.aborted) {
      for (const c of buffered) yield c;
      return;
    }
    if (backoffMs > 0) await sleep(backoffMs);
  }
}

export function apply(ctx) {
  ctx.on(
    'llm/stream',
    (options, next) => {
      try {
        applyPolicy(options);
      } catch (error) {
        // 注入失败绝不能拖垮请求本身：原样放行，只记一笔
        log(`ERROR ${error && error.stack ? error.stack.split('\n')[0] : error}`);
      }

      const cfg = readConfig();
      if (!cfg.retry || !cfg.retry.enabled) return next();
      if (cfg.onlyAgentLoop && !(Array.isArray(options && options.tools) && options.tools.length > 0)) return next();
      if (!options || !Array.isArray(options.messages)) return next();
      if (options.signal && options.signal.aborted) return next();

      return guardedStream(next, options, cfg);
    },
    { global: true, prepend: true },
  );
  log(`loaded mode=${readConfig().mode} pid=${process.pid} hook=llm/stream`);
}
