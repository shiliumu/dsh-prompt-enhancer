/**
 * 参谋方向引擎 —— Host 侧核心。
 *
 * 设计原则（v0.3 的分水岭）：
 *   模型输出的是**结构化局势模型**；缩进树只是它的一个视图（`tree` 字段），
 *   而不是产物本身。因此这里做三件事：
 *     1. 把用户一句话包成固定输入结构（意图/背景/约束/已有参谋状态/模式/已验证信息）；
 *     2. 用主系统提示词换回一份可审查、可比较、可迭代的 JSON 局势模型；
 *     3. 宽松解析 + 逐字段校验裁剪 + 会话态快照，使下一次输入是"更新"而非"重生成"。
 *
 * @module @linxin666/dsh-prompt-enhancer/advisor
 */

/* ------------------------------------------------------------------ *
 * 常量与取值域
 * ------------------------------------------------------------------ */

/** 输出额度：不硬编小值（思考与正文共用一份预算，小值必然截断）。 */
export const ADVISOR_MAX_TOKENS = 12000;
/** 参谋分析比改写更慢，给足时间。 */
export const ADVISOR_TIMEOUT_MS = 240_000;

/** 节点类型（缩进树里每个节点必须属于其中一种）。 */
export const NODE_TYPES = ['goal', 'fact', 'inference', 'assumption', 'constraint', 'direction', 'risk', 'signal', 'action', 'question'];
/** 节点来源。 */
export const NODE_SOURCES = ['user', 'evidence', 'model', 'unconfirmed'];
/** 三档刻度，置信度与影响共用。 */
export const LEVELS = ['high', 'medium', 'low'];
/** 节点状态：开放 / 已验证 / 已否决 / 已过时。 */
export const NODE_STATUSES = ['open', 'verified', 'rejected', 'superseded'];
/** 参谋模式。 */
export const MODES = ['reconnaissance', 'planning', 'decision', 'execution', 'review'];

/** 上限：结构再漂亮，超过这些就不再增加决策价值。 */
const MAX_DIRECTIONS = 4;
const MAX_QUESTIONS = 3;
const MAX_LIST = 8;
const MAX_TEXT = 600;
const MAX_CHILDREN = 24;
const MAX_DEPTH = 7;
const MAX_NODES = 160;
const MAX_STATES = 24;

/** 会话态快照存活上限（内存态：进程重启即失效，下一版再接持久化）。 */
const STATE_TTL_MS = 6 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * 主系统提示词
 * ------------------------------------------------------------------ */

