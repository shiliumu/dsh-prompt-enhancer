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

    /* ---- v0.3 参谋方向引擎：额外路由与取值域 ---- */
    const ADVISOR_ROUTE = '/prompt-enhancer/advisor';
    const REVIEW_ROUTE = '/prompt-enhancer/review';
    const ADVISOR_MODES = [
      { id: 'auto', label: '自动' },
      { id: 'reconnaissance', label: '侦察' },
      { id: 'planning', label: '谋划' },
      { id: 'decision', label: '决策' },
      { id: 'execution', label: '执行' },
      { id: 'review', label: '复盘' },
    ];
    const ADVISOR_TYPE_LABELS = {
      root: '想法', goal: '目标', fact: '事实', inference: '推断', assumption: '假设',
      constraint: '约束', direction: '方案', risk: '风险', signal: '信号', action: '行动', question: '疑问',
    };
    const ADV_SOURCE_LABELS = { user: '用户', evidence: '已验证', model: '模型推断', unconfirmed: '待确认' };
    const ADV_LEVEL_LABELS = { high: '高', medium: '中', low: '低' };
    const ADV_STATUS_LABELS = { open: '开放', verified: '已验证', rejected: '已否决', superseded: '已过时' };
    const ADV_DEAD_STATUSES = ['rejected', 'superseded'];

    /* ------------------------------------------------------------------ *
     * 共享状态：按钮与候选框分处两个插槽，靠这个快照 store 通信。
     * ------------------------------------------------------------------ */

    const INITIAL = {
      /* ---- v0.3 参谋态（与改写态同处一个快照，两套 dock 各读自己那段）---- */
      advPhase: 'idle',
      advMode: 'auto',
      situation: null,
      advStructured: true,
      advFallbackText: '',
      advError: null,
      advInfo: null,
      advModelLabel: null,
      advPicker: [],
      advPickerTitle: null,
      advSelected: null,
      advCollapsed: {},
      advReviewResult: null,
      advReviewBusy: false,
      advExported: null,
      advResumed: false,
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
      // 只清改写流程自己的状态，并顺手把参谋面板收掉（两套 dock 共用一个快照，
      // 谁结束都不能把对方留在屏幕上）。advMode 是用户偏好，保留。
      patch({
        ...INITIAL,
        advMode: snapshot.advMode,
        advPhase: 'idle',
        situation: null,
        advError: null,
        advInfo: null,
        advReviewResult: null,
        advExported: null,
        advSelected: null,
        advCollapsed: {},
        advResumed: false,
      });
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
    /** 失败后推进模型选择框时，暂存"当时真正提交失败的那份草稿"。 */
    let pendingDraftRef = null;

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
     * 实测会「只产出思维链、不产出正文」的模型（在本机 tokenrhythm 上复现：
     * 正文为空、心跳 24–56s，换 deepseek/mimo 系即正常）。命中者在选择框打标，
     * 参谋选模型时也被过滤——**这是唯一的判据来源**，两处共用，别再分裂第二份。
     */
    const EMPTY_TEXT_MODELS = [/^glm-5\.3/i, /^qwen3\.8/i, /^kimi/i];
    const isKnownEmptyTextModel = (entry) => EMPTY_TEXT_MODELS.some((pattern) => pattern.test(entry.model));

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

    /**
     * 统一的 JSON 请求：非 2xx 时把 Host 回的 error/code/detail 原样带进 Error，
     * 供上层区分"只出思维链 / 完全空白"并直接推模型选择框。
     * @param route - 路由。
     * @param body - 请求体。
     * @returns 解析后的响应对象。
     */
    async function requestJson(route, body) {
      const response = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // 解析失败不能吞成 null 继续走——那会把"响应不是 JSON"伪装成一次成功，
        // 让上层拿到空对象却以为拿到了数据（本次 debug 实测踩中）。
        throw new Error(`响应不是合法 JSON（HTTP ${response.status}）`);
      }
      if (!response.ok) {
        const error = new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`);
        if (typeof payload?.code === 'string') error.code = payload.code;
        if (payload?.detail !== null && typeof payload.detail === 'object') error.detail = payload.detail;
        throw error;
      }
      return payload;
    }

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
      if (!response.ok) {
        const error = new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`);
        // Host 能判定的失败类型（只出思维链 / 完全空白）随响应带回，供上层决定
        // 是否直接把模型选择框推给用户。
        if (typeof payload?.code === 'string') error.code = payload.code;
        if (payload?.detail !== null && typeof payload.detail === 'object') error.detail = payload.detail;
        throw error;
      }
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
      // 失败推进来的选择框：模型目录里的每个候选都可能救场，而"只找 flash"
      // 恰好会把用户锁死在出问题的那个 flash 上，所以这里从不按 flash 过滤。
      patch({
        phase: 'picker',
        picker: models,
        pickerTitle: title,
        index: 0,
        ...(keepCandidates ? {} : { candidates: [] }),
      });
    }

    async function generate(direction, draftOverride) {
      if (snapshot.phase === 'busy') return;
      const text = (typeof draftOverride === 'string' ? draftOverride : readDraft()).trim();
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
        const message = error instanceof Error ? error.message : String(error);
        patch({ phase: 'error', error: message });
        // 模型这一侧的问题（只出思维链 / 完全空白）几乎都能靠换模型解决，
        // 直接把选择框推上来，省掉"看报错→自己找模型名→猜哪个能用"。
        if (error?.code === 'reasoning-only' || error?.code === 'empty-output') {
          pendingDraftRef = text;
          try {
            await openPicker('这个模型没有产出正文，换一个再来（数字键或点击）：', true);
          } catch {
            /* 目录读不到就保持错误态 */
          }
        }
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
      // 失败推进来的选择框：输入框里的草稿可能已被清掉或改过，这时沿用当时
      // 真正提交失败的那份；从候选框主动换模型则沿用输入框当前内容。
      const draft = pendingDraftRef ?? readDraft().trim();
      pendingDraftRef = null;
      patch({ phase: 'idle', picker: [], pickerTitle: null, info: null });
      await generate(null, draft);
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
      tag.textContent = CSS + ADVISOR_CSS;
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
        React.createElement('span', { className: 'dshpe_grow' }, phase === 'picker'
          ? [pickerTitle ?? '', error === null ? '' : `（上次失败：${error}）`].join('')
          : (info ?? '')),
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
        phase === 'error' && candidates.length === 0
          ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'dshpe_toggle',
                title: '换一个模型重新生成（原草稿不变）',
                'aria-label': '换一个模型重新生成',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => void openModelSwitch(),
              },
              '换模型',
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
          phase === 'picker' && candidates.length > 0 ? 'Esc 返回候选' : 'Esc 关闭',
        ),
      );

      if (phase === 'error') {
        return React.createElement(
          'div',
          { className: 'dshpe_dock', 'data-slot': 'prompt-enhancer' },
          header,
          React.createElement('div', { className: 'dshpe_msg', 'data-kind': 'error' }, error ?? '生成失败'),
          React.createElement(
            'div',
            { className: 'dshpe_msg' },
            '这次失败多半是模型这一侧的问题：点上面的「换模型」挑一个再生成，草稿不用重打。',
          ),
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
                isKnownEmptyTextModel(entry)
                  ? React.createElement(
                      'span',
                      { className: 'dshpe_badge', title: '实测这一个常只出思维链、不产出正文' },
                      '⚠ 易空正文',
                    )
                  : null,
              ),
            ),
          ),
          React.createElement(
            'div',
            { className: 'dshpe_msg' },
            `${picker.length} 个可选模型：按数字键选前 9 个，或直接点击；选完立刻用新模型重新生成。${candidates.length > 0 ? ' Esc 返回候选。' : ' Esc 关闭。'}`,
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


    /* ================================================================== *
     * v0.3 参谋方向引擎
     *
     * 视图原则：缩进树是局势模型的一个视图，不是产物本身。因此下面渲染的是
     * intent / situation / directions / questions 这些结构化字段，树只是它们的
     * 分层呈现，每个节点带类型/来源/置信度/状态徽标。
     *
     * 本段只依赖 client.js 已有的工具（patch/getSnapshot/useEnhancer/loadCatalog/
     * flattenCatalog/requestJson/inputActionsRef/sessionIdRef/truncate/draftRef）。
     * ================================================================== */

    /* ---- v0.3 advisor ---- */

    let advPreferredModel = null;
    let advPendingDraft = null;

    const advReset = () => patch({
      advPhase: 'idle', situation: null, advError: null, advInfo: null,
      advReviewResult: null, advExported: null, advSelected: null, advCollapsed: {}, advResumed: false,
    });

    /** 参谋分析要跑长 JSON；实测带思考块的模型常空正文，优先不带思考块的。与选择框打标共用同一判据。 */
    const isFastModel = (entry) => !isKnownEmptyTextModel(entry);

    async function advResolveModel() {
      if (advPreferredModel !== null) return advPreferredModel;
      const catalog = await loadCatalog();
      const models = flattenCatalog(catalog);
      if (models.length === 0) throw new Error('本地没有可用模型，请先在设置里配置提供商。');
      const usable = models.filter(isFastModel);
      if (usable.length === 0) return null;
      const defaultProvider = catalog?.default?.provider;
      return usable.find((entry) => entry.provider === defaultProvider && /flash/i.test(entry.model))
        ?? usable.find((entry) => entry.provider === defaultProvider)
        ?? usable.find((entry) => /flash/i.test(entry.model))
        ?? usable[0];
    }

    async function advOpenPicker(title, keepSituation = false) {
      const catalog = await loadCatalog();
      const models = flattenCatalog(catalog).slice(0, PICKER_LIMIT);
      patch({
        advPhase: 'picker',
        advPicker: models,
        advPickerTitle: title,
        ...(keepSituation ? {} : { situation: null }),
      });
    }

    /**
     * 生成或更新局势模型。
     * @param resume - true 时让 Host 带上本会话上一份模型，走"更新"而不是"重生成"。
     * @param draftOverride - 失败后换模型重试时沿用当初提交的草稿。
     */
    async function advAnalyze(resume = false, draftOverride) {
      if (snapshot.advPhase === 'busy') return;
      const text = (typeof draftOverride === 'string' ? draftOverride : readDraft()).trim();
      if (text === '') {
        patch({ advPhase: 'error', advError: '输入框是空的，先写一句你的想法，再点「参谋」。' });
        return;
      }
      patch({ advPhase: 'busy', advError: null, advInfo: null, advReviewResult: null, advExported: null });
      try {
        const chosen = await advResolveModel();
        if (chosen === null) {
          await advOpenPicker('本地没有可用模型，按数字键选一个：');
          return;
        }
        const body = { text, provider: chosen.provider, model: chosen.model, resume };
        if (snapshot.advMode !== 'auto') body.mode = snapshot.advMode;
        if (typeof sessionIdRef === 'string' && sessionIdRef !== '') body.sessionId = sessionIdRef;
        const payload = await requestJson(ADVISOR_ROUTE, body);
        const situation = payload?.situation ?? null;
        const recommended = situation?.recommendation?.direction_id;
        patch({
          advPhase: 'ready',
          situation,
          advStructured: payload?.structured !== false,
          advFallbackText: payload?.fallbackText ?? '',
          advModelLabel: chosen.label,
          advSelected: recommended === undefined || recommended === 'undetermined' ? null : recommended,
          advResumed: payload?.resumed === true,
          advCollapsed: {},
          advInfo: payload?.resumed === true ? '已更新局势模型（保留仍有效的判断）' : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        patch({ advPhase: 'error', advError: message });
        if (error?.code === 'reasoning-only' || error?.code === 'empty-output') {
          advPendingDraft = text;
          try {
            await advOpenPicker('这个模型没有产出正文，换一个再来（数字键或点击）：', true);
          } catch {
            /* 目录读不到就保持错误态 */
          }
        }
      }
    }

    async function advChooseFromPicker(entry) {
      advPreferredModel = entry;
      const draft = advPendingDraft ?? readDraft().trim();
      advPendingDraft = null;
      patch({ advPhase: 'idle', advPicker: [], advPickerTitle: null });
      await advAnalyze(false, draft);
    }

    /** 手动复查：只标注问题，不阻断。 */
    async function advRunReview() {
      const situation = snapshot.situation;
      if (situation === null || snapshot.advReviewBusy === true) return;
      const chosen = advPreferredModel ?? (await advResolveModel());
      if (chosen === null) {
        patch({ advPhase: 'error', advError: '还没有可用模型，无法复查。' });
        return;
      }
      patch({ advReviewBusy: true, advError: null });
      try {
        const body = { provider: chosen.provider, model: chosen.model, state: situation };
        if (typeof sessionIdRef === 'string' && sessionIdRef !== '') body.sessionId = sessionIdRef;
        const payload = await requestJson(REVIEW_ROUTE, body);
        patch({ advReviewResult: payload?.review ?? null, advReviewBusy: false });
      } catch (error) {
        patch({ advReviewBusy: false, advError: error instanceof Error ? error.message : String(error) });
      }
    }

    /** 把选中方向导出成可执行提示词（复用 v0.2 的改写端点）。 */
    async function advExportPrompt() {
      const situation = snapshot.situation;
      const direction = (situation?.directions ?? []).find((item) => item.id === snapshot.advSelected);
      if (direction === undefined) return;
      const chosen = advPreferredModel ?? (await advResolveModel());
      if (chosen === null) {
        patch({ advPhase: 'error', advError: '还没有可用模型，无法导出。' });
        return;
      }
      const constraints = situation?.situation?.constraints ?? [];
      const ask = [
        `按「${direction.name}」这个方向，给我一份可直接执行的提示词。`,
        direction.thesis === '' ? '' : `策略：${direction.thesis}`,
        direction.premises.length === 0 ? '' : `前提：${direction.premises.join('；')}`,
        constraints.length === 0 ? '' : `硬约束：${constraints.join('；')}`,
        direction.first_action === '' ? '' : `第一步：${direction.first_action}`,
        direction.risks.length === 0 ? '' : `需要防范：${direction.risks.join('；')}`,
        situation?.intent?.primary ? `目标：${situation.intent.primary}` : '',
      ].filter((line) => line !== '').join('\n');
      patch({ advPhase: 'busy', advError: null });
      try {
        const body = { text: ask, provider: chosen.provider, model: chosen.model, count: 1 };
        if (typeof sessionIdRef === 'string' && sessionIdRef !== '') body.sessionId = sessionIdRef;
        const payload = await requestJson(ROUTE, body);
        patch({
          advPhase: 'ready',
          advExported: payload?.candidates?.[0]?.text ?? '',
          advInfo: '已生成可执行提示词，点「采纳提示词」写进输入框',
        });
      } catch (error) {
        patch({ advPhase: 'error', advError: error instanceof Error ? error.message : String(error) });
      }
    }

    /** 采纳：优先采纳导出的提示词，否则把局势小结写进输入框。 */
    function advAdopt() {
      const actions = inputActionsRef;
      if (actions === null || typeof actions.setDraft !== 'function') {
        patch({ advPhase: 'error', advError: '当前输入框不支持写入草稿。' });
        return;
      }
      if (snapshot.advExported !== null) {
        actions.setDraft(snapshot.advExported);
        advReset();
        return;
      }
      const situation = snapshot.situation;
      const direction = (situation?.directions ?? []).find((item) => item.id === snapshot.advSelected);
      const lines = [
        situation?.intent?.primary ? `目标：${situation.intent.primary}` : '',
        direction ? `方向：${direction.name}——${direction.thesis}` : '',
        direction?.first_action ? `第一步：${direction.first_action}` : '',
        (situation?.questions ?? []).length > 0
          ? `需要先确认：${situation.questions.map((item) => item.question).join('；')}`
          : '',
      ].filter((line) => line !== '');
      actions.setDraft(lines.join('\n'));
      advReset();
    }

    /* ---------------- 参谋按钮 ---------------- */

    function AdvisorButton(props) {
      const state = useEnhancer();
      const useInput = props?.useInput;
      const draft = typeof useInput === 'function' ? useInput((value) => value.draft) : undefined;
      if (typeof draft === 'string') draftRef = draft;
      if (props?.inputActions !== undefined && props.inputActions !== null) inputActionsRef = props.inputActions;
      if (typeof props?.sessionId === 'string') sessionIdRef = props.sessionId;

      const busy = state.advPhase === 'busy';
      const toggleable = state.advPhase === 'ready' || state.advPhase === 'picker';
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dshadv_button',
          'data-active': state.advPhase !== 'idle' ? 'true' : 'false',
          title: busy ? '正在分析…' : '参谋方向引擎：把想法变成可审查的局势与方向（Ctrl+Shift+J）',
          'aria-label': '参谋方向引擎',
          disabled: busy,
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => {
            if (busy) return;
            if (toggleable) advReset();
            else void advAnalyze(false);
          },
        },
        busy ? React.createElement('span', { className: 'dshadv_spin' }) : '🧭',
        React.createElement('span', null, '参谋'),
      );
    }

    /* ---------------- 参谋树与面板 ---------------- */

    const advCountNodes = (node) => (node === null || typeof node !== 'object'
      ? 0
      : 1 + (Array.isArray(node.children) ? node.children.reduce((sum, child) => sum + advCountNodes(child), 0) : 0));

    const advCountByType = (node, tally = {}) => {
      if (node === null || typeof node !== 'object') return tally;
      tally[node.type] = (tally[node.type] ?? 0) + 1;
      for (const child of Array.isArray(node.children) ? node.children : []) advCountByType(child, tally);
      return tally;
    };

    /** 递归渲染节点：类型/来源/置信度/状态徽标 + 可折叠。 */
    function advRenderNode(node, path, state) {
      if (node === null || typeof node !== 'object') return null;
      const children = Array.isArray(node.children) ? node.children : [];
      const collapsed = state.advCollapsed[path] === true;
      const dead = ADV_DEAD_STATUSES.includes(node.status);
      const rows = [
        React.createElement(
          'div',
          { key: `${path}-self`, className: 'dshadv_row', 'data-dead': dead ? 'true' : 'false' },
          children.length === 0
            ? React.createElement('span', { className: 'dshadv_caret' }, ' ')
            : React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dshadv_caret',
                  'aria-label': collapsed ? '展开' : '折叠',
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => patch({ advCollapsed: { ...getSnapshot().advCollapsed, [path]: !collapsed } }),
                },
                collapsed ? '▸' : '▾',
              ),
          React.createElement('span', { className: 'dshadv_label' }, node.label),
          React.createElement('span', { className: 'dshadv_tag', 'data-type': node.type }, ADVISOR_TYPE_LABELS[node.type] ?? node.type),
          React.createElement('span', { className: 'dshadv_tag', 'data-source': node.source }, ADV_SOURCE_LABELS[node.source] ?? node.source),
          node.confidence === 'low' ? React.createElement('span', { className: 'dshadv_tag' }, '置信低') : null,
          node.status === 'open' ? null : React.createElement('span', { className: 'dshadv_tag' }, ADV_STATUS_LABELS[node.status] ?? node.status),
        ),
      ];
      if (!collapsed) {
        children.forEach((child, index) => {
          rows.push(advRenderNode(child, `${path}.${index}`, state));
        });
      }
      return React.createElement('div', { key: path }, ...rows);
    }

    function AdvisorDock(props) {
      const state = useEnhancer();
      const ownerDraft = props?.input?.draft;
      if (typeof ownerDraft === 'string') draftRef = ownerDraft;
      if (props?.inputActions !== undefined && props.inputActions !== null) inputActionsRef = props.inputActions;
      if (typeof props?.sessionId === 'string') sessionIdRef = props.sessionId;

      const {
        advPhase, advMode, situation, advStructured, advFallbackText, advError, advInfo,
        advModelLabel, advPicker, advPickerTitle, advReviewResult, advReviewBusy, advExported, advSelected, advResumed,
      } = state;

      React.useEffect(() => {
        if (advPhase === 'idle' || advPhase === 'busy') return undefined;
        const onKeyDown = (event) => {
          const swallow = () => {
            event.preventDefault();
            event.stopPropagation();
          };
          if (event.key === 'Escape') {
            swallow();
            if (advPhase === 'picker' && situation !== null) patch({ advPhase: 'ready', advPicker: [], advPickerTitle: null });
            else advReset();
            return;
          }
          if (advPhase === 'picker') {
            const slot = Number.parseInt(event.key, 10);
            if (Number.isInteger(slot) && slot >= 1 && slot <= advPicker.length) {
              swallow();
              void advChooseFromPicker(advPicker[slot - 1]);
            }
            return;
          }
          if (advPhase !== 'ready' || situation === null) return;
          const directions = situation.directions ?? [];
          const slot = Number.parseInt(event.key, 10);
          if (Number.isInteger(slot) && slot >= 1 && slot <= directions.length) {
            swallow();
            patch({ advSelected: directions[slot - 1].id, advExported: null });
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [advPhase, advPicker, situation]);

      if (advPhase === 'idle') return null;

      const head = React.createElement(
        'div',
        { className: 'dshadv_head' },
        React.createElement('strong', null, advPhase === 'picker' ? '🤖 选择模型' : '🧭 参谋方向'),
        advPhase === 'picker'
          ? null
          : React.createElement(
              'span',
              { className: 'dshadv_grow' },
              `${advModelLabel ?? ''}${advResumed ? ' · 已更新' : ''}${advStructured === false ? ' · 降级为纯文本' : ''}`,
            ),
        advPhase === 'ready' && advModelLabel !== null
          ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'dshadv_close',
                title: '换个模型重新分析',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => void advOpenPicker('换一个模型重新分析：', true),
              },
              '换模型',
            )
          : null,
        React.createElement('button', { type: 'button', className: 'dshadv_close', onMouseDown: (event) => event.preventDefault(), onClick: () => advReset() }, 'Esc 关闭'),
      );

      if (advPhase === 'busy') {
        return React.createElement(
          'div',
          { className: 'dshadv_dock', 'data-slot': 'advisor-engine' },
          head,
          React.createElement(
            'div',
            { className: 'dshadv_msg' },
            React.createElement('span', { className: 'dshadv_spin' }),
            ' 正在建立局势模型：提取意图 → 分离事实与推断 → 找关键矛盾 → 生成方向 → 形成建议…',
          ),
        );
      }

      if (advPhase === 'error') {
        return React.createElement(
          'div',
          { className: 'dshadv_dock', 'data-slot': 'advisor-engine' },
          head,
          React.createElement('div', { className: 'dshadv_msg', 'data-kind': 'error' }, advError ?? '分析失败'),
          React.createElement(
            'div',
            { className: 'dshadv_actions' },
            React.createElement('button', { type: 'button', className: 'dshadv_action', 'data-primary': 'true', onMouseDown: (event) => event.preventDefault(), onClick: () => void advAnalyze(false) }, '重试'),
            React.createElement('button', { type: 'button', className: 'dshadv_action', onMouseDown: (event) => event.preventDefault(), onClick: () => void advOpenPicker('换一个模型重新分析：', true) }, '换模型'),
          ),
        );
      }

      if (advPhase === 'picker') {
        return React.createElement(
          'div',
          { className: 'dshadv_dock', 'data-slot': 'advisor-engine' },
          head,
          React.createElement('div', { className: 'dshadv_msg' }, advPickerTitle ?? ''),
          React.createElement(
            'div',
            { className: 'dshadv_body' },
            ...advPicker.map((entry, position) =>
              React.createElement(
                'button',
                {
                  key: `${entry.provider}/${entry.model}`,
                  type: 'button',
                  className: 'dshadv_item',
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => void advChooseFromPicker(entry),
                },
                React.createElement('span', { className: 'dshadv_dir_key' }, String(position + 1)),
                React.createElement('span', { className: 'dshadv_label' }, entry.label),
                isFastModel(entry) ? null : React.createElement('span', { className: 'dshadv_tag' }, '⚠ 易空正文'),
              ),
            ),
          ),
        );
      }

      const tally = advCountByType(situation?.tree ?? null, {});
      const intent = situation?.intent ?? {};
      const recommended = situation?.recommendation?.direction_id;
      const body = [
        React.createElement(
          'div',
          { className: 'dshadv_sect', key: 'intent' },
          React.createElement('div', { className: 'dshadv_sect_head' }, `用户意图（置信${ADV_LEVEL_LABELS[intent.confidence] ?? '中'}）`),
          React.createElement('div', { className: 'dshadv_intent' }, intent.primary === '' ? '（模型未能提炼）' : intent.primary),
          (intent.secondary ?? []).length === 0
            ? null
            : React.createElement('div', { className: 'dshadv_pills' }, ...(intent.secondary ?? []).map((item, index) => React.createElement('span', { key: `sec-${index}`, className: 'dshadv_pill' }, item))),
        ),
        advStructured === false
          ? React.createElement('div', { className: 'dshadv_msg', key: 'degraded' }, `这次模型没给出结构化输出，下面是原文降级视图：\n${truncate(advFallbackText, 600)}`)
          : null,
        React.createElement(
          'div',
          { className: 'dshadv_sect', key: 'tensions' },
          React.createElement('div', { className: 'dshadv_sect_head' }, '关键矛盾'),
          (situation?.key_tensions ?? []).length === 0
            ? React.createElement('div', { className: 'dshadv_msg' }, '（未识别出关键矛盾）')
            : React.createElement('div', { className: 'dshadv_pills' }, ...situation.key_tensions.map((item, index) => React.createElement('span', { key: `ten-${index}`, className: 'dshadv_pill' }, item))),
        ),
        React.createElement(
          'div',
          { className: 'dshadv_sect', key: 'facts' },
          React.createElement('div', { className: 'dshadv_sect_head' }, '事实 / 推断 / 未知（必须区分）'),
          React.createElement(
            'div',
            { className: 'dshadv_pills' },
            ...(situation?.situation?.facts ?? []).map((item, index) => React.createElement('span', { key: `f-${index}`, className: 'dshadv_pill', 'data-kind': 'fact' }, `事实·${truncate(item, 18)}`)),
            ...(situation?.situation?.inferences ?? []).map((item, index) => React.createElement('span', { key: `i-${index}`, className: 'dshadv_pill', 'data-kind': 'inference' }, `推断·${truncate(item, 18)}`)),
            ...(situation?.situation?.assumptions ?? []).map((item, index) => React.createElement('span', { key: `a-${index}`, className: 'dshadv_pill', 'data-kind': 'inference' }, `假设·${truncate(item, 18)}`)),
            ...(situation?.situation?.unknowns ?? []).map((item, index) => React.createElement('span', { key: `u-${index}`, className: 'dshadv_pill', 'data-kind': 'unknown' }, `未知·${truncate(item, 18)}`)),
          ),
        ),
        (situation?.directions ?? []).length === 0
          ? null
          : React.createElement(
              'div',
              { className: 'dshadv_sect', key: 'dirs' },
              React.createElement('div', { className: 'dshadv_sect_head' }, `战略方向（${situation.directions.length}）`),
              React.createElement(
                'div',
                { className: 'dshadv_dirs' },
                ...situation.directions.map((direction, index) =>
                  React.createElement(
                    'div',
                    { key: direction.id },
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dshadv_dir',
                        'data-active': advSelected === direction.id ? 'true' : 'false',
                        'data-rec': recommended === direction.id ? 'true' : 'false',
                        onMouseDown: (event) => event.preventDefault(),
                        onClick: () => patch({ advSelected: advSelected === direction.id ? null : direction.id, advExported: null }),
                      },
                      React.createElement('span', { className: 'dshadv_dir_key' }, direction.id || String(index + 1)),
                      React.createElement(
                        'span',
                        { className: 'dshadv_label' },
                        React.createElement('span', { className: 'dshadv_dir_name' }, direction.name),
                        React.createElement(
                          'div',
                          { className: 'dshadv_dir_meta' },
                          `可逆性 ${ADV_LEVEL_LABELS[direction.reversibility] ?? '中'} · 信息增益 ${ADV_LEVEL_LABELS[direction.information_gain] ?? '中'}${direction.first_action === '' ? '' : ` · 第一步：${truncate(direction.first_action, 28)}`}`,
                        ),
                      ),
                    ),
                    advSelected === direction.id
                      ? React.createElement(
                          'div',
                          { className: 'dshadv_detail' },
                          direction.thesis === '' ? null : `策略：${direction.thesis}`,
                          direction.premises.length === 0 ? null : `\n前提：${direction.premises.join('；')}`,
                          direction.advantages.length === 0 ? null : `\n收益：${direction.advantages.join('；')}`,
                          direction.costs.length === 0 ? null : `\n代价：${direction.costs.join('；')}`,
                          direction.risks.length === 0 ? null : `\n风险：${direction.risks.join('；')}`,
                          direction.continue_signals.length === 0 ? null : `\n继续信号：${direction.continue_signals.join('；')}`,
                          direction.pivot_signals.length === 0 ? null : `\n转向信号：${direction.pivot_signals.join('；')}`,
                          direction.stop_conditions.length === 0 ? null : `\n停止条件：${direction.stop_conditions.join('；')}`,
                        )
                      : null,
                  ),
                ),
              ),
            ),
        (situation?.questions ?? []).length === 0
          ? null
          : React.createElement(
              'div',
              { className: 'dshadv_sect', key: 'questions' },
              React.createElement('div', { className: 'dshadv_sect_head' }, `待确认（${situation.questions.length}，每个都可能改变决策）`),
              ...situation.questions.map((item, index) =>
                React.createElement(
                  'div',
                  { key: `q-${index}`, className: 'dshadv_detail' },
                  `${index + 1}. ${item.question}${item.why_it_matters === '' ? '' : `\n   为什么重要：${item.why_it_matters}`}${item.could_change_direction ? '\n   会影响方向选择' : ''}`,
                ),
              ),
            ),
        React.createElement(
          'div',
          { className: 'dshadv_sect', key: 'tree' },
          React.createElement(
            'div',
            { className: 'dshadv_sect_head' },
            `缩进树（${advCountNodes(situation?.tree)} 节点：${Object.entries(tally).map(([type, n]) => `${ADVISOR_TYPE_LABELS[type] ?? type}${n}`).join(' ')}）`,
          ),
          React.createElement('div', { className: 'dshadv_tree' }, advRenderNode(situation?.tree, 'n0', state)),
        ),
        recommended === 'undetermined'
          ? React.createElement('div', { className: 'dshadv_msg', key: 'undetermined' }, '暂不推荐：信息不足以负责任地拍板。先回答上面的待确认问题，再点「续研」会把新信息并进这棵树。')
          : React.createElement(
              'div',
              { className: 'dshadv_sect', key: 'rec' },
              React.createElement('div', { className: 'dshadv_sect_head' }, `当前推荐：${recommended}（置信${ADV_LEVEL_LABELS[situation?.recommendation?.confidence] ?? '中'}）`),
              ...(situation?.recommendation?.reasoning ?? []).map((item, index) => React.createElement('div', { key: `r-${index}`, className: 'dshadv_detail' }, `依据：${item}`)),
              ...(situation?.recommendation?.why_not_others ?? []).map((item, index) => React.createElement('div', { key: `w-${index}`, className: 'dshadv_detail' }, `不选其它：${item}`)),
            ),
        advExported === null
          ? null
          : React.createElement(
              'div',
              { className: 'dshadv_sect', key: 'exported' },
              React.createElement('div', { className: 'dshadv_sect_head' }, '导出的可执行提示词（点「采纳提示词」写进输入框）'),
              React.createElement('div', { className: 'dshadv_detail' }, advExported),
            ),
        advReviewResult === null
          ? null
          : React.createElement(
              'div',
              { className: 'dshadv_review', key: 'review' },
              React.createElement('div', null, advReviewResult.valid ? '✔ 审查未发现硬性错误' : '✘ 审查发现问题'),
              ...advReviewResult.errors.map((item, index) => React.createElement('div', { key: `re-${index}` }, `错误：${item}`)),
              ...advReviewResult.warnings.map((item, index) => React.createElement('div', { key: `rw-${index}` }, `提醒：${item}`)),
              ...advReviewResult.missing_questions.map((item, index) => React.createElement('div', { key: `rm-${index}` }, `建议补问：${item}`)),
              ...advReviewResult.recommended_corrections.map((item, index) => React.createElement('div', { key: `rc-${index}` }, `建议修正：${item}`)),
            ),
      ];

      return React.createElement(
        'div',
        { className: 'dshadv_dock', 'data-slot': 'advisor-engine' },
        head,
        React.createElement(
          'div',
          { className: 'dshadv_modes' },
          ...ADVISOR_MODES.map((item) =>
            React.createElement(
              'button',
              {
                key: item.id,
                type: 'button',
                className: 'dshadv_mode',
                'data-active': advMode === item.id ? 'true' : 'false',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => patch({ advMode: item.id }),
              },
              item.label,
            ),
          ),
        ),
        React.createElement('div', { className: 'dshadv_body' }, ...body),
        React.createElement(
          'div',
          { className: 'dshadv_actions' },
          React.createElement('button', { type: 'button', className: 'dshadv_action', onMouseDown: (event) => event.preventDefault(), onClick: () => void advAnalyze(false) }, '重新分析'),
          React.createElement('button', { type: 'button', className: 'dshadv_action', title: '把输入框里的新信息并进当前局势模型', onMouseDown: (event) => event.preventDefault(), onClick: () => void advAnalyze(true) }, '续研（带上当前局势）'),
          React.createElement('button', { type: 'button', className: 'dshadv_action', disabled: advReviewBusy, onMouseDown: (event) => event.preventDefault(), onClick: () => void advRunReview() }, advReviewBusy ? '复查中…' : '复查'),
          React.createElement('button', { type: 'button', className: 'dshadv_action', 'data-primary': 'true', disabled: advSelected === null, onMouseDown: (event) => event.preventDefault(), onClick: () => void advExportPrompt() }, '导出提示词'),
          React.createElement('button', { type: 'button', className: 'dshadv_action', onMouseDown: (event) => event.preventDefault(), onClick: () => advAdopt() }, advExported === null ? '采纳局势小结' : '采纳提示词'),
        ),
        advInfo === null || advInfo === '' ? null : React.createElement('div', { className: 'dshadv_msg' }, advInfo),
      );
    }


    /** 参谋样式（内容与 advisor-client.js 一致，单一来源）。 */
    const ADVISOR_CSS = `
.dshadv_button{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#8b8b8b);cursor:pointer;font-size:13px;line-height:1;transition:background-color .14s,color .14s}
.dshadv_button:hover:not(:disabled){background:var(--dsw-alias-bg-l2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#111)}
.dshadv_button:disabled{cursor:progress;opacity:.75}
.dshadv_button[data-active="true"]{color:var(--dsw-static-deepseek-500,#4d6bfe);background:var(--dsw-alias-bg-l2,rgba(127,127,127,.14))}
.dshadv_spin{display:inline-block;width:12px;height:12px;border:1.6px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dshadv_spin .8s linear infinite}
@keyframes dshadv_spin{to{transform:rotate(360deg)}}
.dshadv_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px));max-width:calc(var(--dsh-composer-card-max-width,960px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px) - var(--dsh-composer-dock-inset,4px));margin:0 auto 8px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:12px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-l1,#fff));overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary,#111)}
.dshadv_head{display:flex;align-items:center;gap:8px;padding:6px 12px;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:12px;line-height:20px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.dshadv_head strong{color:var(--dsw-alias-label-primary,#111);font-weight:500}
.dshadv_grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshadv_close{border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px;padding:0 2px}
.dshadv_modes{display:flex;flex-wrap:wrap;gap:4px;padding:6px 12px 0}
.dshadv_mode{border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary,#8b8b8b);border-radius:999px;padding:1px 9px;font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshadv_mode[data-active="true"]{border-color:var(--dsw-static-deepseek-500,#4d6bfe);background:var(--dsw-static-deepseek-500,#4d6bfe);color:#fff}
.dshadv_body{display:flex;flex-direction:column;gap:8px;padding:8px 12px 10px;max-height:52vh;overflow:auto}
.dshadv_sect{display:flex;flex-direction:column;gap:4px}
.dshadv_sect_head{color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:11.5px;letter-spacing:.02em}
.dshadv_intent{font-size:13px;line-height:20px}
.dshadv_pills{display:flex;flex-wrap:wrap;gap:4px}
.dshadv_pill{border-radius:6px;padding:0 6px;font-size:11.5px;line-height:18px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#8b8b8b)}
.dshadv_pill[data-kind="fact"]{color:#2f7d4f}
.dshadv_pill[data-kind="inference"]{color:#8a6d1f}
.dshadv_pill[data-kind="unknown"]{color:#a15a2f}
.dshadv_tree{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:11.5px;line-height:19px}
.dshadv_row{display:flex;align-items:flex-start;gap:5px;white-space:pre-wrap;word-break:break-word}
.dshadv_row[data-dead="true"]{opacity:.45;text-decoration:line-through}
.dshadv_caret{flex:none;width:12px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b8b8b);cursor:pointer;padding:0;font:inherit}
.dshadv_label{flex:1;min-width:0}
.dshadv_tag{flex:none;border-radius:4px;padding:0 4px;font-size:10.5px;line-height:15px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.14));color:var(--dsw-alias-label-tertiary,#8b8b8b)}
.dshadv_tag[data-type="fact"]{color:#2f7d4f}
.dshadv_tag[data-type="inference"]{color:#8a6d1f}
.dshadv_tag[data-type="assumption"]{color:#8a6d1f;border:1px dashed currentColor}
.dshadv_tag[data-type="risk"]{color:#b3453d}
.dshadv_tag[data-source="unconfirmed"]{color:#a15a2f}
.dshadv_dirs{display:flex;flex-direction:column;gap:4px}
.dshadv_dir{display:flex;align-items:flex-start;gap:6px;width:100%;text-align:left;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;border-radius:9px;padding:5px 8px;cursor:pointer;color:inherit;font:inherit}
.dshadv_dir:hover{border-color:var(--dsw-static-deepseek-500,#4d6bfe)}
.dshadv_dir[data-active="true"]{border-color:var(--dsw-static-deepseek-500,#4d6bfe);background:var(--dsw-alias-bg-l2,rgba(127,127,127,.08))}
.dshadv_dir[data-rec="true"] .dshadv_dir_name::after{content:" ★推荐";color:var(--dsw-static-deepseek-500,#4d6bfe);font-size:11px}
.dshadv_dir_key{flex:none;width:16px;height:16px;border-radius:4px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#8b8b8b);font-size:10.5px;line-height:16px;text-align:center}
.dshadv_dir_name{font-size:12.5px}
.dshadv_dir_meta{color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:11px}
.dshadv_detail{border-left:2px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));padding:2px 0 2px 8px;color:var(--dsw-alias-label-secondary,#8b8b8b);font-size:12px;line-height:19px}
.dshadv_msg{padding:0 12px 8px;color:var(--dsw-alias-label-secondary,#8b8b8b);font-size:12.5px;line-height:19px;white-space:pre-wrap;word-break:break-word}
.dshadv_msg[data-kind="error"]{color:var(--dsw-alias-state-error-primary,#d54941)}
.dshadv_review{border:.5px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:9px;padding:6px 8px;font-size:12px;line-height:19px}
.dshadv_actions{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 10px}
.dshadv_action{border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary,#8b8b8b);border-radius:8px;padding:3px 10px;font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshadv_action:hover:not(:disabled){border-color:var(--dsw-static-deepseek-500,#4d6bfe);color:var(--dsw-alias-label-primary,#111)}
.dshadv_action:disabled{opacity:.5;cursor:not-allowed}
.dshadv_action[data-primary="true"]{border-color:var(--dsw-static-deepseek-500,#4d6bfe);color:var(--dsw-static-deepseek-500,#4d6bfe)}
.dshadv_item{display:flex;gap:6px;align-items:flex-start;width:100%;text-align:left;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:transparent;border-radius:9px;padding:5px 8px;cursor:pointer;color:inherit;font:inherit}
.dshadv_item:hover{border-color:var(--dsw-static-deepseek-500,#4d6bfe)}
`;

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

      // v0.3：参谋按钮与参谋 dock 与改写流程并列注册（排在改写之后）
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register({ name: 'conversation.input.right', id: 'advisor-engine', order: 18 }, AdvisorButton),
      );
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'advisor-engine', order: 390 }, AdvisorDock),
      );
      ctx.effect(() => {
        const onAdvisorKey = (event) => {
          if (event.ctrlKey && event.shiftKey && event.key === 'J') {
            event.preventDefault();
            event.stopPropagation();
            const state = getSnapshot();
            if (state.advPhase === 'idle') {
              void advAnalyze(false);
              return;
            }
            // busy 态不打断在飞的请求；picker 态退回上一层而不是直接关闭
            if (state.advPhase === 'busy') return;
            if (state.advPhase === 'picker' && state.situation !== null) {
              patch({ advPhase: 'ready', advPicker: [], advPickerTitle: null });
              return;
            }
            advReset();
          }
        };
        window.addEventListener('keydown', onAdvisorKey, true);
        return () => window.removeEventListener('keydown', onAdvisorKey, true);
      }, 'advisor-engine: shortcut');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'prompt-enhancer';
    return module.exports;
  },
});
