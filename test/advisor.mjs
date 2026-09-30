/**
 * 参谋方向引擎（Host 侧）契约测试：输入结构、宽松解析、校验裁剪、会话态快照、树渲染。
 * 用法: node test/advisor.mjs
 */
import assert from 'node:assert/strict';
import {
  ADVISOR_SYSTEM_PROMPT,
  AdvisorStateStore,
  REVIEW_SYSTEM_PROMPT,
  buildAdvisorInput,
  extractJsonObject,
  inferMode,
  normalizeAdvisorModel,
  normalizeNode,
  normalizeReview,
  parseAdvisorOutput,
  renderTreeText,
} from '../lib/advisor.js';

/* ---------- 1. 模式推断 ---------- */
{
  assert.equal(inferMode('帮我调研一下这个方案'), 'reconnaissance');
  assert.equal(inferMode('我该怎么规划这条路'), 'planning');
  assert.equal(inferMode('要不要现在辞职'), 'decision');
  assert.equal(inferMode('帮我复盘这次失败'), 'review');
  assert.equal(inferMode('下周开始执行'), 'execution');
  assert.equal(inferMode('随便写点什么'), 'planning', '猜不出时默认谋划');
  // 一句话里出现多类线索时，取特异性更强的那个
  assert.equal(inferMode('先调研清楚再规划路线'), 'reconnaissance', '侦察优先于谋划');
  assert.equal(inferMode('复盘下上季度的得失'), 'review');
  // "要不要…再决定"这种句式主意图是拿主意，决策优先
  assert.equal(inferMode('要不要先复盘一下再决定'), 'decision', '显式选择句式优先');
}

/* ---------- 2. 固定输入结构 ---------- */
{
  const text = buildAdvisorInput({
    draft: '要不要换工作',
    mode: 'decision',
    context: '后端五年',
    constraints: ['房贷在还'],
    evidence: ['已拿到一个 offer'],
    currentState: null,
  });
  for (const section of ['【用户原话】', '【已知背景】', '【当前约束】', '【已有参谋状态】', '【当前模式】', '【已验证信息】']) {
    assert.ok(text.includes(section), `输入结构缺少 ${section}`);
  }
  assert.ok(text.includes('要不要换工作'));
  assert.ok(text.includes('首次分析'), '首次分析应明示无历史状态');
  assert.ok(text.includes('decision'));

  const withState = buildAdvisorInput({
    draft: '要不要换工作',
    mode: 'decision',
    currentState: { intent: { primary: '换工作' }, directions: [{ id: 'A' }] },
  });
  assert.ok(withState.includes('已有参谋状态'), '应带上历史状态');
  assert.ok(withState.includes('"primary":"换工作"'), '历史状态应以 JSON 原样带回');
  assert.ok(withState.includes('保留原有仍然有效的判断'), '增量更新指令必须出现');
}

/* ---------- 3. 宽松 JSON 解析 ---------- */
{
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('前言\n```json\n{"a":1}\n```\n后记'), { a: 1 }, '应穿透代码块围栏与前后废话');
  assert.deepEqual(extractJsonObject('分析如下：{"a":{"b":[1,2]}} 以上'), { a: { b: [1, 2] } });
  assert.equal(extractJsonObject('完全不是 JSON'), null);
  // 尾部分被截断：应能补齐收尾括号
  assert.deepEqual(extractJsonObject('{"a":1,"b":[1,2'), { a: 1, b: [1, 2] }, '截断的数组应被补齐');
  assert.deepEqual(extractJsonObject('{"a":"未闭合'), { a: '未闭合' }, '未闭合字符串应被修好');
}

/* ---------- 4. 节点校验裁剪 ---------- */
{
  const budget = { left: 160 };
  assert.equal(normalizeNode({ type: '未知类型', label: '有标签' }, 0, budget).type, 'inference', '非法 type 应回落 inference');
  assert.equal(normalizeNode({ type: 'fact', label: '' }, 0, budget), null, '无 label 的节点应丢弃');
  const node = normalizeNode(
    {
      type: 'fact',
      label: '时间有限',
      confidence: '超高',
      impact: 'high',
      status: '算了',
      children: [{ type: 'risk', label: '子节点', source: 'evidence' }],
    },
    0,
    budget,
  );
  assert.equal(node.confidence, 'medium', '非法置信度应回落 medium');
  assert.equal(node.impact, 'high');
  assert.equal(node.status, 'open', '非法状态应回落 open');
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].source, 'evidence');
}

