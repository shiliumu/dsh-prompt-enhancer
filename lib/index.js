/**
 * 提示词增强器 —— Host 侧。
 *
 * 暴露一条同源 HTTP 路由，把输入框草稿交给本地已配置的模型（默认 flash）改写成
 * 结构清晰的提示词，返回若干候选。模型/provider 由浏览器侧从 modelCatalog 里挑好
 * 后随请求带上，Host 只负责真正的模型调用与输出切分。
 *
 * @module @linxin666/dsh-prompt-enhancer
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 加载留痕：Host 每次 mount 这个插件都追加一行，方便确认插件到底有没有被加载。
 * 只写临时目录，失败静默。
 */
function markLoaded(reason) {
  try {
    appendFileSync(
      join(tmpdir(), 'dsh-prompt-enhancer.log'),
      `${new Date().toISOString()} loaded (${reason}) pid=${process.pid}\n`,
      'utf8',
    );
  } catch {
    /* 诊断留痕失败不影响插件 */
  }
}

/** 稳定的 cordis 插件名。 */
const name = 'prompt-enhancer';
/** 依赖服务：HTTP 路由注册表 + LLM 运行时。 */
const inject = ['webServer', 'llm'];

const ROUTE_PATH = '/prompt-enhancer/enhance';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_DRAFT_CHARS = 6000;
const MAX_OUTPUT_TOKENS = 2600;
const TIMEOUT_MS = 90_000;
const DEFAULT_CANDIDATES = 3;
const MAX_CANDIDATES = 6;
/** 单条候选最多几个待定点、每个待定点最多几个方向选项。 */
const MAX_GAPS_PER_CANDIDATE = 3;
const MAX_OPTIONS_PER_GAP = 4;

/** 生成器的系统提示词：只补结构、不编事实，并把"该由用户拍板"的点做成方向选项。 */
const SYSTEM_PROMPT = [
  '你是资深提示词工程师，把用户的口语化草稿改写成可直接交给 AI agent 执行的提示词。',
  '',
  '【工作流程】心里走完这四步，不要写出来：',
  '1. 判类型：排错 / 开发实现 / 调研查证 / 写作生成 / 数据处理，选最贴近的一类。',
  '2. 定策略：三条候选各用一个差异最大的策略（执行型 / 澄清型 / 诊断型 / 调研型 / 写作型）。',
  '3. 套骨架：七槽逐条落地——目标、上下文、约束、交付物、验收、输出格式、不确定项。',
  '   每槽要么写具体内容，要么写 <待确认：…>。',
  '4. 自检：验收可执行吗？有编造吗？有元评论吗？长度失控吗？',
  '',
  '【硬性规则】',
  '1. 只补结构，不造事实：不添加草稿里没有的路径、函数名、版本号、报错、业务需求。',
  '2. 原样保留 @文件引用、/命令、路径、代码片段、报错原文、数字。',
  '3. 语言跟草稿一致；术语保持原样。',
  '4. 正文只写提示词：不要解释、前言、标题、编号、代码块围栏，也不要"如果需要我可以…"这类元评论。',
  '5. 每条候选自包含、可单独复制使用。',
  '6. 草稿已经足够清晰时不要硬套骨架，只做最小必要补全。',
  '7. 单条候选 120–400 字；信息不足时宁可短，把缺口写成 <待确认：…>。',
  '',
  '【待定点】这是本次输出的重点：凡是"你不该替用户决定"的地方，不要只留占位符，',
  '要在该候选下面用【待定】给出 2–4 个方向选项，让用户点选。',
  '选项之间必须是不同策略，不能是同一件事的程度差异（"30 分钟 / 2 小时"这种程度差异',
  '属于同一个选项里的取值，不要拆成两个选项）。每条候选最多 3 个待定点。',
  '',
  '【输出格式】严格按下面的纯文本格式输出，不要 JSON、不要代码块围栏、不要任何额外说明：',
  '',
  '【候选】',
  '（提示词正文，可以多行；正文里不确定的地方写 <待确认：…>）',
  '【待定】这次要动代码吗？',
  '- 只诊断不改代码 || 只做根因定位，暂不修改任何代码 || 最快、零风险；可能要多来一轮 ||',
  '- 诊断+修复 || 定位根因后直接给出并应用修复 || 一次到位；判断错会白改一轮 ||',
  '【待定】跑多久算稳？',
  '- 30 分钟 || 连续运行 30 分钟不再中断 || 只能抓到高频断连 || <待确认：时长>',
  '- 2 小时 || 连续运行 2 小时不再中断 || 能看出间歇性中断 || <待确认：时长>',
  '【候选】',
  '（第二条候选正文…）',
  '',
  '格式规则：',
  '1. 每条候选以单独一行的【候选】开头，正文写在第一个【待定】之前。',
  '2. 每个待定点一行【待定】+ 一句问句，紧跟着 2–4 行选项。',
  '3. 选项格式固定四段，用 || 分隔：- 标签 || 填充表述 || 效果 || 占位符',
  '   标签 ≤12 字；填充表述要能直接放进提示词；效果要具体（更快/更慢、更准/更糙、是否多一轮）；',
  '   正文里有对应的 <待确认：…> 就一字不差抄进第四段，没有就留空但保留行尾的 ||。',
  '4. 没有待定点的候选，不要写【待定】。',
].join('\n');

