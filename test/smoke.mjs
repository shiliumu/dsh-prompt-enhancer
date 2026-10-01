/**
 * 客户端逻辑冒烟测试（不需要浏览器/Electron）。
 *
 * 用最小 React / window / fetch 桩，端到端验证：
 *   模块能加载 -> apply 注册两个插槽 -> 点 ✨ 发出正确请求 -> 候选渲染 -> 数字键采纳写回草稿。
 *
 * 运行： node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/* ---------------- 桩：window / ModuleLoader ---------------- */
const keydownListeners = [];
let loaded = null;

globalThis.window = {
  addEventListener: (type, fn) => {
    if (type === 'keydown') keydownListeners.push(fn);
  },
  removeEventListener: (type, fn) => {
    const index = keydownListeners.indexOf(fn);
    if (index >= 0) keydownListeners.splice(index, 1);
  },
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition;
    },
  },
};

/* ---------------- 桩：React ---------------- */
const effectCleanups = [];
// 模拟 React 的 effect 时序：同一个组件重新渲染时，先跑上一次的 cleanup。
let previousEffectCleanup = null;
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useEffect: (fn) => {
    if (typeof previousEffectCleanup === 'function') previousEffectCleanup();
    const cleanup = fn();
    previousEffectCleanup = typeof cleanup === 'function' ? cleanup : null;
    if (typeof cleanup === 'function') effectCleanups.push(cleanup);
  },
  useRef: (initial) => ({ current: initial }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};

/** 模拟 React 卸载：跑掉已登记的 effect cleanup（例如摘掉 keydown 监听）。 */
const unmountAll = () => {
  while (effectCleanups.length > 0) effectCleanups.pop()();
};

/* ---------------- 桩：document（样式注入） ---------------- */
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
};

/* ---------------- 桩：fetch ---------------- */
const fetchCalls = [];
let fetchResponse = {
  ok: true,
  status: 200,
  json: async () => ({ candidates: ['候选一', '候选二', '候选三'] }),
};
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init, body: JSON.parse(init.body) });
  return fetchResponse;
};

/* ---------------- 载入客户端模块 ---------------- */
// eslint-disable-next-line no-eval
new Function('window', 'document', clientSource)(globalThis.window, globalThis.document);
assert.ok(loaded !== null, '客户端模块没有调用 __ModuleLoader__.load');
assert.equal(loaded.id, '@linxin666/dsh-prompt-enhancer');

const plugin = loaded.factory((name) => {
  if (name === 'react') return ReactStub;
  throw new Error(`unexpected require(${name})`);
});

assert.deepEqual(plugin.inject, ['slots', 'remote', 'remote.session']);
assert.equal(typeof plugin.apply, 'function');
// cordis 只在显式 inject 后才允许访问 ctx.remote.session —— 真机踩过一次
assert.ok(plugin.inject.includes('remote.session'), 'inject 必须包含 remote.session');

/* ---------------- 桩：插件 ctx ---------------- */
const registrations = [];
const ctx = {
  remote: {
    session: {
      modelCatalog: async () => ({
        ok: true,
        value: {
          default: { provider: 'custom:tr', model: 'deepseek-v4-flash' },
          groups: [
            { id: 'custom:tr', name: 'TokenRhythm', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
            { id: 'custom:dci', name: 'DCI', models: [{ id: 'gpt-5.6-terra', name: 'Terra' }] },
          ],
        },
      }),
    },
  },
  slots: {
    inject: (name, callback) => {
      const entry = callback();
      registrations.push({ name, entry });
      return () => {};
    },
    register: (options, Component) => ({ options, Component }),
  },
  effect: (fn) => {
    fn();
    return () => {};
  },
};

plugin.apply(ctx);

assert.equal(registrations.length, 4, 'v0.2 改写与 v0.3 参谋各注册两个插槽');
assert.deepEqual(
  [...registrations].map((item) => item.name).sort(),
  ['conversation.input.dock', 'conversation.input.dock', 'conversation.input.right', 'conversation.input.right'],
);
assert.deepEqual(
  [...new Set(registrations.map((item) => item.entry.options.id))].sort(),
  ['advisor-engine', 'prompt-enhancer'],
  '四个注册必须分属两个插件 id，避免同 id 冲突',
);

/** 按 id + 插槽名取组件，不依赖注册先后顺序。 */
const pick = (id, slot) => {
  const found = registrations.find((item) => item.entry.options.id === id && item.name === slot);
  if (found === undefined) throw new Error(`找不到注册：${id} @ ${slot}`);
  return found.entry.Component;
};
const pickFrom = (list, id, slot) => {
  const found = list.find((item) => item.entry.options.id === id && item.name === slot);
  if (found === undefined) throw new Error(`找不到注册：${id} @ ${slot}`);
  return found.entry.Component;
};

const button = pick('prompt-enhancer', 'conversation.input.right');
const panel = pick('prompt-enhancer', 'conversation.input.dock');

/* ---------------- 场景 1：空草稿 -> 报错 ---------------- */
const draftWrites = [];
const inputActions = { setDraft: (text) => draftWrites.push(text) };
let draft = '';
const renderButton = () =>
  button({ useInput: (selector) => selector({ draft }), inputActions, sessionId: 'session-1' });
const renderPanel = () => panel({ input: { draft } });

let tree = renderButton();
assert.equal(tree.type, 'button');
assert.equal(tree.children[0], '✨', '空闲态按钮应显示 ✨');

await tree.props.onClick();
tree = renderPanel();
const errorText = JSON.stringify(tree);
assert.ok(errorText.includes('输入框是空的'), `空草稿应提示，实际：${errorText.slice(0, 200)}`);
assert.equal(fetchCalls.length, 0, '空草稿不应发请求');

/* ---------------- 场景 2：正常生成 -> 候选 -> 数字键采纳 ---------------- */
draft = '帮我看看这个爬虫为啥老是断';
tree = renderButton();
await tree.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));