/* ---------- 5. 局势模型校验裁剪 ---------- */
{
  const model = normalizeAdvisorModel(
    {
      intent: { primary: '提高成功率', confidence: '瞎写' },
      situation: { facts: ['时间有限', '', 42], unknowns: ['更重视速度还是质量'] },
      key_tensions: ['快速推进 vs 充分验证'],
      directions: [
        { id: 'A', name: '快速试错', thesis: '小步快跑', reversibility: 'high', information_gain: '嗯' },
        { id: 'B', name: '先侦察', thesis: '先取证' },
        { id: 'C', name: '缩小目标', thesis: '先做一半' },
        { id: 'D', name: '第四方向', thesis: '第四' },
        { id: 'E', name: '第五方向', thesis: '超过上限应被裁掉' },
      ],
      recommendation: { direction_id: 'Z', reasoning: ['依据'], confidence: 'low' },
      questions: [
        { question: '问题一', why_it_matters: '会改变方向', could_change_direction: true },
        { question: '问题二' },
        { question: '问题三' },
        { question: '问题四应被裁掉' },
      ],
      tree: { type: 'goal', label: '用户想法', children: [{ type: 'action', label: '第一动作' }] },
    },
    '我要提高项目成功率',
  );
  assert.equal(model.intent.primary, '提高成功率');
  assert.equal(model.intent.confidence, 'medium', '非法置信度回落');
  assert.deepEqual(model.situation.facts, ['时间有限'], '空串与数字应被剔除');
  assert.equal(model.directions.length, 4, '方向应被裁到 4 个');
  assert.deepEqual(model.directions.map((d) => d.id), ['A', 'B', 'C', 'D']);
  assert.equal(model.directions[0].information_gain, 'medium', '非法刻度回落 medium');
  assert.equal(model.recommendation.direction_id, 'undetermined', '不存在的推荐方向必须退回暂不推荐');
  assert.equal(model.questions.length, 3, '待确认问题最多 3 个');
  assert.equal(model.questions[0].could_change_direction, true);
  assert.equal(model.tree.label, '用户想法');
  assert.equal(model.tree.source, 'user');
  assert.equal(model.tree.children[0].type, 'action');
}

/* ---------- 6. parseAdvisorOutput：结构化与降级 ---------- */
{
  const good = parseAdvisorOutput(
    '```json\n{"intent":{"primary":"目标"},"directions":[{"id":"A","thesis":"策略"}],"tree":{"label":"根","children":[]}}\n```',
    '草稿',
  );
  assert.equal(good.structured, true);
  assert.equal(good.model.intent.primary, '目标');
  assert.equal(good.model.directions.length, 1);
  assert.equal(good.fallbackText, '');

  const plain = parseAdvisorOutput('模型没给 JSON，只写了一段话。', '草稿');
  assert.equal(plain.structured, false, '没有 JSON 应降级');
  assert.equal(plain.model.recommendation.direction_id, 'undetermined');
  assert.equal(plain.model.tree.children.length, 1, '降级时正文应挂到树上，界面仍有内容');
  assert.ok(plain.fallbackText.includes('模型没给 JSON'));

  const empty = parseAdvisorOutput('', '草稿');
  assert.equal(empty.structured, false);
  assert.equal(empty.model.tree.label, '草稿', '空输出时树根应为用户草稿');
}

/* ---------- 7. 树渲染 ---------- */
{
  const simple = renderTreeText({
    label: '用户想法',
    children: [
      { label: '目标：提高成功率', children: [] },
      { label: '局势', children: [{ label: '事实：时间有限', children: [] }, { label: '未知：速度还是质量', children: [] }] },
    ],
  });
  const lines = simple.split('\n');
  assert.equal(lines[0], '用户想法', '根节点应顶格无前缀');
  assert.equal(lines[1], '├── 目标：提高成功率', '根的直接子节点应顶格带分支符');
  assert.equal(lines[2], '└── 局势');
  assert.equal(lines[3], '    ├── 事实：时间有限', '最后一个分支的子孙用空白对齐（不是 │）');
  assert.equal(lines[4], '    └── 未知：速度还是质量');

  // 非末尾分支的子孙应带竖线，保证视觉连贯
  const branched = renderTreeText({
    label: '根部',
    children: [
      { label: '第一支', children: [{ label: '孙节点', children: [] }] },
      { label: '第二支', children: [] },
    ],
  });
  assert.ok(branched.includes('│   └── 孙节点'), `非末尾分支的子孙应带竖线：\n${branched}`);
  assert.ok(branched.split('\n').every((line) => line.trim() !== ''), '不应产生空行');
}

/* ---------- 8. 审查结果规范化 ---------- */
{
  const review = normalizeReview({ valid: false, errors: ['把推断当事实'], warnings: [], missing_questions: ['速度还是质量'], recommended_corrections: ['补前提'] });
  assert.equal(review.valid, false);
  assert.deepEqual(review.errors, ['把推断当事实']);
  const fallback = normalizeReview(null);
  assert.equal(fallback.valid, true, '缺字段不应误判为不通过');
}

/* ---------- 9. 会话态快照 ---------- */
{
  let clock = 1_000;
  const store = new AdvisorStateStore(() => clock, 5_000);
  assert.equal(store.get('s1'), null);
  store.set('s1', { intent: { primary: 'A' } }, { draft: '草稿' });
  assert.deepEqual(store.get('s1'), { intent: { primary: 'A' } });
  assert.equal(store.get(''), null, '空 sessionId 不应存');
  clock += 5_001;
  assert.equal(store.get('s1'), null, '过期快照应视为不存在');
  store.set('s1', { intent: { primary: 'B' } });
  store.clear();
  assert.equal(store.get('s1'), null);
}

/* ---------- 10. 提示词完整性（防止误删关键约束） ---------- */
{
  for (const rule of ['事实、推断、假设、建议必须明确区分', '待确认问题最多三个', '暂不推荐', '参谋树', '增量更新']) {
    assert.ok(ADVISOR_SYSTEM_PROMPT.includes(rule), `主提示词缺少关键约束：${rule}`);
  }
  assert.ok(REVIEW_SYSTEM_PROMPT.includes('recommended_corrections'));
  assert.ok(ADVISOR_SYSTEM_PROMPT.includes('"tree"'), '主提示词必须规定 tree 字段');
}

console.log('advisor ok');
console.log('  模式推断 / 固定输入结构 / 宽松 JSON（含截断修复）/ 节点与模型裁剪');
console.log('  结构化与降级双路径 / 缩进树渲染 / 审查规范化 / 会话态 TTL / 提示词约束');