/** 收集请求体并解析 JSON。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed;
}

/** 统一的 JSON 响应。 */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 只允许本机来源；无法取得对端地址时（管道型 webserver）放行。
 * @param req - 原始 HTTP 请求。
 * @returns 是否允许处理。
 */
function isLocalRequest(req) {
  const address = req.socket?.remoteAddress;
  if (address === undefined || address === null || address === '') return true;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 拼装交给模型的用户消息。 */
function frameDraft(draft, count, direction) {
  const lines = [
    `请把下面这段草稿改写成 ${count} 条候选提示词，按约定的 JSON 格式输出。`,
    '',
    '<草稿>',
    draft,
    '</草稿>',
  ];
  if (typeof direction === 'string' && direction !== '') {
    lines.push('', `<额外要求>${direction}</额外要求>`);
  }
  return lines.join('\n');
}

/** 按 === 分隔线切分候选（结构化解析失败时的兜底）。 */
function splitCandidates(text, count) {
  return text
    .split(/^[ \t]*={3,}[ \t]*$/mu)
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .slice(0, count);
}

/** 从模型输出里抠出 JSON 对象（容忍代码块围栏和前后废话）。 */
function extractJsonObject(text) {
  const stripped = text.replace(/```[a-zA-Z]*\s*/gu, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 校验并裁剪模型给出的结构化候选。 */
function normalizeStructured(value, count) {
  const list = Array.isArray(value?.candidates) ? value.candidates : [];
  const out = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text === '') continue;
    const gaps = [];
    for (const gap of Array.isArray(item.gaps) ? item.gaps : []) {
      if (gaps.length >= MAX_GAPS_PER_CANDIDATE) break;
      if (gap === null || typeof gap !== 'object') continue;
      const question = typeof gap.question === 'string' ? gap.question.trim() : '';
      if (question === '') continue;
      const options = [];
      for (const option of Array.isArray(gap.options) ? gap.options : []) {
        if (options.length >= MAX_OPTIONS_PER_GAP) break;
        if (option === null || typeof option !== 'object') continue;
        const label = typeof option.label === 'string' ? option.label.trim() : '';
        if (label === '') continue;
        options.push({
          label,
          fill: typeof option.fill === 'string' && option.fill.trim() !== '' ? option.fill.trim() : label,
          effect: typeof option.effect === 'string' ? option.effect.trim() : '',
          placeholder: typeof option.placeholder === 'string' ? option.placeholder : '',
        });
      }
      if (options.length >= 2) gaps.push({ question, options });
    }
    out.push({ text, gaps });
  }
  return out.slice(0, count);
}

/**
 * 解析行分隔 DSL（主路径）：
 *   【候选】
 *   正文…
 *   【待定】问题
 *   - 标签 || 填充 || 效果 || 占位符
 * 不涉及转义，flash 级模型也能稳定输出。
 * @param text - 模型原始输出。
 * @param count - 期望候选数。
 * @returns 规范化后的候选数组（解析不到任何候选则返回空数组）。
 */
function parseDsl(text, count) {
  const candidates = [];
  let current = null;
  let gap = null;
  /** 一旦进入【待定】区，后续普通行不再算正文（否则被裁掉的选项会漏进正文）。 */
  let inGapSection = false;

  /** 结算当前待定点：选项不足 2 个直接丢弃，且不占用 gaps 名额。 */
  const finalizeGap = () => {
    if (current === null || gap === null) return;
    if (gap.options.length >= 2 && current.gaps.length < MAX_GAPS_PER_CANDIDATE) current.gaps.push(gap);
    gap = null;
  };

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (/^【候选[^】]*】\s*$/u.test(line)) {
      if (candidates.length >= count) break;
      finalizeGap();
      current = { text: [], gaps: [] };
      inGapSection = false;
      candidates.push(current);
      continue;
    }
    if (current === null) continue;
    const gapMatch = /^【待定[^】]*】\s*(.*)$/u.exec(line);
    if (gapMatch !== null) {
      finalizeGap();
      inGapSection = true;
      const question = gapMatch[1].trim();
      gap = question === '' ? null : { question, options: [] };
      continue;
    }
    const optionMatch = /^[-·•]\s*(.+)$/u.exec(line);
    if (optionMatch !== null && gap !== null) {
      if (gap.options.length >= MAX_OPTIONS_PER_GAP) continue;
      const parts = optionMatch[1].split('||').map((part) => part.trim());
      const label = parts[0] ?? '';
      if (label === '') continue;
      gap.options.push({
        label,
        fill: parts[1] !== undefined && parts[1] !== '' ? parts[1] : label,
        effect: parts[2] ?? '',
        placeholder: parts[3] ?? '',
      });
      continue;
    }
    if (!inGapSection && line !== '') current.text.push(rawLine.trim());
  }
  finalizeGap();

  const out = [];
  for (const candidate of candidates) {
    const body = candidate.text.join('\n').trim();
    if (body === '') continue;
    out.push({ text: body, gaps: candidate.gaps });
  }
  return out.slice(0, count);
}

/**
 * 解析模型输出：DSL 优先，其次 JSON（万一模型还是给了 JSON），最后退回纯文本。
 * @param text - 模型原始输出。
 * @param count - 期望候选数。
 * @returns 候选数组与是否走了结构化路径。
 */
function parseStructured(text, count) {
  const dsl = parseDsl(text, count);
  if (dsl.length > 0) return { candidates: dsl, structured: true };
  const json = extractJsonObject(text);
  if (json !== null) {
    const candidates = normalizeStructured(json, count);
    if (candidates.length > 0) return { candidates, structured: true };
  }
  return {
    candidates: splitCandidates(text, count).map((item) => ({ text: item, gaps: [] })),
    structured: false,
  };
}

/**
 * 调一次模型并返回候选提示词。
 * @param ctx - Host 上下文（需带 llm 服务）。
 * @param request - 草稿、模型路由、候选数量、会话与附加方向。
 * @returns 非空候选数组。
 */
async function generate(ctx, request) {
  const { draft, provider, model, count, sessionId, direction } = request;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: frameDraft(draft, count, direction) }],
        source: { kind: 'plugin', plugin: '@linxin666/dsh-prompt-enhancer' },
      }),
    ];
    const assembler = new BlockAssembler();
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      messages,
      system: SYSTEM_PROMPT,
      maxTokens: MAX_OUTPUT_TOKENS,
      ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
      signal: controller.signal,
    })) {
      assembler.push(chunk);
    }
    const finish = assembler.finish;
    if (finish !== undefined && finish.kind === 'error') {
      throw new Error(finish.failure?.message ?? 'model call failed');
    }
    if (finish !== undefined && finish.kind === 'aborted') {
      throw new Error('生成被取消或超时');
    }
    const blocks = assembler.blocks();
    if (blocks.some((block) => block.type === 'tool-call')) {
      throw new Error('模型返回了工具调用，预期只有文本');
    }
    const output = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const parsed = parseStructured(output, count);
    if (parsed.candidates.length === 0) throw new Error('模型没有产出可用文本');
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** 处理 /prompt-enhancer/enhance。 */
async function handleEnhance(ctx, req, res) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    return;
  }
  if (!isLocalRequest(req)) {
    writeJson(res, 403, { error: 'forbidden: loopback-only' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const draft = typeof body.text === 'string' ? body.text.trim() : '';
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const direction = typeof body.direction === 'string' ? body.direction : undefined;
  const rawCount = typeof body.count === 'number' ? Math.trunc(body.count) : DEFAULT_CANDIDATES;
  const count = Math.min(Math.max(rawCount, 1), MAX_CANDIDATES);
  if (draft === '') {
    writeJson(res, 400, { error: '草稿是空的' });
    return;
  }
  if (provider === '' || model === '') {
    writeJson(res, 400, { error: '缺少 provider 或 model' });
    return;
  }
  if (draft.length > MAX_DRAFT_CHARS) {
    writeJson(res, 400, { error: `草稿过长（上限 ${MAX_DRAFT_CHARS} 字符）` });
    return;
  }
  try {
    const parsed = await generate(ctx, { draft, provider, model, count, sessionId, direction });
    writeJson(res, 200, { candidates: parsed.candidates, structured: parsed.structured, provider, model });
  } catch (error) {
    writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * 挂载提示词增强器的 HTTP 路由。
 * @param ctx - Host 插件上下文。
 */
function apply(ctx) {
  markLoaded('apply');
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => {
        void handleEnhance(ctx, req, res);
      },
    });
    return () => {
      dispose();
    };
  }, 'prompt-enhancer: route');
}

export { ROUTE_PATH, SYSTEM_PROMPT, apply, inject, name, parseDsl, parseStructured, splitCandidates };