assert.equal(fetchCalls.length, 1, '应该发一次请求');
assert.equal(fetchCalls[0].url, '/prompt-enhancer/enhance');
assert.equal(fetchCalls[0].body.provider, 'custom:tr');
assert.equal(fetchCalls[0].body.model, 'deepseek-v4-flash', '应优先 flash 模型');
assert.equal(fetchCalls[0].body.count, 3);
assert.equal(fetchCalls[0].body.sessionId, 'session-1');
assert.equal(fetchCalls[0].body.text, draft);

// 生成完成后重新渲染面板：应出现 3 个候选 + 注册 keydown
tree = renderPanel();
const rendered = JSON.stringify(tree);
assert.ok(rendered.includes('候选一') && rendered.includes('候选三'), '候选应渲染出来');
assert.ok(keydownListeners.length > 0, '候选框打开时应挂上键盘监听');

/* ---------------- 场景 2b：候选框里切换模型 ---------------- */
const flatText = (n) => (Array.isArray(n) ? n.map(flatText).join('') : (n && typeof n === 'object' ? flatText(n.children ?? null) : String(n ?? '')));
const findByClass = (node, className, text) => {
  if (node === null || typeof node !== 'object') return null;
  const classes = typeof node.props?.className === 'string' ? node.props.className.split(' ') : [];
  if (classes.includes(className)) {
    // 带文字筛选时必须真的匹配，避免"取到第一个同名元素却以为是它"这类静默错位。
    if (text === undefined) return node;
    if (flatText(node.children ?? null).includes(text)) return node;
  }
  for (const child of node.children ?? []) {
    const hit = findByClass(child, className, text);
    if (hit !== null) return hit;
  }
  return null;
};

const modelChip = findByClass(tree, 'dshpe_model');
assert.ok(modelChip !== null, '候选框表头应有可点击的模型名');
assert.equal(modelChip.children[0], 'DeepSeek V4 Flash · TokenRhythm ▾', '模型名应显示当前模型');

await modelChip.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
tree = renderPanel();
const pickerText = JSON.stringify(tree);
assert.ok(pickerText.includes('Terra'), `切换模型应列出其他模型，实际：${pickerText.slice(0, 240)}`);

// 列表里第 2 个是 Terra（第 1 个是当前 flash）
for (const listener of [...keydownListeners]) listener({ key: '2', preventDefault: () => {}, stopPropagation: () => {} });
await new Promise((resolve) => setTimeout(resolve, 0));
const switched = fetchCalls[fetchCalls.length - 1];
assert.equal(switched.body.model, 'gpt-5.6-terra', '切换后应使用新模型重新生成');
assert.equal(fetchCalls.length, 2, '切换模型应触发一次重新生成');
assert.equal(switched.body.text, draft, '重新生成仍用同一份草稿');

tree = renderPanel();
assert.ok(JSON.stringify(tree).includes('候选一'), '切换模型后应回到候选列表');

