/**
 * 提示词增强器 —— 客户端（Web UI）侧。
 *
 * 1. 在输入框工具行右侧（`conversation.input.right`）注册 ✨ 按钮；
 * 2. 在输入卡片上方整行（`conversation.input.dock`）注册候选框；
 * 3. 草稿读写走官方会话作用域通道：`useInput` 读、`inputActions.setDraft` 写；
 * 4. 模型挑选走 `ctx.remote.session.modelCatalog()`，优先 id/name 含 flash 的模型。
 *
 * 键盘：↑↓ 切换候选、1-9 直接采纳、Enter 采纳当前、←→ 重新生成、Esc 关闭。
 *
 * @module @linxin666/dsh-prompt-enhancer/client
 */
window.__ModuleLoader__.load({
  id: '@linxin666/dsh-prompt-enhancer',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    const ROUTE = '/prompt-enhancer/enhance';
    const CANDIDATE_COUNT = 3;
    const PICKER_LIMIT = 9;
    const CSS_TAG_ID = '@linxin666/dsh-prompt-enhancer/client.css';

    /* ------------------------------------------------------------------ *
     * 共享状态：按钮与候选框分处两个插槽，靠这个快照 store 通信。
     * ------------------------------------------------------------------ */

    const INITIAL = {
      phase: 'idle', // idle | busy | ready | picker | error
      candidates: [],
      index: 0,
      error: null,
      info: null,
      /** 当前生成用的模型标签（ready 态显示，可点击切换）。 */
      modelLabel: null,
      picker: [],
      /** picker 态的表头文案（首次无 flash / 主动切换，两种情况不同）。 */
      pickerTitle: null,
    };

    let snapshot = { ...INITIAL };
    const listeners = new Set();

    const getSnapshot = () => snapshot;
    const subscribe = (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    const emit = () => {
      for (const listener of [...listeners]) listener();
    };
    const patch = (next) => {
      snapshot = { ...snapshot, ...next };
      emit();
    };
    const reset = () => {
      patch({ ...INITIAL });
    };

    /** 组件通过它订阅共享状态。 */
    const useEnhancer = () => React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    /* ------------------------------------------------------------------ *
     * 跨渲染的可变引用：事件回调里要读到最新的草稿与会话身份。
     * ------------------------------------------------------------------ */

    let clientCtx = null;
    let draftRef = '';
    let sessionIdRef = undefined;
    let inputActionsRef = null;
    let catalogPromise = null;
    let preferredModel = null;

    const readDraft = () => (typeof draftRef === 'string' ? draftRef : '');

    /* ------------------------------------------------------------------ *
     * 模型目录：优先 flash。
     * ------------------------------------------------------------------ */

    async function loadCatalog() {
      if (catalogPromise === null) {
        catalogPromise = (async () => {
          const response = await clientCtx.remote.session.modelCatalog();
          if (response === undefined || response.ok !== true) {
            throw new Error(response?.error?.message ?? '无法读取本地模型目录');
          }
          return response.value;
        })();
        catalogPromise.catch(() => {
          catalogPromise = null;
        });
      }
      return catalogPromise;
    }

    function flattenCatalog(catalog) {
      const models = [];
      for (const group of catalog?.groups ?? []) {
        for (const model of group?.models ?? []) {
          const modelId = typeof model?.id === 'string' ? model.id : '';
          if (modelId === '') continue;
          const modelName = typeof model?.name === 'string' && model.name !== '' ? model.name : modelId;
          models.push({
            provider: group.id,
            model: modelId,
            label: `${modelName} · ${group.name ?? group.id}`,
          });
        }
      }
      return models;
    }

    const isFlash = (entry) => /flash/i.test(entry.model) || /flash/i.test(entry.label);

    /**
     * 选定本次生成用的模型：显式选择 > 默认 provider 的 flash > 任意 flash。
     * @returns 选中的模型，或 null 表示需要用户从候选框里挑一个。
     */
    async function resolveModel() {
      if (preferredModel !== null) return preferredModel;
      const catalog = await loadCatalog();
      const models = flattenCatalog(catalog);
      if (models.length === 0) throw new Error('本地没有可用模型，请先在设置里配置提供商。');
      const flashes = models.filter(isFlash);
      if (flashes.length === 0) return null;
      const defaultProvider = catalog?.default?.provider;
      return flashes.find((entry) => entry.provider === defaultProvider) ?? flashes[0];
    }

    /* ------------------------------------------------------------------ *
     * 生成与采纳。
     * ------------------------------------------------------------------ */

    async function requestCandidates(text, chosen, direction) {
      const body = {
        text,
        provider: chosen.provider,
        model: chosen.model,
        count: CANDIDATE_COUNT,
      };
      if (typeof sessionIdRef === 'string' && sessionIdRef !== '') body.sessionId = sessionIdRef;
      if (typeof direction === 'string' && direction !== '') body.direction = direction;
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) throw new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`);
      const candidates = Array.isArray(payload?.candidates)
        ? payload.candidates.filter((item) => typeof item === 'string' && item.trim() !== '')
        : [];
      if (candidates.length === 0) throw new Error('模型没有返回可用的提示词，再试一次。');
      return candidates;
    }

    /**
     * 打开模型选择列表。
     * @param title - 表头文案。
     * @param keepCandidates - true 时保留已有候选（从候选框点“切换模型”进来，Esc 可退回）。
     */
    async function openPicker(title, keepCandidates = false) {
      const catalog = await loadCatalog();
      const models = flattenCatalog(catalog).slice(0, PICKER_LIMIT);
      patch({
        phase: 'picker',
        picker: models,
        pickerTitle: title,
        index: 0,
        error: null,
        ...(keepCandidates ? {} : { candidates: [] }),
      });
    }

    async function generate(direction) {
      if (snapshot.phase === 'busy') return;
      const text = readDraft().trim();
      if (text === '') {
        patch({ phase: 'error', error: '输入框是空的，先写一句草稿再点 ✨。', picker: [], pickerTitle: null, candidates: [] });
        return;
      }
      patch({ phase: 'busy', error: null, info: null, picker: [], pickerTitle: null });
      try {
        const chosen = await resolveModel();
        if (chosen === null) {
          await openPicker('本地没有 flash 模型，按数字键选一个：');
          return;
        }
        const candidates = await requestCandidates(text, chosen, direction);
        patch({ phase: 'ready', candidates, index: 0, info: null, modelLabel: chosen.label });
      } catch (error) {
        patch({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }

    function adopt(text) {
      const actions = inputActionsRef;
      if (actions === null || typeof actions.setDraft !== 'function') {
        patch({ phase: 'error', error: '当前输入框不支持写入草稿。' });
        return;
      }
      actions.setDraft(text);
      reset();
    }

    /** 从候选框切换模型：保留候选，选完立刻用新模型重新生成。 */
    async function openModelSwitch() {
      try {
        await openPicker('切换模型后重新生成（数字键或点击）：', true);
      } catch (error) {
        patch({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }

    async function chooseFromPicker(entry) {
      preferredModel = entry;
      patch({ phase: 'idle', picker: [], pickerTitle: null, info: null });
      await generate(null);
    }

    /* ------------------------------------------------------------------ *
     * 样式。
     * ------------------------------------------------------------------ */

    const CSS = `
.dshpe_button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#8b8b8b);cursor:pointer;font-size:15px;line-height:1;transition:background-color .14s,color .14s}
.dshpe_button:hover:not(:disabled){background:var(--dsw-alias-bg-l2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#111)}
.dshpe_button:disabled{cursor:progress;opacity:.75}
.dshpe_button[data-active="true"]{color:var(--dsw-static-deepseek-500,#4d6bfe);background:var(--dsw-alias-bg-l2,rgba(127,127,127,.14))}
.dshpe_spin{display:inline-block;width:13px;height:13px;border:1.6px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dshpe_spin .8s linear infinite}
@keyframes dshpe_spin{to{transform:rotate(360deg)}}
.dshpe_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px));max-width:calc(var(--dsh-composer-card-max-width,960px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px));margin:0 auto 8px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:12px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-l1,#fff));overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary,#111)}
.dshpe_head{display:flex;align-items:center;gap:8px;padding:6px 12px;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:12px;line-height:20px}
.dshpe_head strong{color:var(--dsw-alias-label-primary,#111);font-weight:500}
.dshpe_head .dshpe_grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpe_model{flex:none;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary,#8b8b8b);border-radius:8px;padding:1px 8px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpe_model:hover{border-color:var(--dsw-static-deepseek-500,#4d6bfe);color:var(--dsw-alias-label-primary,#111)}
.dshpe_close{border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px;padding:0 2px}
.dshpe_body{display:flex;flex-direction:column;gap:6px;padding:0 12px 10px}
.dshpe_item{display:flex;gap:8px;align-items:flex-start;width:100%;text-align:left;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;border-radius:10px;padding:7px 10px;cursor:pointer;color:inherit;font:inherit}
.dshpe_item:hover{border-color:var(--dsw-static-deepseek-500,#4d6bfe)}
.dshpe_item[data-active="true"]{border-color:var(--dsw-static-deepseek-500,#4d6bfe);background:var(--dsw-alias-bg-l2,rgba(127,127,127,.08))}
.dshpe_key{flex:none;width:18px;height:18px;border-radius:5px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#8b8b8b);font-size:11px;line-height:18px;text-align:center}
.dshpe_text{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto;color:var(--dsw-alias-label-primary,#111);font-size:12.5px;line-height:19px}
.dshpe_msg{padding:0 12px 10px;color:var(--dsw-alias-label-secondary,#8b8b8b);font-size:12.5px;line-height:19px;white-space:pre-wrap;word-break:break-word}
.dshpe_msg[data-kind="error"]{color:var(--dsw-alias-state-error-primary,#d54941)}
`;

    function injectCss() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = '@linxin666/dsh-prompt-enhancer';
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------ *
     * ✨ 按钮（conversation.input.right）。
     * ------------------------------------------------------------------ */

    function EnhanceButton(props) {
      const state = useEnhancer();
      const useInput = props?.useInput;
      const draft = typeof useInput === 'function' ? useInput((value) => value.draft) : undefined;
      if (typeof draft === 'string') draftRef = draft;
      if (props?.inputActions !== undefined && props.inputActions !== null) inputActionsRef = props.inputActions;
      if (typeof props?.sessionId === 'string') sessionIdRef = props.sessionId;

      const busy = state.phase === 'busy';
      // 候选框/模型选择框打开时再点一次是收起；error 态再点是重试
      const toggleable = state.phase === 'ready' || state.phase === 'picker';
      const onClick = () => {
        if (busy) return;
        if (toggleable) reset();
        else void generate(null);
      };
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dshpe_button',
          'data-active': state.phase !== 'idle' ? 'true' : 'false',
          title: busy ? '正在生成…' : '生成清晰提示词（Ctrl+Shift+Enter）',
          'aria-label': '生成清晰提示词',
          disabled: busy,
          onMouseDown: (event) => event.preventDefault(),
          onClick,
        },
        busy ? React.createElement('span', { className: 'dshpe_spin' }) : '✨',
      );
    }

    /* ------------------------------------------------------------------ *
     * 候选框（conversation.input.dock）。
     * ------------------------------------------------------------------ */

    function CandidatePanel(props) {
      const state = useEnhancer();
      // dock 插槽的 owner props 自带 InputState，用它兜底同步草稿
      const ownerDraft = props?.input?.draft;
      if (typeof ownerDraft === 'string') draftRef = ownerDraft;
      const { phase, candidates, index, error, info, picker, pickerTitle, modelLabel } = state;

      React.useEffect(() => {
        if (phase === 'idle' || phase === 'busy') return undefined;
        const onKeyDown = (event) => {
          const key = event.key;
          const swallow = () => {
            event.preventDefault();
            event.stopPropagation();
          };
          if (key === 'Escape') {
            swallow();
            // 从候选框点进来的模型列表，Esc 退回候选；否则整体关闭
            if (phase === 'picker' && candidates.length > 0) patch({ phase: 'ready', picker: [], pickerTitle: null });
            else reset();
            return;
          }
          if (phase === 'picker') {
            const slot = Number.parseInt(key, 10);
            if (Number.isInteger(slot) && slot >= 1 && slot <= picker.length) {
              swallow();
              void chooseFromPicker(picker[slot - 1]);
            }
            return;
          }
          if (phase !== 'ready' || candidates.length === 0) return;
          if (key === 'ArrowUp' || key === 'ArrowDown') {
            swallow();
            const step = key === 'ArrowUp' ? -1 : 1;
            const next = (index + step + candidates.length) % candidates.length;
            patch({ index: next });
            return;
          }
          if (key === 'ArrowLeft' || key === 'ArrowRight') {
            swallow();
            void generate(key === 'ArrowLeft' ? '换一个明显不同的角度重写' : '换一种策略重写，尽量与上一次不同');
            return;
          }
          if (key === 'Enter') {
            swallow();
            adopt(candidates[index]);
            return;
          }
          const slot = Number.parseInt(key, 10);
          if (Number.isInteger(slot) && slot >= 1 && slot <= candidates.length) {
            swallow();
            adopt(candidates[slot - 1]);
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, [phase, candidates, index, picker]);

      if (phase === 'idle' || phase === 'busy') return null;

      const header = React.createElement(
        'div',
        { className: 'dshpe_head' },
        React.createElement('strong', null, phase === 'picker' ? '🤖 选择模型' : '✨ 提示词候选'),
        phase === 'ready' && modelLabel !== null
          ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'dshpe_model',
                title: '换个模型重新生成',
                'aria-label': `切换模型，当前 ${modelLabel}`,
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => void openModelSwitch(),
              },
              `${modelLabel} ▾`,
            )
          : null,
        React.createElement('span', { className: 'dshpe_grow' }, phase === 'picker' ? (pickerTitle ?? '') : (info ?? '')),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dshpe_close',
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => reset(),
          },
          'Esc 关闭',
        ),
      );

      if (phase === 'error') {
        return React.createElement(
          'div',
          { className: 'dshpe_dock', 'data-slot': 'prompt-enhancer' },
          header,
          React.createElement('div', { className: 'dshpe_msg', 'data-kind': 'error' }, error ?? '生成失败'),
        );
      }

      if (phase === 'picker') {
        return React.createElement(
          'div',
          { className: 'dshpe_dock' },
          header,
          React.createElement(
            'div',
            { className: 'dshpe_body' },
            ...picker.map((entry, position) =>
              React.createElement(
                'button',
                {
                  key: `${entry.provider}/${entry.model}`,
                  type: 'button',
                  className: 'dshpe_item',
                  'data-active': entry.label === modelLabel ? 'true' : 'false',
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => void chooseFromPicker(entry),
                },
                React.createElement('span', { className: 'dshpe_key' }, String(position + 1)),
                React.createElement('span', { className: 'dshpe_text' }, entry.label),
              ),
            ),
          ),
        );
      }

      const hint = React.createElement(
        'div',
        { className: 'dshpe_msg' },
        '↑↓ 切换 · 1/2/3 采纳 · Enter 采纳当前 · ←→ 重新生成 · 点模型名换模型 · Esc 关闭',
      );

      return React.createElement(
        'div',
        { className: 'dshpe_dock' },
        header,
        React.createElement(
          'div',
          { className: 'dshpe_body' },
          ...candidates.map((text, position) =>
            React.createElement(
              'button',
              {
                key: `candidate-${position}`,
                type: 'button',
                className: 'dshpe_item',
                'data-active': position === index ? 'true' : 'false',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => adopt(text),
              },
              React.createElement('span', { className: 'dshpe_key' }, String(position + 1)),
              React.createElement('span', { className: 'dshpe_text' }, text),
            ),
          ),
        ),
        hint,
      );
    }

    /* ------------------------------------------------------------------ *
     * 插件入口。
     * ------------------------------------------------------------------ */

    // cordis 要求把用到的子服务显式列出来，否则 ctx.remote.session 会抛
    // "cannot get property ... without inject"（与官方 dsh-client-ui-plan 的写法一致）。
    const inject = ['slots', 'remote', 'remote.session'];

    function apply(ctx) {
      clientCtx = ctx;
      injectCss();
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'prompt-enhancer',
            order: 20,
          },
          EnhanceButton,
        ),
      );
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'prompt-enhancer',
            order: 400,
          },
          CandidatePanel,
        ),
      );
      ctx.effect(() => {
        const onKeyDown = (event) => {
          if (event.ctrlKey && event.shiftKey && event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (snapshot.phase === 'idle') void generate(null);
            else if (snapshot.phase === 'ready' || snapshot.phase === 'error') reset();
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, 'prompt-enhancer: shortcut');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'prompt-enhancer';
    return module.exports;
  },
});