/** 主系统提示词：定位、基本原则、八步流程与 JSON 契约。 */
export const ADVISOR_SYSTEM_PROMPT = [
  '你是"参谋方向引擎"。',
  '',
  '你的职责不是直接回答用户，而是把用户的一句话想法，转换为一份可审查、可比较、可迭代的局势与决策结构。',
  '',
  '你需要帮助用户看清：',
  '1. 用户真正想达成的目标',
  '2. 当前已知事实与局势',
  '3. 哪些内容只是推断或假设',
  '4. 当前最关键的矛盾和决策变量',
  '5. 可以选择的不同方向',
  '6. 每个方向的收益、代价、风险和前提',
  '7. 当前最值得采取的第一步',
  '8. 哪些信号出现后应继续、转向或停止',
  '',
  '你不是替用户强行拍板，而是提高用户的判断质量。',
  '除非输入信息足够，否则不要制造确定性的结论。',
  '不要把推断、假设或模型生成内容伪装成事实。',
  '不要为了显得全面而生成大量没有决策价值的分支。',
  '',
  '【基本原则】',
  '1. 用户意图优先，不得擅自改变问题目标。',
  '2. 事实、推断、假设、建议必须明确区分。',
  '3. 只保留会影响判断或行动的分支。',
  '4. 方向之间必须存在真实的战略差异，不能只是措辞不同。',
  '5. 优先提出可逆、低成本、能获得更多信息的第一步。',
  '6. 对不可逆动作、重大损失和高风险路径单独标记。',
  '7. 推荐必须能追溯到前提、证据和比较结果。',
  '8. 关键未知信息如果会改变推荐，必须列入待确认问题。',
  '9. 待确认问题最多三个，并且每个问题都必须可能改变决策。',
  '10. 如果信息不足以推荐，应明确输出"暂不推荐"，而不是假装确定。',
  '11. 不执行外部操作，只负责分析、比较、建议和形成行动结构。',
  '',
  '【处理流程】心里走完这八步，只输出最后的结构：',
  '第一步：提取用户意图。判断是探索、规划、选择、执行、排错还是复盘；存在多个意图时区分主要与次要。',
  '第二步：建立局势。提取已知事实、参与者、资源、时间范围、约束、风险和未知信息。',
  '第三步：识别关键矛盾。找出真正决定结果的冲突，例如速度与可靠性、收益与风险、短期与长期、控制力与成本。',
  '第四步：生成方向。生成二至四个有实际差异的战略方向；每个方向必须说明适用前提，不得只罗列优缺点。',
  '第五步：比较方向。至少从目标匹配度、收益、成本、风险、资源需求、可逆性、信息增益和时间因素比较。',
  '第六步：形成建议。信息足够时给出当前推荐；信息不足时给出最值得先验证的事项或最小可行行动。',
  '第七步：定义转向条件。说明什么信号表示应继续、应转向、应停止。',
  '第八步：输出参谋树。把全部内容组织为可展开的层级结构，并为每个节点标记类型、来源、置信度和状态。',
  '',
  '【增量更新】输入里可能带上"已有参谋状态"。此时你的任务是**更新**而不是重生成：',
  '- 仍然有效的判断原样保留（保持节点 label 不变，便于前端对位）。',
  '- 被新信息否定、已过时或被更好判断取代的节点，把 status 标为 rejected / superseded，不要直接删掉。',
  '- 新增的节点正常加入；如果某个原本的"未知"已被回答，把它变成 fact 并标记 verified。',
  '',
  '【输出格式】只输出一个 JSON 对象，不要代码块围栏、不要解释、不要多余文字。字段如下：',
  '{',
  '  "intent": { "primary": "", "secondary": [], "success_criteria": [], "confidence": "high|medium|low" },',
  '  "situation": { "facts": [], "inferences": [], "assumptions": [], "constraints": [], "unknowns": [], "actors": [], "time_horizon": "" },',
  '  "key_tensions": [],',
  '  "decision_variables": [],',
  '  "directions": [{',
  '    "id": "A", "name": "", "thesis": "", "premises": [], "advantages": [], "costs": [], "risks": [],',
  '    "resource_demand": "", "reversibility": "high|medium|low", "information_gain": "high|medium|low",',
  '    "first_action": "", "continue_signals": [], "pivot_signals": [], "stop_conditions": []',
  '  }],',
  '  "recommendation": { "direction_id": "A|undetermined", "reasoning": [], "confidence": "high|medium|low", "why_not_others": [] },',
  '  "questions": [{ "question": "", "why_it_matters": "", "could_change_direction": true }],',
  '  "tree": {',
  '    "type": "root", "label": "用户原始想法", "source": "user", "confidence": "high|medium|low",',
  '    "status": "open|verified|rejected|superseded", "children": []',
  '  }',
  '}',
  '',
  '【树节点规则】tree 是上面的结构在界面上的视图，必须与其它字段一致，不得出现正文里没有的判断。',
  '每个节点形如 { "type": "…", "label": "…", "source": "…", "confidence": "high|medium|low", "impact": "high|medium|low", "status": "…", "children": [] }。',
  'type 取：goal 目标 / fact 事实 / inference 推断 / assumption 假设 / constraint 约束 / direction 方案 / risk 风险 / signal 信号 / action 行动 / question 疑问。',
  'source 取：user 用户明确表达 / evidence 已验证信息 / model 模型推断 / unconfirmed 待确认。',
  '树的一条合格形状（内容是示例，不要照抄）：',
  '用户想法',
  '├── 目标：提高项目成功率',
  '├── 局势',
  '│   ├── 事实：时间有限',
  '│   ├── 事实：资源有限',
  '│   ├── 推断：当前最大问题可能是方向不清',
  '│   └── 未知：更重视速度还是质量',
  '├── 关键矛盾',
  '│   └── 快速推进 vs 先充分验证',
  '├── 方向',
  '│   ├── A：快速试错',
  '│   ├── B：先做信息侦察',
  '│   └── C：缩小目标后推进',
  '└── 当前建议',
  '    ├── 推荐：B',
  '    ├── 第一动作：验证三个关键假设',
  '    └── 转向信号：验证结果支持快速试错时转向 A',
  '',
  '【硬性约束】',
  `- directions 2–4 个，id 依次为 A/B/C/D；questions 最多 ${MAX_QUESTIONS} 个。`,
  '- 每条数组元素都是一句可读的中文短句，不要嵌套对象。',
  '- 不确定就写进 unknowns，不要编造事实。',
  '- 语言跟用户输入一致。',
].join('\n');