// 数字键 2 采纳第二个候选。
// React 桩不跑 effect cleanup，多次 render 会堆叠监听；先清干净再重新渲染一份。
keydownListeners.length = 0;
tree = renderPanel();
const event = {
  key: '2',
  preventDefault: () => {},
  stopPropagation: () => {},
};
for (const listener of [...keydownListeners]) listener(event);
assert.deepEqual(draftWrites, ['候选二'], `数字键应采纳对应候选，实际：${JSON.stringify(draftWrites)}`);

// 采纳后候选框关闭
tree = renderPanel();
assert.equal(tree, null, '采纳后候选框应关闭');

/* ---------------- 场景 3：没有 flash 模型 -> 模型选择框 ---------------- */
unmountAll();
keydownListeners.length = 0; // 全局快捷键监听由 apply() 持有，这里只关心面板监听
fetchResponse = {
  ok: true,
  status: 200,
  json: async () => ({ candidates: ['X'] }),
};
ctx.remote.session.modelCatalog = async () => ({
  ok: true,
  value: {
    default: { provider: 'custom:dci', model: 'gpt-5.6-terra' },
    groups: [{ id: 'custom:dci', name: 'DCI', models: [{ id: 'gpt-5.6-terra', name: 'Terra' }] }],
  },
});
// 换一个全新模块实例，避免上一轮的模型偏好缓存
const freshPlugin = loaded.factory((name) => (name === 'react' ? ReactStub : null));
const freshRegistrations = [];
freshPlugin.apply({
  ...ctx,
  slots: {
    inject: (name, callback) => {
      freshRegistrations.push({ name, entry: callback() });
      return () => {};
    },
    register: (options, Component) => ({ options, Component }),
  },
});
const freshButton = pickFrom(freshRegistrations, 'prompt-enhancer', 'conversation.input.right');
const freshPanel = pickFrom(freshRegistrations, 'prompt-enhancer', 'conversation.input.dock');
draft = '写个周报';
await freshButton({ useInput: (selector) => selector({ draft }), inputActions, sessionId: 's2' }).props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
const pickerTree = JSON.stringify(freshPanel({ input: { draft } }));
assert.ok(pickerTree.includes('Terra'), `无 flash 时应列出模型，实际：${pickerTree.slice(0, 240)}`);

// 数字键 1 选中模型 -> 立刻发起生成
const pickEvent = { key: '1', preventDefault: () => {}, stopPropagation: () => {} };
for (const listener of [...keydownListeners]) listener(pickEvent);
await new Promise((resolve) => setTimeout(resolve, 0));
const lastCall = fetchCalls[fetchCalls.length - 1];
assert.equal(lastCall.body.model, 'gpt-5.6-terra', '选中的模型应被使用');

/* ---------------- 场景 3.5：请求失败（只出思维链）-> 自动给换模型选择框 ---------------- */
unmountAll();
keydownListeners.length = 0;
fetchResponse = {
  ok: false,
  status: 500,
  json: async () => ({
    error: '模型只产出了思维链（218 字符）没有正文，结束原因 max-tokens。',
    code: 'reasoning-only',
    detail: { outputChars: 0, reasoningChars: 218, finish: 'max-tokens' },
  }),
};
ctx.remote.session.modelCatalog = async () => ({
  ok: true,
  value: {
    default: { provider: 'custom:tr', model: 'glm-5.3-flash' },
    groups: [
      {
        id: 'custom:tr',
        name: 'TokenRhythm',
        models: [
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
          { id: 'deepseek-flash', name: 'DeepSeek Flash' },
        ],
      },
    ],
  },
});
const failPlugin = loaded.factory((name) => (name === 'react' ? ReactStub : null));
const failRegistrations = [];
failPlugin.apply({
  ...ctx,
  slots: {
    inject: (name, callback) => {
      failRegistrations.push({ name, entry: callback() });
      return () => {};
    },
    register: (options, Component) => ({ options, Component }),
  },
});
const failButton = pickFrom(failRegistrations, 'prompt-enhancer', 'conversation.input.right');
const failPanel = pickFrom(failRegistrations, 'prompt-enhancer', 'conversation.input.dock');
draft = '帮我看看这个爬虫为啥老是断';
const callsBeforeFail = fetchCalls.length;
await failButton({ useInput: (selector) => selector({ draft }), inputActions, sessionId: 's3' }).props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(fetchCalls.length, callsBeforeFail + 1, '失败场景也应发一次请求');
const failTree = JSON.stringify(failPanel({ input: { draft } }));
assert.ok(failTree.includes('模型只产出了思维链'), `选择框应保留失败原因，实际：${failTree.slice(0, 300)}`);
assert.ok(failTree.includes('DeepSeek Flash'), `失败后应直接列出可换的模型，实际：${failTree.slice(0, 300)}`);
assert.ok(failTree.includes('易空正文'), '应标注实测易空正文的模型');
// 换模型重试时必须沿用失败时的那份草稿（模拟输入框已被清空）
draft = '';
const failPick = { key: '2', preventDefault: () => {}, stopPropagation: () => {} };
for (const listener of [...keydownListeners]) listener(failPick);
await new Promise((resolve) => setTimeout(resolve, 0));
const retryCall = fetchCalls[fetchCalls.length - 1];
assert.equal(retryCall.body.model, 'deepseek-flash', '应使用新选的模型重试');
assert.equal(retryCall.body.text, '帮我看看这个爬虫为啥老是断', '换模型重试应沿用失败时提交的草稿');

