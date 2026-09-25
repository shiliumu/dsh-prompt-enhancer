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

console.log('smoke ok');
console.log('  插槽注册      :', registrations.map((item) => item.name).join(', '));
console.log('  请求次数      :', fetchCalls.length);
console.log('  采纳写入      :', JSON.stringify(draftWrites));