/** 审查系统提示词（手动触发）。 */
export const REVIEW_SYSTEM_PROMPT = [
  '你是"参谋结构审查器"。',
  '',
  '请检查上一份参谋方向结构：',
  '1. 是否忠实保留了用户原始意图',
  '2. 是否把事实和推断混在一起',
  '3. 是否存在未经依据的脑补',
  '4. 各方向是否真的有战略差异',
  '5. 是否遗漏了会改变决策的关键约束',
  '6. 推荐是否能够追溯到前提和比较结果',
  '7. 是否生成了过多无决策价值的分支',
  '8. 第一行动是否具体、可逆、能够获得信息',
  '9. 是否存在没有定义的转向或停止条件',
  '10. 是否应当暂缓推荐并提出关键问题',
  '',
  '只返回以下 JSON，不要代码块围栏、不要解释：',
  '{ "valid": true, "errors": [], "warnings": [], "missing_questions": [], "recommended_corrections": [] }',
].join('\n');

/* ------------------------------------------------------------------ *
 * 输入结构
 * ------------------------------------------------------------------ */

/**
 * 模式线索，**按特异性从强到弱排列**：一句话里同时出现不同类别的词时，
 * 取表里更靠前的那个。例如"调研一下再规划"含 planning 词组，但意图是
 * 侦察——先取证再谈路线，所以侦察必须排在谋划前面。
 */
const MODE_HINTS = [
  { mode: 'reconnaissance', pattern: /调研|查证|摸清|了解|探索|侦察|先看看|搞清楚/ },
  { mode: 'decision', pattern: /选|挑|要不要|该不该|取舍|决策|下定决心/ },
  { mode: 'review', pattern: /复盘|回顾|总结|回看|哪里做错/ },
  { mode: 'execution', pattern: /执行|落地|推进|实施|开始做|动手/ },
  { mode: 'planning', pattern: /规划|计划|路线|排期|方案|怎么做/ },
];

/**
 * 没显式给模式时，按草稿里的动词猜一个；猜不出就按"谋划"处理。
 * @param draft - 用户原话。
 * @returns 参谋模式。
 */
export function inferMode(draft) {
  const text = typeof draft === 'string' ? draft : '';
  for (const hint of MODE_HINTS) {
    if (hint.pattern.test(text)) return hint.mode;
  }
  return 'planning';
}

/**
 * 拼装固定任务输入结构。多轮时把上一份局势模型带回去，让模型"更新"而不是"重生成"。
 * @param request - 草稿、模式、背景、约束、已验证信息、已有参谋状态。
 * @returns 交给模型的用户消息。
 */