/* ---------------- 场景 4：结构化候选（待定点 + 方向选项 + 缩进树） ---------------- */
unmountAll();
keydownListeners.length = 0;
fetchResponse = {
  ok: true,
  status: 200,
  json: async () => ({
    structured: true,
    candidates: [
      {
        text: '排查爬虫中断：连续运行 <待确认：时长> 分钟不再中断。',
        gaps: [
          {
            question: '这次要动代码吗？',
            options: [
              { label: '只诊断', fill: '只做根因定位，暂不修改任何代码', effect: '最快、零风险；可能多来一轮', placeholder: '' },
              { label: '诊断+修复', fill: '定位根因后直接给出并应用修复', effect: '一次到位；判断错会白改一轮', placeholder: '' },
            ],
          },
          {
            question: '跑多久算稳？',
            options: [
              { label: '30 分钟', fill: '30', effect: '只能抓到高频断连', placeholder: '<待确认：时长>' },
              { label: '2 小时', fill: '2 小时', effect: '能看出间歇性中断', placeholder: '<待确认：时长>' },
            ],
          },
        ],
      },
      { text: '第二条候选', gaps: [] },
      { text: '第三条候选', gaps: [] },
    ],
  }),
};

const gapPlugin = loaded.factory((name) => (name === 'react' ? ReactStub : null));
const gapRegistrations = [];
gapPlugin.apply({
  ...ctx,
  remote: {
    session: {
      modelCatalog: async () => ({
        ok: true,
        value: {
          default: { provider: 'custom:tr', model: 'deepseek-v4-flash' },
          groups: [{ id: 'custom:tr', name: 'TokenRhythm', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }],
        },
      }),
    },
  },
  slots: {
    inject: (name, callback) => {
      gapRegistrations.push({ name, entry: callback() });
      return () => {};
    },
    register: (options, Component) => ({ options, Component }),
  },
});
const gapButton = pickFrom(gapRegistrations, 'prompt-enhancer', 'conversation.input.right');
const gapPanel = pickFrom(gapRegistrations, 'prompt-enhancer', 'conversation.input.dock');
draft = '爬虫老是断';
await gapButton({ useInput: (selector) => selector({ draft }), inputActions, sessionId: 's3' }).props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));

let gapTree = gapPanel({ input: { draft } });
const gapJson = JSON.stringify(gapTree);
assert.ok(gapJson.includes('待定 2 处'), `候选卡应显示待定标记，实际：${gapJson.slice(0, 300)}`);
assert.ok(gapJson.includes('这次要动代码吗？') && gapJson.includes('跑多久算稳？'), '两个待定点都应渲染');
assert.ok(gapJson.includes('需要你拍板 2 处'), '拍板区表头应显示');
assert.ok(findByClass(gapTree, 'dshpe_tree') === null, '方向图默认收起');
assert.ok(findByClass(gapTree, 'dshpe_toggle') !== null, '应有「看方向图」入口');

// 点第一个待定点的第 2 个方向
const chips = [];
const collectChips = (node) => {
  if (node === null || typeof node !== 'object') return;
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes('dshpe_chip')) chips.push(node);
  for (const child of node.children ?? []) collectChips(child);
};
collectChips(gapTree);
assert.equal(chips.length, 4, `两个待定点各 2 个选项，应渲染 4 个 chip，实际 ${chips.length}`);
await chips[1].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
gapTree = gapPanel({ input: { draft } });
assert.ok(JSON.stringify(gapTree).includes('已定 1/2'), '拍板后计数应更新');

