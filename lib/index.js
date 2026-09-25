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
const MAX_OUTPUT_TOKENS = 2048;
const TIMEOUT_MS = 90_000;
const DEFAULT_CANDIDATES = 3;
const MAX_CANDIDATES = 6;

/** 生成器的系统提示词：只补结构，不编事实。 */
const SYSTEM_PROMPT = [
  '你是一名资深提示词工程师。用户会给你一段口语化、结构松散的草稿，',
  '你要把它改写成一条清晰、可直接交给 AI agent 执行的提示词。',
  '',
  '硬性规则：',
  '1. 只做“结构化补全”：补上目标、上下文、约束、交付物、验收标准、输出格式这些骨架。',
  '2. 严禁编造用户没有提供的事实：不要凭空添加文件路径、函数名、版本号、报错信息、业务需求。',
  '   缺少的关键信息，用 <待确认：…> 这样的占位符标出来，而不是自己填。',
  '3. 原样保留草稿中的 @文件引用、/命令、路径、代码片段、报错原文、数字，一个字都不要改。',
  '4. 使用与草稿相同的语言（中文草稿输出中文，英文草稿输出英文）。',
  '5. 每个候选都必须能独立使用，且候选之间要采取明显不同的策略，例如：',
  '   - 一个偏“执行型”（直接给可落地的操作步骤与验收命令）；',
  '   - 一个偏“澄清型”（先要求对方给方案/计划，再执行）；',
  '   - 一个偏“诊断型”（先定位根因，再修复，附证据要求）。',
  '6. 只输出提示词正文，不要任何解释、前言、标题、编号或代码块围栏。',
  '7. 候选之间用单独一行 === 分隔。',
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
    `请把下面这段草稿改写成 ${count} 条候选提示词，用一行 === 分隔。`,
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

/** 按 === 分隔线切分候选。 */
function splitCandidates(text, count) {
  return text
    .split(/^[ \t]*={3,}[ \t]*$/mu)
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .slice(0, count);
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
    const candidates = splitCandidates(output, count);
    if (candidates.length === 0) throw new Error('模型没有产出可用文本');
    return candidates;
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
    const candidates = await generate(ctx, { draft, provider, model, count, sessionId, direction });
    writeJson(res, 200, { candidates, provider, model });
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

export { ROUTE_PATH, SYSTEM_PROMPT, apply, inject, name, splitCandidates };
