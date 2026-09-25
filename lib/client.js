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
    /** 单条候选最多展示几个待定点、每个待定点最多几个方向选项。 */
    const MAX_GAPS = 3;
    const MAX_OPTIONS = 4;
    const CSS_TAG_ID = '@linxin666/dsh-prompt-enhancer/client.css';

    /* ------------------------------------------------------------------ *
     * 共享状态：按钮与候选框分处两个插槽，靠这个快照 store 通信。
     * ------------------------------------------------------------------ */

    const INITIAL = {
      phase: 'idle', // idle | busy | ready | picker | error
      /** 每条候选：{ text, gaps: [{ question, options: [{ label, fill, effect, placeholder }] }] } */
      candidates: [],
      index: 0,
      error: null,
      info: null,
      /** 当前生成用的模型标签（ready 态显示，可点击切换）。 */
      modelLabel: null,
      picker: [],
      /** picker 态的表头文案（首次无 flash / 主动切换，两种情况不同）。 */
      pickerTitle: null,
      /** 已拍板的方向：key = `${候选下标}:${待定点下标}` → 选项下标。 */
      selections: {},
      /** 键盘焦点区：candidates（选候选）/ gaps（拍板方向）。 */
      focus: 'candidates',
      /** 焦点在 gaps 时，当前正在拍板的待定点下标。 */
      activeGap: 0,
      /** 是否展开效果方向图。 */
      showTree: false,
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
     * 候选规范化 + 方向选项回填。
     * ------------------------------------------------------------------ */

    const selectionKey = (candidateIndex, gapIndex) => `${candidateIndex}:${gapIndex}`;

    /**
     * 把服务端返回的候选规范成 `{ text, gaps }`（兼容只有字符串的旧响应）。
     * @param raw - 响应里的 candidates 字段。
     * @returns 规范化后的候选数组。
     */
    function normalizeCandidates(raw) {
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        if (typeof item === 'string') {
          if (item.trim() !== '') out.push({ text: item.trim(), gaps: [] });
          continue;
        }
        if (item === null || typeof item !== 'object') continue;
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (text === '') continue;
        const gaps = [];
        for (const gap of Array.isArray(item.gaps) ? item.gaps : []) {
          if (gaps.length >= MAX_GAPS) break;
          if (gap === null || typeof gap !== 'object') continue;
          const question = typeof gap.question === 'string' ? gap.question.trim() : '';
          if (question === '') continue;
          const options = [];
          for (const option of Array.isArray(gap.options) ? gap.options : []) {
            if (options.length >= MAX_OPTIONS) break;
            if (option === null || typeof option !== 'object') continue;
            const label = typeof option.label === 'string' ? option.label.trim() : '';
            if (label === '') continue;
            const fill = typeof option.fill === 'string' && option.fill.trim() !== '' ? option.fill.trim() : label;
            options.push({
              label,
              fill,
              effect: typeof option.effect === 'string' ? option.effect.trim() : '',
              placeholder: typeof option.placeholder === 'string' ? option.placeholder : '',
            });
          }
          // 只有一个选项的"选择"没有意义，丢掉
          if (options.length >= 2) gaps.push({ question, options });
        }
        out.push({ text, gaps });
      }
      return out;
    }

    /**
     * 把已拍板的方向填回候选正文：能定位到占位符就原地替换，
     * 定位不到的（模型给的是"新约束"而不是填空）统一追加到【补充要求】。
     * @param candidate - 候选对象。
     * @param selections - 选择表。
     * @param candidateIndex - 候选下标。
     * @returns 可直接写进输入框的提示词。
     */
    function applySelections(candidate, selections, candidateIndex) {
      let text = candidate.text;
      const extras = [];
      candidate.gaps.forEach((gap, gapIndex) => {
        const choice = selections[selectionKey(candidateIndex, gapIndex)];
        if (choice === undefined) return;
        const option = gap.options[choice];
        if (option === undefined) return;
        if (option.placeholder !== '' && text.includes(option.placeholder)) {
          text = text.replace(option.placeholder, option.fill);
          return;
        }
        extras.push(option.fill);
      });
      if (extras.length > 0) {
        text = `${text}\n\n【补充要求】\n${extras.map((item) => `- ${item}`).join('\n')}`;
      }
      return text;
    }

    /** 已拍板数量 / 待定点总数。 */
    function countDecided(candidate, selections, candidateIndex) {
      let decided = 0;
      candidate.gaps.forEach((gap, gapIndex) => {
        if (selections[selectionKey(candidateIndex, gapIndex)] !== undefined) decided += 1;
      });
      return { decided, total: candidate.gaps.length };
    }

    /** 压成一行并截断，用于方向图顶部的草稿预览。 */
    function truncate(text, max) {
      const oneLine = text.replace(/\s+/gu, ' ').trim();
      return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
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
      const candidates = normalizeCandidates(payload?.candidates);
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
        patch({
          phase: 'ready',
          candidates,
          index: 0,
          info: null,
          modelLabel: chosen.label,
          selections: {},
          focus: 'candidates',
          activeGap: 0,
          showTree: false,
        });
      } catch (error) {
        patch({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }

    /**
     * 采纳第 N 条候选（带上已拍板的方向）。
     * @param candidateIndex - 候选下标。
     */
    function adopt(candidateIndex) {
      const candidate = snapshot.candidates[candidateIndex];
      if (candidate === undefined) return;
      const actions = inputActionsRef;
      if (actions === null || typeof actions.setDraft !== 'function') {
        patch({ phase: 'error', error: '当前输入框不支持写入草稿。' });
        return;
      }
      actions.setDraft(applySelections(candidate, snapshot.selections, candidateIndex));
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
.dshpe_badge{flex:none;align-self:flex-start;border-radius:6px;padding:0 6px;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#8b8b8b)}
.dshpe_badge[data-done="true"]{color:var(--dsw-alias-state-success-primary,#3ba55d)}
.dshpe_toggle{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b8b8b);cursor:pointer;font-size:12px;padding:0 4px}
.dshpe_toggle:hover{color:var(--dsw-alias-label-primary,#111)}
.dshpe_toggle[data-active="true"]{color:var(--dsw-static-deepseek-500,#4d6bfe)}
.dshpe_gaps{margin:0 12px 10px;border:.5px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:8px}
.dshpe_gaps[data-focus="true"]{border-style:solid;border-color:var(--dsw-static-deepseek-500,#4d6bfe)}
.dshpe_gaps_head{color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:12px}
.dshpe_gap{display:flex;flex-direction:column;gap:5px}
.dshpe_gap_q{color:var(--dsw-alias-label-primary,#111);font-size:12.5px;line-height:19px}
.dshpe_gap[data-active="true"] .dshpe_gap_q{color:var(--dsw-static-deepseek-500,#4d6bfe)}
.dshpe_chips{display:flex;flex-wrap:wrap;gap:6px}
.dshpe_chip{display:inline-flex;align-items:center;gap:5px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary,#8b8b8b);border-radius:999px;padding:2px 10px;font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshpe_chip:hover{border-color:var(--dsw-static-deepseek-500,#4d6bfe);color:var(--dsw-alias-label-primary,#111)}
.dshpe_chip[data-active="true"]{border-color:var(--dsw-static-deepseek-500,#4d6bfe);background:var(--dsw-static-deepseek-500,#4d6bfe);color:#fff}
.dshpe_chip_key{opacity:.75;font-size:11px}
.dshpe_tree{margin:0 12px 10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:10px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.06));font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:11.5px;line-height:17px;white-space:pre;overflow-x:auto;color:var(--dsw-alias-label-secondary,#8b8b8b)}
.dshpe_tree_root,.dshpe_tree_gap{color:var(--dsw-alias-label-primary,#111)}
.dshpe_tree_opt[data-active="true"],.dshpe_tree_eff[data-active="true"]{color:var(--dsw-static-deepseek-500,#4d6bfe)}
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
      const { phase, candidates, index, error, info, picker, pickerTitle, modelLabel, selections, focus, activeGap, showTree } = state;

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
            // 优先级：模型列表退回候选 > 拍板区退回候选 > 整体关闭
            if (phase === 'picker' && candidates.length > 0) patch({ phase: 'ready', picker: [], pickerTitle: null });
            else if (snapshot.focus === 'gaps') patch({ focus: 'candidates' });
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

          const current = candidates[index];
          const gaps = current === undefined ? [] : current.gaps;
          const inGaps = snapshot.focus === 'gaps' && gaps.length > 0;

          if (key === 'Tab') {
            swallow();
            if (gaps.length === 0) return;
            patch(inGaps ? { focus: 'candidates' } : { focus: 'gaps', activeGap: 0 });
            return;
          }

          if (inGaps) {
            const gapIndex = Math.min(snapshot.activeGap, gaps.length - 1);
            const gap = gaps[gapIndex];
            const key0 = selectionKey(index, gapIndex);
            if (key === 'ArrowUp' || key === 'ArrowDown') {
              swallow();
              const step = key === 'ArrowUp' ? -1 : 1;
              patch({ activeGap: (gapIndex + step + gaps.length) % gaps.length });
              return;
            }
            if (key === 'ArrowLeft' || key === 'ArrowRight') {
              swallow();
              const chosen = snapshot.selections[key0];
              const base = chosen === undefined ? (key === 'ArrowRight' ? -1 : 0) : chosen;
              const step = key === 'ArrowLeft' ? -1 : 1;
              const count = gap.options.length;
              const next = (((base + step) % count) + count) % count;
              patch({ selections: { ...snapshot.selections, [key0]: next } });
              return;
            }
            if (key === '0') {
              swallow();
              const cleared = { ...snapshot.selections };
              delete cleared[key0];
              patch({ selections: cleared });
              return;
            }
            if (key === 'Enter') {
              swallow();
              patch({ focus: 'candidates' });
              return;
            }
            const optionSlot = Number.parseInt(key, 10);
            if (Number.isInteger(optionSlot) && optionSlot >= 1 && optionSlot <= gap.options.length) {
              swallow();
              patch({ selections: { ...snapshot.selections, [key0]: optionSlot - 1 } });
            }
            return;
          }

          if (key === 'ArrowUp' || key === 'ArrowDown') {
            swallow();
            const step = key === 'ArrowUp' ? -1 : 1;
            const next = (index + step + candidates.length) % candidates.length;
            patch({ index: next, activeGap: 0 });
            return;
          }
          if (key === 'ArrowLeft' || key === 'ArrowRight') {
            swallow();
            void generate(key === 'ArrowLeft' ? '换一个明显不同的角度重写' : '换一种策略重写，尽量与上一次不同');
            return;
          }
          if (key === 'Enter') {
            swallow();
            adopt(index);
            return;
          }
          const slot = Number.parseInt(key, 10);
          if (Number.isInteger(slot) && slot >= 1 && slot <= candidates.length) {
            swallow();
            adopt(slot - 1);
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, [phase, candidates, index, picker, focus, activeGap, selections]);

      if (phase === 'idle' || phase === 'busy') return null;

      const activeCandidate = candidates[index];
      const gaps = activeCandidate === undefined ? [] : activeCandidate.gaps;
      const decided = activeCandidate === undefined ? { decided: 0, total: 0 } : countDecided(activeCandidate, selections, index);

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
        phase === 'ready' && gaps.length > 0
          ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'dshpe_toggle',
                'data-active': showTree ? 'true' : 'false',
                'aria-label': showTree ? '收起效果方向图' : '展开效果方向图',
                title: '看每个方向会把这条提示词带向什么效果',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => patch({ showTree: !snapshot.showTree }),
              },
              showTree ? '收起方向图' : '看方向图',
            )
          : null,
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
        gaps.length === 0
          ? '↑↓ 切换 · 1/2/3 采纳 · Enter 采纳当前 · ←→ 重新生成 · 点模型名换模型 · Esc 关闭'
          : '↑↓ 切换候选 · 1/2/3 采纳 · ←→ 重新生成 · Tab 进入拍板 · 点模型名换模型 · Esc 关闭',
      );

      const candidateList = React.createElement(
        'div',
        { className: 'dshpe_body' },
        ...candidates.map((candidate, position) => {
          const stat = countDecided(candidate, selections, position);
          return React.createElement(
            'button',
            {
              key: `candidate-${position}`,
              type: 'button',
              className: 'dshpe_item',
              'data-active': position === index ? 'true' : 'false',
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => adopt(position),
            },
            React.createElement('span', { className: 'dshpe_key' }, String(position + 1)),
            React.createElement('span', { className: 'dshpe_text' }, candidate.text),
            candidate.gaps.length === 0
              ? null
              : React.createElement(
                  'span',
                  { className: 'dshpe_badge', 'data-done': stat.decided === stat.total ? 'true' : 'false' },
                  stat.decided === stat.total ? `已定 ${stat.total}/${stat.total}` : `待定 ${stat.total - stat.decided} 处`,
                ),
          );
        }),
      );

      // 拍板区：只针对当前高亮的那条候选
      const gapsBlock =
        gaps.length === 0
          ? null
          : React.createElement(
              'div',
              { className: 'dshpe_gaps', 'data-focus': focus === 'gaps' ? 'true' : 'false' },
              React.createElement(
                'div',
                { className: 'dshpe_gaps_head' },
                `需要你拍板 ${gaps.length} 处 · 已定 ${decided.decided}/${decided.total}`,
              ),
              ...gaps.map((gap, gapIndex) => {
                const chosen = selections[selectionKey(index, gapIndex)];
                const isActiveGap = focus === 'gaps' && gapIndex === Math.min(activeGap, gaps.length - 1);
                return React.createElement(
                  'div',
                  { key: `gap-${gapIndex}`, className: 'dshpe_gap', 'data-active': isActiveGap ? 'true' : 'false' },
                  React.createElement('div', { className: 'dshpe_gap_q' }, `${gapIndex + 1} ${gap.question}`),
                  React.createElement(
                    'div',
                    { className: 'dshpe_chips' },
                    ...gap.options.map((option, optionIndex) =>
                      React.createElement(
                        'button',
                        {
                          key: `option-${optionIndex}`,
                          type: 'button',
                          className: 'dshpe_chip',
                          'data-active': chosen === optionIndex ? 'true' : 'false',
                          title: option.effect === '' ? option.fill : option.effect,
                          onMouseDown: (event) => event.preventDefault(),
                          onClick: () =>
                            patch({
                              selections: {
                                ...snapshot.selections,
                                [selectionKey(index, gapIndex)]: chosen === optionIndex ? undefined : optionIndex,
                              },
                            }),
                        },
                        React.createElement('span', { className: 'dshpe_chip_key' }, String(optionIndex + 1)),
                        React.createElement('span', null, option.label),
                      ),
                    ),
                  ),
                );
              }),
            );

      // 效果方向图：缩进树，跟着当前选择高亮
      const treeBlock =
        !showTree || gaps.length === 0
          ? null
          : React.createElement(
              'div',
              { className: 'dshpe_tree' },
              React.createElement('div', { className: 'dshpe_tree_root' }, `草稿：${truncate(readDraft().trim(), 36)}`),
              ...gaps.flatMap((gap, gapIndex) => {
                const chosen = selections[selectionKey(index, gapIndex)];
                const rows = [
                  React.createElement('div', { key: `tree-gap-${gapIndex}`, className: 'dshpe_tree_gap' }, `├─ ${gapIndex + 1} ${gap.question}`),
                ];
                gap.options.forEach((option, optionIndex) => {
                  const isLast = optionIndex === gap.options.length - 1;
                  const active = chosen === optionIndex;
                  rows.push(
                    React.createElement(
                      'div',
                      { key: `tree-opt-${gapIndex}-${optionIndex}`, className: 'dshpe_tree_opt', 'data-active': active ? 'true' : 'false' },
                      `${isLast ? '└─' : '├─'} ${option.label}${active ? '   ◀ 当前' : ''}`,
                    ),
                  );
                  if (option.effect !== '') {
                    rows.push(
                      React.createElement(
                        'div',
                        { key: `tree-eff-${gapIndex}-${optionIndex}`, className: 'dshpe_tree_eff', 'data-active': active ? 'true' : 'false' },
                        `${isLast ? '   ' : '│  '} └ 效果：${option.effect}`,
                      ),
                    );
                  }
                });
                return rows;
              }),
            );

      return React.createElement('div', { className: 'dshpe_dock' }, header, candidateList, gapsBlock, treeBlock, hint);
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