// 展开方向图：应出现缩进树且高亮当前选择
await findByClass(gapTree, 'dshpe_toggle').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
gapTree = gapPanel({ input: { draft } });
const treeNode = findByClass(gapTree, 'dshpe_tree');
assert.ok(treeNode !== null, '点「看方向图」后应展开缩进树');
const treeText = JSON.stringify(treeNode);
assert.ok(treeText.includes('├─') && treeText.includes('└─'), '缩进树应有分支字符');
assert.ok(treeText.includes('一次到位；判断错会白改一轮'), '缩进树应含选项效果');

// Tab 进入拍板区，数字键 2 选第 2 个方向（用占位符替换路径），Enter 回到候选
keydownListeners.length = 0;
gapTree = gapPanel({ input: { draft } });
const fire = (key) => {
  for (const listener of [...keydownListeners]) listener({ key, preventDefault: () => {}, stopPropagation: () => {} });
};
fire('Tab');
await new Promise((resolve) => setTimeout(resolve, 0));
gapTree = gapPanel({ input: { draft } });
assert.ok(JSON.stringify(gapTree).includes('"data-focus":"true"'), 'Tab 后拍板区应获得焦点');

fire('ArrowDown'); // 切到第 2 个待定点
await new Promise((resolve) => setTimeout(resolve, 0));
fire('2'); // 选「2 小时」
await new Promise((resolve) => setTimeout(resolve, 0));
fire('Enter'); // 回到候选
await new Promise((resolve) => setTimeout(resolve, 0));
fire('1'); // 采纳第 1 条候选
const adopted = draftWrites[draftWrites.length - 1];
assert.ok(adopted.includes('连续运行 2 小时 分钟不再中断'), `占位符应被原地替换，实际：${adopted}`);
assert.ok(adopted.includes('【补充要求】'), '无占位符的方向应追加为补充要求');
assert.ok(adopted.includes('定位根因后直接给出并应用修复'), '补充要求应含所选方向');