export function buildAdvisorInput(request) {
  const {
    draft,
    mode,
    context,
    constraints,
    evidence,
    currentState,
  } = request;
  const section = (title, value) => {
    if (Array.isArray(value)) {
      return value.length === 0 ? `【${title}】\n（暂无）` : `【${title}】\n${value.map((item) => `- ${item}`).join('\n')}`;
    }
    if (value === undefined || value === null || String(value).trim() === '') return `【${title}】\n（暂无）`;
    return `【${title}】\n${String(value)}`;
  };
  const state = currentState === undefined || currentState === null
    ? '（暂无，这是首次分析）'
    : `\`\`\`json\n${JSON.stringify(currentState).slice(0, 24000)}\n\`\`\``;
  return [
    section('用户原话', draft),
    section('已知背景', context),
    section('当前约束', constraints),
    `【已有参谋状态】\n${state}`,
    `【当前模式】\n${mode}（reconnaissance 侦察 / planning 谋划 / decision 决策 / execution 执行 / review 复盘）`,
    section('已验证信息', evidence),
    '请基于以上内容生成或更新参谋方向结构。保留原有仍然有效的判断，明确标记已经失效、被否定或待验证的节点。',
  ].join('\n\n');
}

/* ------------------------------------------------------------------ *
 * 宽松解析与校验裁剪
 * ------------------------------------------------------------------ */

/** JSON 解析失败时的降级文本长度上限。 */
const FALLBACK_TEXT_LIMIT = 4000;

/**
 * 从模型输出里抠出 JSON 对象：去围栏、取首个 `{` 到配对 `}`、容忍前后废话与尾部截断。
 * @param text - 模型原始输出。
 * @returns 解析结果对象，或 null。
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  const stripped = text.replace(/```[a-zA-Z]*\s*/gu, '').trim();
  const start = stripped.indexOf('{');
  if (start < 0) return null;
  // 先按整体解析；失败则退化为"从后往前找能配平的 }"。
  const whole = stripped.slice(start);
  try {
    return JSON.parse(whole);
  } catch {
    /* 继续尝试截断修复 */
  }
  for (let end = whole.lastIndexOf('}'); end > 0; end = whole.lastIndexOf('}', end - 1)) {
    const candidate = whole.slice(0, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      /* 继续缩小 */
    }
  }
  // 尾部被截断：补齐未闭合的括号再试一次。
  const repaired = repairTruncatedJson(whole);
  if (repaired !== null) {
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 补齐被截断的 JSON：闭合未完成的字符串，再按栈补上收尾括号。
 * 不回溯到最后一个逗号——那会把 `[1,2` 里完整的 `2` 一起丢掉。
 * @param text - 从 `{` 开始的片段。
 * @returns 可解析文本，或 null。
 */
function repairTruncatedJson(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (stack.length === 0 && !inString) return null;
  // 截断发生在字符串中间：补一个引号，末尾悬空的转义符也要先去掉。
  let head = text;
  if (inString) head = `${head.replace(/\\+$/u, '')}"`;
  const closers = [];
  for (let i = stack.length - 1; i >= 0; i -= 1) closers.push(stack[i] === '{' ? '}' : ']');
  return `${head}${closers.join('')}`;
}

const asText = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '');
const asLevel = (value) => (LEVELS.includes(value) ? value : 'medium');
const asList = (value) => (Array.isArray(value)
  ? value.map((item) => (typeof item === 'string' ? item.trim().slice(0, MAX_TEXT) : asText(item?.label ?? item?.text))).filter((item) => item !== '').slice(0, MAX_LIST)
  : []);

/**
 * 校验并裁剪一个树节点（递归）。
 * @param node - 原始节点。
 * @param depth - 当前深度。
 * @param budget - 剩余节点名额（对象引用，递归中递减）。
 * @returns 规范化节点，或 null（整棵为空时）。
 */
export function normalizeNode(node, depth = 0, budget = { left: MAX_NODES }) {
  if (node === null || typeof node !== 'object' || budget.left <= 0) return null;
  const type = typeof node.type === 'string' && NODE_TYPES.includes(node.type) ? node.type : 'inference';
  const label = asText(node.label);
  if (label === '') return null;
  budget.left -= 1;
  const children = [];
  if (depth + 1 < MAX_DEPTH && Array.isArray(node.children)) {
    for (const child of node.children.slice(0, MAX_CHILDREN)) {
      const normalized = normalizeNode(child, depth + 1, budget);
      if (normalized !== null) children.push(normalized);
    }
  }
  const source = type === 'root' ? 'user' : (NODE_SOURCES.includes(node.source) ? node.source : 'model');
  return {
    type,
    label,
    source,
    confidence: asLevel(node.confidence),
    impact: asLevel(node.impact),
    status: NODE_STATUSES.includes(node.status) ? node.status : 'open',
    children,
  };
}

