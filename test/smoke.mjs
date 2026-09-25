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

assert.equal(registrations.length, 2, '应该注册两个插槽');
assert.deepEqual(
  registrations.map((item) => item.name),
  ['conversation.input.right', 'conversation.input.dock'],
);

const button = registrations[0].entry.Component;
const panel = registrations[1].entry.Component;

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
const findByClass = (node, className) => {
  if (node === null || typeof node !== 'object') return null;
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes(className)) return node;
  for (const child of node.children ?? []) {
    const hit = findByClass(child, className);
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
const freshButton = freshRegistrations[0].entry.Component;
const freshPanel = freshRegistrations[1].entry.Component;
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
const gapButton = gapRegistrations[0].entry.Component;
const gapPanel = gapRegistrations[1].entry.Component;
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

console.log('smoke ok');
console.log('  插槽注册      :', registrations.map((item) => item.name).join(', '));
console.log('  请求次数      :', fetchCalls.length);
console.log('  采纳写入      :', JSON.stringify(draftWrites));
console.log('  结构化候选    : gaps 渲染 / 方向图缩进树 / 占位符替换 + 补充要求');