/* ---------------- 场景 9：v0.3 参谋（局势模型 → 树 → 导出 → 采纳） ---------------- */
{
  unmountAll();
  keydownListeners.length = 0;
  ctx.remote.session.modelCatalog = async () => ({
    ok: true,
    value: {
      default: { provider: 'custom:tr', model: 'deepseek-v4-flash-0731' },
      groups: [{
        id: 'custom:tr',
        name: 'TokenRhythm',
        models: [
          { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
        ],
      }],
    },
  });

  /** 一份"信息不足、暂不推荐"的局势模型：设计里最关键的输出形态。 */
  const situation = {
    intent: { primary: '决定是否辞职做独立开发', secondary: ['想验证产品能否养活自己'], success_criteria: [], confidence: 'medium' },
    situation: {
      facts: ['五年后端经验', '房贷在还'],
      inferences: ['当前工作可能不是最优解'],
      assumptions: ['存款可支撑 12 个月'],
      constraints: ['不能立刻断收入'],
      unknowns: ['更重视速度还是质量'],
      actors: [],
      time_horizon: '12 个月',
    },
    key_tensions: ['稳定收入 vs 创业自由'],
    decision_variables: ['现金流'],
    directions: [
      { id: 'A', name: '全职独立开发', thesis: 'All in 做产品', premises: ['存款够 12 个月'], advantages: ['时间完整'], costs: ['收入归零'], risks: ['产品无人用'], resource_demand: '高', reversibility: 'low', information_gain: 'high', first_action: '先做 30 天付费验证', continue_signals: [], pivot_signals: [], stop_conditions: [] },
      { id: 'B', name: '边工作边开发', thesis: '用业余时间验证', premises: ['精力允许'], advantages: ['风险低'], costs: ['进度慢'], risks: ['拖太久'], resource_demand: '中', reversibility: 'high', information_gain: 'medium', first_action: '每周固定 10 小时', continue_signals: [], pivot_signals: [], stop_conditions: [] },
    ],
    recommendation: { direction_id: 'B', reasoning: ['可逆且信息增益足够'], confidence: 'medium', why_not_others: ['A 的不可逆代价过高'] },
    questions: [{ question: '月支出占收入多少', why_it_matters: '决定现金跑道', could_change_direction: true }],
    tree: {
      type: 'goal', label: '我要不要辞职去做独立开发', source: 'user', confidence: 'high', impact: 'high', status: 'open',
      children: [
        { type: 'fact', label: '五年后端经验', source: 'user', confidence: 'high', impact: 'medium', status: 'open', children: [] },
        { type: 'inference', label: '当前工作可能不是最优解', source: 'model', confidence: 'low', impact: 'medium', status: 'open', children: [] },
        { type: 'unknown', label: '更重视速度还是质量', source: 'unconfirmed', confidence: 'low', impact: 'high', status: 'open', children: [] },
        { type: 'fact', label: '已被否定的旧判断', source: 'model', confidence: 'low', impact: 'low', status: 'rejected', children: [] },
      ],
    },
  };

  // 按路由分流的桩：参谋 / 复查 / 导出各有各的响应
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init, body: JSON.parse(init.body) });
    if (url === '/prompt-enhancer/advisor') return { ok: true, status: 200, json: async () => ({ situation, structured: true, mode: 'decision', resumed: false }) };
    if (url === '/prompt-enhancer/review') return { ok: true, status: 200, json: async () => ({ review: { valid: false, errors: ['把推断当事实'], warnings: [], missing_questions: ['速度还是质量'], recommended_corrections: ['补前提'] } }) };
    if (url === '/prompt-enhancer/enhance') return { ok: true, status: 200, json: async () => ({ candidates: [{ text: '导出的可执行提示词正文', gaps: [] }] }) };
    return { ok: false, status: 404, json: async () => ({ error: 'unexpected route' }) };
  };

  const advPlugin = loaded.factory((name) => (name === 'react' ? ReactStub : null));
  const advRegistrations = [];
  advPlugin.apply({
    ...ctx,
    slots: {
      inject: (name, callback) => {
        advRegistrations.push({ name, entry: callback() });
        return () => {};
      },
      register: (options, Component) => ({ options, Component }),
    },
  });
  const advButton = pickFrom(advRegistrations, 'advisor-engine', 'conversation.input.right');
  const advDock = pickFrom(advRegistrations, 'advisor-engine', 'conversation.input.dock');

  draft = '我要不要辞职去做独立开发';
  const advCallsBefore = fetchCalls.length;
  await advButton({ useInput: (selector) => selector({ draft }), inputActions, sessionId: 's-adv' }).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetchCalls.length, advCallsBefore + 1, '参谋按钮应发一次分析请求');
  const advCall = fetchCalls[fetchCalls.length - 1];
  assert.equal(advCall.url, '/prompt-enhancer/advisor', '参谋按钮应打参谋端点');
  assert.equal(advCall.body.text, draft);
  assert.equal(advCall.body.resume, false, '首次分析不是续研');
  assert.equal(advCall.body.sessionId, 's-adv');
  assert.ok(!('mode' in advCall.body), 'auto 模式不应显式传 mode');

  let advTree = flatText(advDock({ input: { draft } }));
  for (const needle of [
    '决定是否辞职做独立开发', '关键矛盾', '稳定收入 vs 创业自由',
    '事实·五年后端经验', '推断·当前工作可能不是最优解', '未知·更重视速度还是质量',
    '全职独立开发', '边工作边开发', '待确认（1', '月支出占收入多少',
    '我要不要辞职去做独立开发', '五年后端经验', '缩进树（5 节点',
    '依据：可逆且信息增益足够', '不选其它：A 的不可逆代价过高',
  ]) {
    assert.ok(advTree.includes(needle), `参谋界面应渲染「${needle}」。实际：${advTree.slice(0, 300)}`);
  }
  // 推荐星标来自 CSS content，文本树看不到，因此断言属性
  assert.equal(findByClass(advDock({ input: { draft } }), 'dshadv_dir', '边工作边开发').props['data-rec'], 'true');
  assert.equal(findByClass(advDock({ input: { draft } }), 'dshadv_dir', '全职独立开发').props['data-rec'], 'false');
  // 节点五属性：状态/来源/置信度徽标 + 已否决节点视觉降级
  assert.ok(advTree.includes('已否决') && advTree.includes('模型推断') && advTree.includes('置信低'));
  assert.equal(findByClass(advDock({ input: { draft } }), 'dshadv_row', '已被否定的旧判断').props['data-dead'], 'true');

  // 选中方向 A -> 展开前提/收益/代价/风险
  await findByClass(advDock({ input: { draft } }), 'dshadv_dir').props.onClick();
  advTree = flatText(advDock({ input: { draft } }));
  assert.ok(advTree.includes('策略：All in 做产品'), '选中后应展开方向详情');
  assert.ok(advTree.includes('前提：存款够 12 个月') && advTree.includes('风险：产品无人用'));

  // 复查
  await findByClass(advDock({ input: { draft } }), 'dshadv_action', '复查').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  advTree = flatText(advDock({ input: { draft } }));
  assert.ok(advTree.includes('审查发现问题') && advTree.includes('把推断当事实') && advTree.includes('建议补问：速度还是质量'));

  // 导出 -> 走 /enhance
  const exportBtn = findByClass(advDock({ input: { draft } }), 'dshadv_action', '导出提示词');
  assert.notEqual(exportBtn.props.disabled, true, '已选中方向时导出按钮不应禁用');
  const callsBeforeExport = fetchCalls.length;
  await exportBtn.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetchCalls.length, callsBeforeExport + 1, '导出应新增一次请求');
  const exportCall = fetchCalls[fetchCalls.length - 1];
  assert.equal(exportCall.url, '/prompt-enhancer/enhance', '导出应复用改写端点');
  assert.ok(exportCall.body.text.includes('All in 做产品'), '导出草稿应带上所选方向的策略');
  assert.ok(exportCall.body.text.includes('硬约束：不能立刻断收入'), '导出草稿应带上局势约束（D6 回归）');
  assert.ok(flatText(advDock({ input: { draft } })).includes('导出的可执行提示词正文'));

  // 采纳 -> 写回输入框并关闭面板
  const writesBefore = draftWrites.length;
  findByClass(advDock({ input: { draft } }), 'dshadv_action', '采纳提示词').props.onClick();
  assert.equal(draftWrites.length, writesBefore + 1, '采纳应写入一次草稿');
  assert.equal(draftWrites[draftWrites.length - 1], '导出的可执行提示词正文');
  assert.equal(advDock({ input: { draft } }), null, '采纳后参谋面板应关闭');
}