/**
 * 把模型给的 JSON 校验裁剪成可用的局势模型。
 * @param value - 已解析的对象。
 * @param draft - 用户原话（树根兜底）。
 * @returns 规范化局势模型。
 */
export function normalizeAdvisorModel(value, draft) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const intent = source.intent !== null && typeof source.intent === 'object' ? source.intent : {};
  const situation = source.situation !== null && typeof source.situation === 'object' ? source.situation : {};
  const recommendation = source.recommendation !== null && typeof source.recommendation === 'object' ? source.recommendation : {};

  const directions = (Array.isArray(source.directions) ? source.directions : [])
    .slice(0, MAX_DIRECTIONS)
    .map((item, position) => {
      const direction = item !== null && typeof item === 'object' ? item : {};
      const id = typeof direction.id === 'string' && direction.id.trim() !== ''
        ? direction.id.trim().slice(0, 4)
        : String.fromCharCode(65 + position);
      return {
        id,
        name: asText(direction.name) || `方向 ${id}`,
        thesis: asText(direction.thesis),
        premises: asList(direction.premises),
        advantages: asList(direction.advantages),
        costs: asList(direction.costs),
        risks: asList(direction.risks),
        resource_demand: asText(direction.resource_demand),
        reversibility: asLevel(direction.reversibility),
        information_gain: asLevel(direction.information_gain),
        first_action: asText(direction.first_action),
        continue_signals: asList(direction.continue_signals),
        pivot_signals: asList(direction.pivot_signals),
        stop_conditions: asList(direction.stop_conditions),
      };
    })
    // 有名字或有一句 thesis 就算一个方向；两者都空（模型塞的占位）才丢弃。
    .filter((direction) => direction.thesis !== '' || direction.name !== '');

  const questions = (Array.isArray(source.questions) ? source.questions : [])
    .slice(0, MAX_QUESTIONS)
    .map((item) => {
      const question = item !== null && typeof item === 'object' ? item : {};
      return {
        question: asText(question.question),
        why_it_matters: asText(question.why_it_matters),
        could_change_direction: question.could_change_direction !== false,
      };
    })
    .filter((item) => item.question !== '');

  const budget = { left: MAX_NODES };
  const rootNode = normalizeNode(
    source.tree !== null && typeof source.tree === 'object'
      ? { type: 'goal', label: draft, source: 'user', confidence: 'high', status: 'open', ...source.tree, children: source.tree.children }
      : { type: 'goal', label: draft, source: 'user', confidence: 'high', status: 'open', children: [] },
    0,
    budget,
  );

  const directionIds = directions.map((direction) => direction.id);
  const recommended = typeof recommendation.direction_id === 'string' ? recommendation.direction_id.trim() : '';
  return {
    intent: {
      primary: asText(intent.primary),
      secondary: asList(intent.secondary),
      success_criteria: asList(intent.success_criteria),
      confidence: asLevel(intent.confidence),
    },
    situation: {
      facts: asList(situation.facts),
      inferences: asList(situation.inferences),
      assumptions: asList(situation.assumptions),
      constraints: asList(situation.constraints),
      unknowns: asList(situation.unknowns),
      actors: asList(situation.actors),
      time_horizon: asText(situation.time_horizon),
    },
    key_tensions: asList(source.key_tensions),
    decision_variables: asList(source.decision_variables),
    directions,
    recommendation: {
      // 方向 id 必须真实存在，否则退回"暂不推荐"。
      direction_id: directionIds.includes(recommended) ? recommended : 'undetermined',
      reasoning: asList(recommendation.reasoning),
      confidence: asLevel(recommendation.confidence),
      why_not_others: asList(recommendation.why_not_others),
    },
    questions,
    tree: rootNode ?? { type: 'goal', label: asText(draft) || '用户原始想法', source: 'user', confidence: 'medium', impact: 'high', status: 'open', children: [] },
  };
}

