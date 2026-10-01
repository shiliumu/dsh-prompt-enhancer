/**
 * Host 侧路由契约测试（v0.3 参谋）：stub webServer + llm，验证
 * 注册的路由集合、入参校验、快照回路（stateSaved/resumed）、降级与错误码透传。
 * 用法: node test/advisor-route.mjs
 */
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

/** 收集路由的 webServer 桩 */
function makeHost({ streamText, streamError }) {
  const routes = new Map();
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    llm: {
      async *stream() {
        if (streamError !== undefined) throw new Error(streamError);
        yield { type: 'text-delta', text: streamText };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    effect(fn) {
      fn();
      return () => {};
    },
  };
  return { ctx, routes };
}

/**
 * 触发一次路由（宿主 register 的 handler 是 fire-and-forget，
 * 必须等 res.end 落盘才算完成）。
 */
function call(handler, body, address = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const holder = {};
    const res = {
      writeHead(status) {
        holder.status = status;
      },
      end(text) {
        try {
          holder.body = JSON.parse(text);
          resolve(holder);
        } catch (error) {
          reject(error);
        }
      },
    };
    const req = {
      method: 'POST',
      socket: { remoteAddress: address },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body));
      },
    };
    handler(req, res);
  });
}

const SITUATION_JSON = JSON.stringify({
  intent: { primary: '决策是否辞职', confidence: 'medium' },
  situation: { facts: ['五年后端'], unknowns: ['目标'] },
  directions: [{ id: 'A', name: '全职', thesis: 'all in' }],
  recommendation: { direction_id: 'A', confidence: 'medium' },
  questions: [],
  tree: { type: 'goal', label: '草稿', children: [] },
});

/* ---------- 1. 路由注册 ---------- */
{
  const { ctx, routes } = makeHost({ streamText: SITUATION_JSON });
  apply(ctx);
  assert.deepEqual([...routes.keys()].sort(), [
    '/prompt-enhancer/advisor',
    '/prompt-enhancer/diag',
    '/prompt-enhancer/enhance',
    '/prompt-enhancer/review',
  ]);
}

/* ---------- 2. 入参校验 ---------- */
{
  const { ctx, routes } = makeHost({ streamText: SITUATION_JSON });
  apply(ctx);
  const handler = routes.get('/prompt-enhancer/advisor');
  assert.equal((await call(handler, { text: '', provider: 'p', model: 'm' })).status, 400, '空草稿应 400');
  assert.equal((await call(handler, { text: 'x' })).status, 400, '缺 provider 应 400');
  const ok = await call(handler, { text: '要不要辞职', provider: 'tokenrhythm', model: 'deepseek-flash' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.structured, true);
  assert.equal(ok.body.situation.intent.primary, '决策是否辞职');
}

/* ---------- 3. 快照回路：stateSaved 与 resume ---------- */
{
  const { ctx, routes } = makeHost({ streamText: SITUATION_JSON });
  apply(ctx);
  const handler = routes.get('/prompt-enhancer/advisor');
  // 无会话 id：不存快照，resumed 恒 false
  const noSession = await call(handler, { text: '草稿', provider: 'p', model: 'm', resume: true });
  assert.equal(noSession.body.stateSaved, false, '无 sessionId 时应明示未存快照');
  assert.equal(noSession.body.resumed, false);
  // 有会话 id：存快照；第二次 resume=true 应 resumed=true
  const first = await call(handler, { text: '草稿A', provider: 'p', model: 'm', sessionId: 's1' });
  assert.equal(first.body.stateSaved, true);
  const second = await call(handler, { text: '补充：已拿到 offer', provider: 'p', model: 'm', sessionId: 's1', resume: true });
  assert.equal(second.body.resumed, true, '带快照的续研应标记 resumed');
  // 不同会话互不影响
  const other = await call(handler, { text: '无关', provider: 'p', model: 'm', sessionId: 's2', resume: true });
  assert.equal(other.body.resumed, false, '别的会话不应复用 s1 的快照');
}

/* ---------- 4. 模型输出非 JSON 时降级为纯文本，不炸 ---------- */
{
  const { ctx, routes } = makeHost({ streamText: '这不是 JSON，只是模型写的一段话。' });
  apply(ctx);
  const handler = routes.get('/prompt-enhancer/advisor');
  const holder = await call(handler, { text: '草稿', provider: 'p', model: 'm', sessionId: 's3' });
  assert.equal(holder.status, 200);
  assert.equal(holder.body.structured, false, '应降级');
  assert.ok(holder.body.fallbackText.includes('这不是 JSON'));
}

/* ---------- 5. 模型出错时 500 + 错误信息 ---------- */
{
  const { ctx, routes } = makeHost({ streamError: 'upstream exploded' });
  apply(ctx);
  const handler = routes.get('/prompt-enhancer/advisor');
  const holder = await call(handler, { text: '草稿', provider: 'p', model: 'm' });
  assert.equal(holder.status, 500);
  assert.ok(holder.body.error.includes('upstream exploded'));
}

/* ---------- 6. 非本机来源拒绝 ---------- */
{
  const { ctx, routes } = makeHost({ streamText: SITUATION_JSON });
  apply(ctx);
  const handler = routes.get('/prompt-enhancer/advisor');
  const holder = await call(handler, { text: '草稿', provider: 'p', model: 'm' }, '192.168.1.10');
  assert.equal(holder.status, 403, '非本机来源应 403');
}

console.log('advisor-route ok');
console.log('  路由注册 / 入参校验 / stateSaved+resumed 回路 / 纯文本降级 / 500 透传 / 非本机拒绝');