/* ---------------- 场景 10：参谋态守卫回归（D1 偏好保留 / D2 统一黑名单 / D3 快捷键分层） ---------------- */
{
  unmountAll();
  keydownListeners.length = 0;
  ctx.remote.session.modelCatalog = async () => ({
    ok: true,
    value: {
      default: { provider: 'custom:tr', model: 'glm-5.3-flash' },
      groups: [{
        id: 'custom:tr',
        name: 'TokenRhythm',
        models: [
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
          { id: 'deepseek-flash', name: 'DeepSeek Flash' },
        ],
      }],
    },
  });
  // 独立声明一份局势模型：不能跨块引用场景 9 的块级 const（那会 ReferenceError，
  // 且 requestJson 会把 json() 解析失败静默降级为 null —— 正是本测试要防的静默路径）。
  const situation = {
    intent: { primary: '决定是否辞职做独立开发', secondary: ['想验证产品能否养活自己'], success_criteria: [], confidence: 'medium' },
    situation: {
      facts: ['五年后端经验', '房贷在还'],
      inferences: ['当前工作可能不是最优解'],
      assumptions: ['存款可支撑 12 个月'],
      constraints: ['不能立刻断收入'],
      unknowns: ['更重视速度还是质量'],
      actors: [],
      time_horizon: '12 个月',
    },
    key_tensions: ['稳定收入 vs 创业自由'],
    decision_variables: ['现金流'],
    directions: [
      { id: 'A', name: '全职独立开发', thesis: 'All in 做产品', premises: ['存款够 12 个月'], advantages: ['时间完整'], costs: ['收入归零'], risks: ['产品无人用'], resource_demand: '高', reversibility: 'low', information_gain: 'high', first_action: '先做 30 天付费验证', continue_signals: [], pivot_signals: [], stop_conditions: [] },
      { id: 'B', name: '边工作边开发', thesis: '用业余时间验证', premises: ['精力允许'], advantages: ['风险低'], costs: ['进度慢'], risks: ['拖太久'], resource_demand: '中', reversibility: 'high', information_gain: 'medium', first_action: '每周固定 10 小时', continue_signals: [], pivot_signals: [], stop_conditions: [] },
    ],
    recommendation: { direction_id: 'B', reasoning: ['可逆且信息增益足够'], confidence: 'medium', why_not_others: ['A 的不可逆代价过高'] },
    questions: [{ question: '月支出占收入多少', why_it_matters: '决定现金跑道', could_change_direction: true }],
    tree: {
      type: 'goal', label: '我要不要辞职去做独立开发', source: 'user', confidence: 'high', impact: 'high', status: 'open',
      children: [
        { type: 'fact', label: '五年后端经验', source: 'user', confidence: 'high', impact: 'medium', status: 'open', children: [] },
        { type: 'inference', label: '当前工作可能不是最优解', source: 'model', confidence: 'low', impact: 'medium', status: 'open', children: [] },
      ],
    },
  };
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init, body: JSON.parse(init.body) });
    if (url === '/prompt-enhancer/advisor') return { ok: true, status: 200, json: async () => ({ situation, structured: true, mode: 'decision', resumed: false }) };
    if (url === '/prompt-enhancer/enhance') return { ok: true, status: 200, json: async () => ({ candidates: [{ text: '改写候选', gaps: [] }] }) };
    return { ok: false, status: 404, json: async () => ({ error: 'unexpected route' }) };
  };

  const guardPlugin = loaded.factory((name) => (name === 'react' ? ReactStub : null));
  const guardRegistrations = [];
  guardPlugin.apply({
    ...ctx,
    slots: {
      inject: (name, callback) => {
        guardRegistrations.push({ name, entry: callback() });
        return () => {};
      },
      register: (options, Component) => ({ options, Component }),
    },
  });
  const guardAdvButton = pickFrom(guardRegistrations, 'advisor-engine', 'conversation.input.right');
  const guardAdvDock = pickFrom(guardRegistrations, 'advisor-engine', 'conversation.input.dock');
  const guardRewriteButton = pickFrom(guardRegistrations, 'prompt-enhancer', 'conversation.input.right');

  // D2：统一黑名单 —— glm-5.3 被参谋过滤，自动选中 deepseek-flash
  draft = '要不要辞职做独立开发';
  const beforeD2 = fetchCalls.length;
  await guardAdvButton({ useInput: (selector) => selector({ draft }), inputActions, sessionId: 's-guard' }).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetchCalls.length, beforeD2 + 1, '应发起一次参谋分析');
  assert.equal(fetchCalls[fetchCalls.length - 1].body.model, 'deepseek-flash', 'glm-5.3 应被参谋过滤，改用 deepseek-flash');

  // D1：用户选好「决策」模式后，改写流程的 reset 不得把它清回 auto；同时参谋面板应被收起
  const modeBtn = findByClass(guardAdvDock({ input: { draft } }), 'dshadv_mode', '决策');
  modeBtn.props.onClick();
  await guardRewriteButton({ useInput: (selector) => selector({ draft }), inputActions, sessionId: 's-guard' }).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 改写 ready 后按 Esc -> 触发改写 reset()（D1 的触发点）
  const escEvent = { key: 'Escape', preventDefault: () => {}, stopPropagation: () => {} };
  for (const listener of [...keydownListeners]) listener(escEvent);
  assert.equal(guardAdvDock({ input: { draft } }), null, '改写 reset 后参谋面板应被收起');
  // 再开参谋：模式条上「决策」应仍处激活态
  await guardAdvButton({ useInput: (selector) => selector({ draft }), inputActions, sessionId: 's-guard' }).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const decisionBtn = findByClass(guardAdvDock({ input: { draft } }), 'dshadv_mode', '决策');
  assert.equal(decisionBtn.props['data-active'], 'true', '参谋模式是用户偏好，reset 不得清掉（D1 回归）');

  // D3：picker 态按 Ctrl+Shift+J 应退回候选层而不是直接关闭
  const callsBeforeSwitch = fetchCalls.length;
  findByClass(guardAdvDock({ input: { draft } }), 'dshadv_close', '换模型').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const jEvent = { key: 'J', ctrlKey: true, shiftKey: true, preventDefault: () => {}, stopPropagation: () => {} };
  for (const listener of [...keydownListeners]) listener(jEvent);
  const afterJ = guardAdvDock({ input: { draft } });
  assert.ok(afterJ !== null, 'picker 态按快捷键应退回候选层，而不是整个关闭');
  assert.ok(flatText(afterJ).includes('战略方向'), '退回后应回到参谋候选视图');
  assert.equal(fetchCalls.length, callsBeforeSwitch, '退回过程中不应发起新请求');
}

console.log('smoke ok');
console.log('  插槽注册      :', registrations.map((item) => item.name).join(', '));
console.log('  请求次数      :', fetchCalls.length);
console.log('  采纳写入      :', JSON.stringify(draftWrites));
console.log('  结构化候选    : gaps 渲染 / 方向图缩进树 / 占位符替换 + 补充要求');