/**
 * 解析模型输出：JSON（宽松）为主，失败降级为纯文本局势模型，保证界面上永远有东西可看。
 * @param text - 模型原始输出。
 * @param draft - 用户原话。
 * @returns { model, structured, fallbackText }。
 */
export function parseAdvisorOutput(text, draft) {
  const json = extractJsonObject(text);
  if (json !== null && (Array.isArray(json.directions) || json.tree !== undefined)) {
    return { model: normalizeAdvisorModel(json, draft), structured: true, fallbackText: '' };
  }
  const plain = typeof text === 'string' ? text.trim().slice(0, FALLBACK_TEXT_LIMIT) : '';
  const model = normalizeAdvisorModel(
    {
      intent: { primary: plain === '' ? '' : plain.slice(0, 200), confidence: 'low' },
      directions: [],
      recommendation: { direction_id: 'undetermined' },
      questions: [],
      tree: { type: 'goal', label: draft, children: plain === '' ? [] : [{ type: 'inference', label: plain }] },
    },
    draft,
  );
  return { model, structured: false, fallbackText: plain };
}

/**
 * 规范化审查结果。
 * @param value - 模型给的 JSON。
 * @returns 审查结果。
 */
export function normalizeReview(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  return {
    valid: source.valid !== false,
    errors: asList(source.errors),
    warnings: asList(source.warnings),
    missing_questions: asList(source.missing_questions),
    recommended_corrections: asList(source.recommended_corrections),
  };
}

/* ------------------------------------------------------------------ *
 * 缩进树文本渲染（诊断/测试用，界面另有 React 视图）
 * ------------------------------------------------------------------ */

/**
 * 把树渲染成缩进文本，便于测试断言与诊断输出。
 * 根节点的子节点顶格（无 ├── 前缀），再往下才有分支符号——与设计稿的
 * 「用户想法 / ├── 目标 / │   ├── 事实」形状一致。
 * @param node - 树节点。
 * @param prefix - 当前行前缀。
 * @param isLast - 是否为本层最后一个。
 * @param isRoot - 是否根节点。
 * @returns 多行文本。
 */
export function renderTreeText(node, prefix = '', isLast = true, isRoot = true) {
  if (node === null || typeof node !== 'object') return '';
  const branch = isRoot ? '' : `${isLast ? '└── ' : '├── '}`;
  const lines = [`${prefix}${branch}${node.label}`];
  const children = Array.isArray(node.children) ? node.children : [];
  // 根节点的子节点不额外缩进，前缀保持空。
  const childPrefix = isRoot ? '' : `${prefix}${isLast ? '    ' : '│   '}`;
  children.forEach((child, index) => {
    const text = renderTreeText(child, childPrefix, index === children.length - 1, false);
    if (text !== '') lines.push(text);
  });
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 会话态快照
 * ------------------------------------------------------------------ */

/**
 * 以 sessionId 为键的参谋状态快照。内存态：进程重启即失效。
 * 单独成类是为了下一版换成持久化存储时只改这一处。
 */
export class AdvisorStateStore {
  constructor(now = () => Date.now(), ttlMs = STATE_TTL_MS) {
    this.entries = new Map();
    this.now = now;
    this.ttlMs = ttlMs;
  }

  /**
   * 读一份快照，过期即视为不存在。
   * @param sessionId - 会话标识。
   * @returns 快照或 null。
   */
  get(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return null;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(sessionId);
      return null;
    }
    return entry.model;
  }

  /**
   * 写入快照（含最近一次草稿与模式，供"续研"使用）。
   * @param sessionId - 会话标识。
   * @param model - 局势模型。
   * @param meta - 附加信息。
   */
  set(sessionId, model, meta = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    this.entries.set(sessionId, { model, at: this.now(), ...meta });
    // 简单的容量控制：超限就丢最旧的一条。
    if (this.entries.size > MAX_STATES) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest !== undefined) this.entries.delete(oldest[0]);
    }
  }

  /** 清空（测试与"重新开始"用）。 */
  clear() {
    this.entries.clear();
  }
}
