/**
 * 参谋方向引擎 —— 客户端（Web UI）侧。
 *
 * 视图原则：**缩进树是局势模型的一个视图，不是产物本身**。
 * 所以这里渲染的不是一段文本，而是 intent / situation / directions / questions
 * 这些结构化字段，树只是它们的分层呈现；每个节点带类型、来源、置信度、状态徽标。
 *
 * 路由：
 *   POST /prompt-enhancer/advisor   生成或更新局势模型（resume=true 时带上一份）
 *   POST /prompt-enhancer/review    手动复查（审查器提示词）
 *   POST /prompt-enhancer/enhance   把选定方向导出成可执行提示词（复用 v0.2 能力）
 *
 * @module @linxin666/dsh-prompt-enhancer/advisor-client
 */
window.__ModuleLoader__.load({
  id: '@linxin666/dsh-prompt-enhancer/advisor',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    const ADVISOR_ROUTE = '/prompt-enhancer/advisor';
    const REVIEW_ROUTE = '/prompt-enhancer/review';
    const ENHANCE_ROUTE = '/prompt-enhancer/enhance';
    const PICKER_LIMIT = 9;
    const CSS_TAG_ID = '@linxin666/dsh-prompt-enhancer/advisor.css';

    /** 参谋模式（auto 交给 Host 按草稿推断）。 */
    const MODES = [
      { id: 'auto', label: '自动' },
      { id: 'reconnaissance', label: '侦察' },
      { id: 'planning', label: '谋划' },
      { id: 'decision', label: '决策' },
      { id: 'execution', label: '执行' },
      { id: 'review', label: '复盘' },
    ];

    /** 节点类型 → 中文名与配色键。 */
    const TYPE_LABELS = {
      root: '想法',
      goal: '目标',
      fact: '事实',
      inference: '推断',
      assumption: '假设',
      constraint: '约束',
      direction: '方案',
      risk: '风险',
      signal: '信号',
      action: '行动',
      question: '疑问',
    };
    /** 来源 → 中文名。事实/推断的区分主要靠它，所以必须显示。 */
    const SOURCE_LABELS = { user: '用户', evidence: '已验证', model: '模型推断', unconfirmed: '待确认' };
    const LEVEL_LABELS = { high: '高', medium: '中', low: '低' };
    const STATUS_LABELS = { open: '开放', verified: '已验证', rejected: '已否决', superseded: '已过时' };
    /** 已失效状态要视觉降级，避免用户把作废判断当现行结论。 */
    const DEAD_STATUSES = ['rejected', 'superseded'];

    const INITIAL = {
      phase: 'idle', // idle | busy | ready | picker | error
      mode: 'auto',
      situation: null,
      structured: true,
      fallbackText: '',
      error: null,
      info: null,
      modelLabel: null,
      picker: [],
      pickerTitle: null,
      /** 选中的方向 id。 */
      selected: null,
      /** 折叠的节点路径集合。 */
      collapsed: {},
      review: null,
      reviewBusy: false,
      /** 导出后的提示词（供采纳）。 */
      exported: null,
      resumed: false,
    };

    let snapshot = { ...INITIAL };
    const listeners = new Set();
    const getSnapshot = () => snapshot;
    const subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const emit = () => {
      for (const listener of [...listeners]) listener();
    };
    const patch = (next) => {
      snapshot = { ...snapshot, ...next };
      emit();
    };
    const reset = () => patch({ ...INITIAL });
    const useAdvisor = () => React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    let clientCtx = null;
    let draftRef = '';
    let sessionIdRef = undefined;
    let inputActionsRef = null;
    let catalogPromise = null;
    let preferredModel = null;
    let pendingDraftRef = null;

    const readDraft = () => (typeof draftRef === 'string' ? draftRef : '');

    /* ---------------- 模型目录 ---------------- */

    async function loadCatalog() {
      if (catalogPromise === null) {
        catalogPromise = (async () => {
          const response = await clientCtx.remote.session.modelCatalog();
          if (response === undefined || response.ok !== true) throw new Error(response?.error?.message ?? '无法读取本地模型目录');
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
        for (const item of group?.models ?? []) {
          const id = typeof item?.id === 'string' ? item.id : '';
          if (id === '') continue;
          const name = typeof item?.name === 'string' && item.name !== '' ? item.name : id;
          models.push({ provider: group.id, model: id, label: `${name} · ${group.name ?? group.id}` });
        }
      }
      return models;
    }

    /** 参谋分析要跑 JSON + 长文，优先不带思考块的模型（实测有思考块的常空正文）。 */
    const isFastModel = (entry) => !/glm-5\.3|qwen3\.8|kimi/i.test(entry.model);

    async function resolveModel() {
      if (preferredModel !== null) return preferredModel;
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

    /* ---------------- 统计与助手 ---------------- */

    const countNodes = (node) => (node === null || typeof node !== 'object'
      ? 0
      : 1 + (Array.isArray(node.children) ? node.children.reduce((sum, child) => sum + countNodes(child), 0) : 0));

    const countByType = (node, tally = {}) => {
      if (node === null || typeof node !== 'object') return tally;
      tally[node.type] = (tally[node.type] ?? 0) + 1;
      for (const child of Array.isArray(node.children) ? node.children : []) countByType(child, tally);
      return tally;
    };

    const truncate = (text, max) => {
      const oneLine = String(text ?? '').replace(/\s+/gu, ' ').trim();
      return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
    };

    /* ---------------- 请求 ---------------- */

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
        payload = null;
      }
      if (!response.ok) {
        const error = new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`);
        if (typeof payload?.code === 'string') error.code = payload.code;
        if (payload?.detail !== null && typeof payload.detail === 'object') error.detail = payload.detail;
        throw error;
      }
      return payload;
    }

    async function openPicker(title, keepSituation = false) {
      const catalog = await loadCatalog();
      const models = flattenCatalog(catalog).slice(0, PICKER_LIMIT);
      patch({
        phase: 'picker',
        picker: models,
        pickerTitle: title,
        ...(keepSituation ? {} : { situation: null }),
      });
    }

    /**
     * 生成或更新局势模型。
     * @param resume - true 时带上本会话上一份模型，让 Host 走"更新"而不是"重生成"。
     */
    async function analyze(resume = false, draftOverride) {
      if (snapshot.phase === 'busy') return;
      const text = (typeof draftOverride === 'string' ? draftOverride : readDraft()).trim();
      if (text === '') {
        patch({ phase: 'error', error: '输入框是空的，先写一句你的想法。' });
        return;
      }
      patch({ phase: 'busy', error: null, info: null, review: null, exported: null });
      try {
        const chosen = await resolveModel();
        if (chosen === null) {
          await openPicker('本地没有可用模型，按数字键选一个：');
          return;
        }
        const body = {
          text,
          provider: chosen.provider,
          model: chosen.model,
          mode: snapshot.mode === 'auto' ? undefined : snapshot.mode,
          resume,
        };
        if (typeof sessionIdRef === 'string' && sessionIdRef !== '') body.sessionId = sessionIdRef;
        const payload = await requestJson(ADVISOR_ROUTE, body);
        patch({
          phase: 'ready',
          situation: payload.situation,
          structured: payload.structured !== false,
          fallbackText: payload.fallbackText ?? '',
          modelLabel: chosen.label,
          selected: payload.situation?.recommendation?.direction_id === 'undetermined'
            ? null
            : payload.situation?.recommendation?.direction_id ?? null,
          resumed: payload.resumed === true,
          collapsed: {},
          info: payload.resumed === true ? '已更新局势模型（保留仍有效的判断）' : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        patch({ phase: 'error', error: message });
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

    async function chooseFromPicker(entry) {
      preferredModel = entry;
      const draft = pendingDraftRef ?? readDraft().trim();
      pendingDraftRef = null;
      patch({ phase: 'idle', picker: [], pickerTitle: null });
      await analyze(false, draft);
    }

    /** 手动复查（审查器提示词），只标注问题，不阻断。 */
    async function review() {
      const situation = snapshot.situation;
      if (situation === null || snapshot.reviewBusy) return;
      const chosen = preferredModel ?? (await resolveModel());
      if (chosen === null) {
        patch({ phase: 'error', error: '还没有可用模型，无法复查。' });
        return;
      }
      patch({ reviewBusy: true, error: null });
      try {
        const body = { provider: chosen.provider, model: chosen.model, state: situation };
        if (typeof sessionIdRef === 'string' && sessionIdRef !== '') body.sessionId = sessionIdRef;
        const payload = await requestJson(REVIEW_ROUTE, body);
        patch({ review: payload.review, reviewBusy: false });
      } catch (error) {
        patch({ reviewBusy: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    /**
     * 把选定方向导出成可执行提示词：走既有 /enhance，草稿里带上方向要点。
     */
    async function exportPrompt() {
      const situation = snapshot.situation;
      const direction = (situation?.directions ?? []).find((item) => item.id === snapshot.selected);
      if (direction === undefined) return;
      const chosen = preferredModel;
      if (chosen === null) {
        patch({ phase: 'error', error: '还没有可用模型，无法导出。' });
        return;
      }
      const draft = [
        `按「${direction.name}」这个方向，给我一份可直接执行的提示词。`,
        direction.thesis === '' ? '' : `策略：${direction.thesis}`,
        direction.premises.length === 0 ? '' : `前提：${direction.premises.join('；')}`,
        direction.first_action === '' ? '' : `第一步：${direction.first_action}`,
        direction.risks.length === 0 ? '' : `需要防范：${direction.risks.join('；')}`,
        situation?.intent?.primary ? `目标：${situation.intent.primary}` : '',
      ].filter((line) => line !== '').join('\n');
      patch({ phase: 'busy', error: null });
      try {
        const payload = await requestJson(ENHANCE_ROUTE, {
          text: draft,
          provider: chosen.provider,
          model: chosen.model,
          count: 1,
          ...(typeof sessionIdRef === 'string' && sessionIdRef !== '' ? { sessionId: sessionIdRef } : {}),
        });
        const first = payload?.candidates?.[0]?.text ?? '';
        patch({ phase: 'ready', exported: first, info: '已生成可执行提示词，点「采纳」写进输入框' });
      } catch (error) {
        patch({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }

    /** 采纳：优先采纳导出的提示词，否则采纳局势小结。 */
    function adopt() {
      const actions = inputActionsRef;
      if (actions === null || typeof actions.setDraft !== 'function') {
        patch({ phase: 'error', error: '当前输入框不支持写入草稿。' });
        return;
      }
      const situation = snapshot.situation;
      if (snapshot.exported !== null) {
        actions.setDraft(snapshot.exported);
        reset();
        return;
      }
      const direction = (situation?.directions ?? []).find((item) => item.id === snapshot.selected);
      const lines = [
        situation?.intent?.primary ? `目标：${situation.intent.primary}` : '',
        direction ? `方向：${direction.name}——${direction.thesis}` : '',
        direction?.first_action ? `第一步：${direction.first_action}` : '',
        (situation?.questions ?? []).length > 0
          ? `需要先确认：${situation.questions.map((item) => item.question).join('；')}`
          : '',
      ].filter((line) => line !== '');
      actions.setDraft(lines.join('\n'));
      reset();
    }

    /* ---------------- 样式 ---------------- */

    const CSS = `
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

    function injectCss() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = '@linxin666/dsh-prompt-enhancer/advisor';
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ---------------- 按钮 ---------------- */

    function AdvisorButton(props) {
      const state = useAdvisor();
      const useInput = props?.useInput;
      const draft = typeof useInput === 'function' ? useInput((value) => value.draft) : undefined;
      if (typeof draft === 'string') draftRef = draft;
      if (props?.inputActions !== undefined && props.inputActions !== null) inputActionsRef = props.inputActions;
      if (typeof props?.sessionId === 'string') sessionIdRef = props.sessionId;

      const busy = state.phase === 'busy';
      const toggleable = state.phase === 'ready' || state.phase === 'picker';
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dshadv_button',
          'data-active': state.phase !== 'idle' ? 'true' : 'false',
          title: busy ? '正在分析…' : '参谋方向引擎：把想法变成可审查的局势与方向（Ctrl+Shift+J）',
          'aria-label': '参谋方向引擎',
          disabled: busy,
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => {
            if (busy) return;
            if (toggleable) reset();
            else void analyze(false);
          },
        },
        busy ? React.createElement('span', { className: 'dshadv_spin' }) : '🧭',
        React.createElement('span', null, '参谋'),
      );
    }

    /* ---------------- 树视图 ---------------- */

    /** 递归渲染一个节点：类型/来源/置信度/状态徽标 + 可折叠子节点。 */
    function renderNode(node, path, state) {
      if (node === null || typeof node !== 'object') return null;
      const children = Array.isArray(node.children) ? node.children : [];
      const collapsed = state.collapsed[path] === true;
      const dead = DEAD_STATUSES.includes(node.status);
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
                  onClick: () => patch({ collapsed: { ...snapshot.collapsed, [path]: !collapsed } }),
                },
                collapsed ? '▸' : '▾',
              ),
          React.createElement('span', { className: 'dshadv_label' }, node.label),
          React.createElement('span', { className: 'dshadv_tag', 'data-type': node.type }, TYPE_LABELS[node.type] ?? node.type),
          React.createElement('span', { className: 'dshadv_tag', 'data-source': node.source }, SOURCE_LABELS[node.source] ?? node.source),
          node.confidence === 'low'
            ? React.createElement('span', { className: 'dshadv_tag' }, `置信${LEVEL_LABELS[node.confidence]}`)
            : null,
          node.status === 'open'
            ? null
            : React.createElement('span', { className: 'dshadv_tag' }, STATUS_LABELS[node.status] ?? node.status),
        ),
      ];
      if (!collapsed) {
        children.forEach((child, index) => {
          rows.push(renderNode(child, `${path}.${index}`, state));
        });
      }
      return React.createElement('div', { key: path }, ...rows);
    }

    function DirectionList(state) {
      const situation = state.situation;
      const recommended = situation?.recommendation?.direction_id;
      return React.createElement(
        'div',
        { className: 'dshadv_sect' },
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
                  'data-active': state.selected === direction.id ? 'true' : 'false',
                  'data-rec': recommended === direction.id ? 'true' : 'false',
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => patch({ selected: state.selected === direction.id ? null : direction.id, exported: null }),
                },
                React.createElement('span', { className: 'dshadv_dir_key' }, direction.id || String(index + 1)),
                React.createElement(
                  'span',
                  { className: 'dshadv_label' },
                  React.createElement('span', { className: 'dshadv_dir_name' }, direction.name),
                  React.createElement('div', { className: 'dshadv_dir_meta' }, `可逆性 ${LEVEL_LABELS[direction.reversibility]} · 信息增益 ${LEVEL_LABELS[direction.information_gain]}${direction.first_action === '' ? '' : ` · 第一步：${truncate(direction.first_action, 28)}`}`),
                ),
              ),
              state.selected === direction.id
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
      );
    }

    function AdvisorDock(props) {
      const state = useAdvisor();
      const ownerDraft = props?.input?.draft;
      if (typeof ownerDraft === 'string') draftRef = ownerDraft;
      if (props?.inputActions !== undefined && props.inputActions !== null) inputActionsRef = props.inputActions;
      if (typeof props?.sessionId === 'string') sessionIdRef = props.sessionId;

      const { phase, mode, situation, structured, fallbackText, error, info, modelLabel, picker, pickerTitle, review, reviewBusy, exported, selected, resumed } = state;

      React.useEffect(() => {
        if (phase === 'idle' || phase === 'busy') return undefined;
        const onKeyDown = (event) => {
          const swallow = () => {
            event.preventDefault();
            event.stopPropagation();
          };
          if (event.key === 'Escape') {
            swallow();
            if (phase === 'picker' && situation !== null) patch({ phase: 'ready', picker: [], pickerTitle: null });
            else reset();
            return;
          }
          if (phase === 'picker') {
            const slot = Number.parseInt(event.key, 10);
            if (Number.isInteger(slot) && slot >= 1 && slot <= picker.length) {
              swallow();
              void chooseFromPicker(picker[slot - 1]);
            }
            return;
          }
          if (phase !== 'ready' || situation === null) return;
          const directions = situation.directions ?? [];
          const slot = Number.parseInt(event.key, 10);
          if (Number.isInteger(slot) && slot >= 1 && slot <= directions.length) {
            swallow();
            const direction = directions[slot - 1];
            patch({ selected: direction.id, exported: null });
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [phase, picker, situation]);

      if (phase === 'idle') return null;

      const head = React.createElement(
        'div',
        { className: 'dshadv_head' },
        React.createElement('strong', null, phase === 'picker' ? '🤖 选择模型' : '🧭 参谋方向'),
        phase === 'picker'
          ? null
          : React.createElement(
              'span',
              { className: 'dshadv_grow' },
              `${modelLabel ?? ''}${resumed ? ' · 已更新' : ''}${structured === false ? ' · 降级为纯文本' : ''}`,
            ),
        phase === 'ready' && modelLabel !== null
          ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'dshadv_close',
                title: '换个模型重新分析',
                onClick: () => void openPicker('换一个模型重新分析：', true),
              },
              '换模型',
            )
          : null,
        React.createElement('button', { type: 'button', className: 'dshadv_close', onClick: () => reset() }, 'Esc 关闭'),
      );

      if (phase === 'busy') {
        return React.createElement(
          'div',
          { className: 'dshadv_dock' },
          head,
          React.createElement(
            'div',
            { className: 'dshadv_msg' },
            React.createElement('span', { className: 'dshadv_spin' }),
            ' 正在建立局势模型：提取意图 → 分离事实与推断 → 找关键矛盾 → 生成方向 → 形成建议…',
          ),
        );
      }

      if (phase === 'error') {
        return React.createElement(
          'div',
          { className: 'dshadv_dock' },
          head,
          React.createElement('div', { className: 'dshadv_msg', 'data-kind': 'error' }, error ?? '分析失败'),
          React.createElement(
            'div',
            { className: 'dshadv_actions' },
            React.createElement('button', { type: 'button', className: 'dshadv_action', 'data-primary': 'true', onClick: () => void analyze(false) }, '重试'),
            React.createElement('button', { type: 'button', className: 'dshadv_action', onClick: () => void openPicker('换一个模型重新分析：', true) }, '换模型'),
          ),
        );
      }

      if (phase === 'picker') {
        return React.createElement(
          'div',
          { className: 'dshadv_dock' },
          head,
          React.createElement('div', { className: 'dshadv_msg' }, pickerTitle ?? ''),
          React.createElement(
            'div',
            { className: 'dshadv_body' },
            ...picker.map((entry, position) =>
              React.createElement(
                'button',
                {
                  key: `${entry.provider}/${entry.model}`,
                  type: 'button',
                  className: 'dshadv_item',
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => void chooseFromPicker(entry),
                },
                React.createElement('span', { className: 'dshadv_dir_key' }, String(position + 1)),
                React.createElement('span', { className: 'dshadv_label' }, entry.label),
                isFastModel(entry) ? null : React.createElement('span', { className: 'dshadv_tag' }, '⚠ 易空正文'),
              ),
            ),
          ),
        );
      }

      // ready 态
      const tally = countByType(situation?.tree ?? null, {});
      const intent = situation?.intent ?? {};
      const body = [
        React.createElement(
          'div',
          { className: 'dshadv_sect', key: 'intent' },
          React.createElement('div', { className: 'dshadv_sect_head' }, `用户意图（置信${LEVEL_LABELS[intent.confidence] ?? '中'}）`),
          React.createElement('div', { className: 'dshadv_intent' }, intent.primary === '' ? '（模型未能提炼）' : intent.primary),
          (intent.secondary ?? []).length === 0
            ? null
            : React.createElement('div', { className: 'dshadv_pills' }, ...(intent.secondary ?? []).map((item, index) => React.createElement('span', { key: `sec-${index}`, className: 'dshadv_pill' }, item))),
        ),
        structured === false
          ? React.createElement('div', { className: 'dshadv_msg', key: 'degraded' }, `这次模型没给出结构化输出，下面是原文降级视图：\n${truncate(fallbackText, 600)}`)
          : null,
        React.createElement(
          'div',
          { className: 'dshadv_sect', key: 'tensions' },
          React.createElement('div', { className: 'dshadv_sect_head' }, '关键矛盾'),
          situation.key_tensions.length === 0
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
            ...situation.situation.facts.map((item, index) => React.createElement('span', { key: `f-${index}`, className: 'dshadv_pill', 'data-kind': 'fact' }, `事实·${truncate(item, 18)}`)),
            ...situation.situation.inferences.map((item, index) => React.createElement('span', { key: `i-${index}`, className: 'dshadv_pill', 'data-kind': 'inference' }, `推断·${truncate(item, 18)}`)),
            ...situation.situation.assumptions.map((item, index) => React.createElement('span', { key: `a-${index}`, className: 'dshadv_pill', 'data-kind': 'inference' }, `假设·${truncate(item, 18)}`)),
            ...situation.situation.unknowns.map((item, index) => React.createElement('span', { key: `u-${index}`, className: 'dshadv_pill', 'data-kind': 'unknown' }, `未知·${truncate(item, 18)}`)),
          ),
        ),
        situation.directions.length === 0 ? null : DirectionList(state),
        situation.questions.length === 0
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
          React.createElement('div', { className: 'dshadv_sect_head' }, `缩进树（${countNodes(situation.tree)} 节点：${Object.entries(tally).map(([type, n]) => `${TYPE_LABELS[type] ?? type}${n}`).join(' ')}）`),
          React.createElement('div', { className: 'dshadv_tree' }, renderNode(situation.tree, 'n0', state)),
        ),
        situation.recommendation.direction_id === 'undetermined'
          ? React.createElement('div', { className: 'dshadv_msg', key: 'undetermined' }, '暂不推荐：信息不足以负责任地拍板。先回答上面的待确认问题，再点「续研」会把新信息并进这棵树。')
          : React.createElement(
              'div',
              { className: 'dshadv_sect', key: 'rec' },
              React.createElement('div', { className: 'dshadv_sect_head' }, `当前推荐：${situation.recommendation.direction_id}（置信${LEVEL_LABELS[situation.recommendation.confidence] ?? '中'}）`),
              ...situation.recommendation.reasoning.map((item, index) => React.createElement('div', { key: `r-${index}`, className: 'dshadv_detail' }, `依据：${item}`)),
              ...situation.recommendation.why_not_others.map((item, index) => React.createElement('div', { key: `w-${index}`, className: 'dshadv_detail' }, `不选其它：${item}`)),
            ),
        exported === null
          ? null
          : React.createElement(
              'div',
              { className: 'dshadv_sect', key: 'exported' },
              React.createElement('div', { className: 'dshadv_sect_head' }, '导出的可执行提示词（点「采纳」写进输入框）'),
              React.createElement('div', { className: 'dshadv_detail' }, exported),
            ),
        review === null
          ? null
          : React.createElement(
              'div',
              { className: 'dshadv_review', key: 'review' },
              React.createElement('div', null, review.valid ? '✔ 审查未发现硬性错误' : '✘ 审查发现问题'),
              ...review.errors.map((item, index) => React.createElement('div', { key: `re-${index}` }, `错误：${item}`)),
              ...review.warnings.map((item, index) => React.createElement('div', { key: `rw-${index}` }, `提醒：${item}`)),
              ...review.missing_questions.map((item, index) => React.createElement('div', { key: `rm-${index}` }, `建议补问：${item}`)),
              ...review.recommended_corrections.map((item, index) => React.createElement('div', { key: `rc-${index}` }, `建议修正：${item}`)),
            ),
      ];

      return React.createElement(
        'div',
        { className: 'dshadv_dock' },
        head,
        React.createElement(
          'div',
          { className: 'dshadv_modes' },
          ...MODES.map((item) =>
            React.createElement(
              'button',
              {
                key: item.id,
                type: 'button',
                className: 'dshadv_mode',
                'data-active': mode === item.id ? 'true' : 'false',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => patch({ mode: item.id }),
              },
              item.label,
            ),
          ),
        ),
        React.createElement('div', { className: 'dshadv_body' }, ...body),
        React.createElement(
          'div',
          { className: 'dshadv_actions' },
          React.createElement('button', { type: 'button', className: 'dshadv_action', disabled: phase === 'busy', onClick: () => void analyze(false) }, '重新分析'),
          React.createElement('button', { type: 'button', className: 'dshadv_action', title: '把输入框里的新信息并进当前局势模型', onClick: () => void analyze(true) }, '续研（带上当前局势）'),
          React.createElement('button', { type: 'button', className: 'dshadv_action', disabled: reviewBusy, onClick: () => void review() }, reviewBusy ? '复查中…' : '复查'),
          React.createElement('button', { type: 'button', className: 'dshadv_action', 'data-primary': 'true', disabled: selected === null, onClick: () => void exportPrompt() }, '导出提示词'),
          React.createElement('button', { type: 'button', className: 'dshadv_action', onClick: () => adopt() }, snapshot.exported === null ? '采纳局势小结' : '采纳提示词'),
        ),
        info === null || info === '' ? null : React.createElement('div', { className: 'dshadv_msg' }, info),
      );
    }

    /* ---------------- 插件入口 ---------------- */

    const inject = ['slots', 'remote', 'remote.session'];

    function apply(ctx) {
      clientCtx = ctx;
      injectCss();
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register({ name: 'conversation.input.right', id: 'advisor-engine', order: 18 }, AdvisorButton),
      );
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'advisor-engine', order: 390 }, AdvisorDock),
      );
      ctx.effect(() => {
        const onKeyDown = (event) => {
          if (event.ctrlKey && event.shiftKey && event.key === 'J') {
            event.preventDefault();
            event.stopPropagation();
            if (snapshot.phase === 'idle') void analyze(false);
            else reset();
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, 'advisor-engine: shortcut');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'advisor-engine';
    return module.exports;
  },
});
