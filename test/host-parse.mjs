/**
 * Host 侧解析测试：
 *   主路径 = 行分隔 DSL（【候选】/【待定】/`- 标签 || 填充 || 效果 || 占位符`）
 *   次路径 = JSON（万一模型还是给 JSON）
 *   兜底   = 纯文本按 === 切分
 *
 * 用法: node test/host-parse.mjs
 */
import assert from 'node:assert/strict';
import { parseDsl, parseStructured, splitCandidates } from '../lib/index.js';

/* ---------- DSL 主路径 ---------- */
{
  const raw = [
    '好的，我来改写：',
    '【候选】',
    '排查爬虫中断：连续运行 <待确认：时长> 分钟不再中断。',
    '第二行正文。',
    '【待定】这次要动代码吗？',
    '- 只诊断 || 只做根因定位，暂不修改任何代码 || 最快、零风险 ||',
    '- 诊断+修复 || 定位根因后直接给出并应用修复 || 一次到位 ||',
    '【待定】跑多久算稳？',
    '- 30 分钟 || 连续运行 30 分钟 || 只能抓到高频断连 || <待确认：时长>',
    '- 2 小时 || 连续运行 2 小时 || 能看出间歇性中断 || <待确认：时长>',
    '【候选】',
    '第二条候选正文。',
  ].join('\n');
  const parsed = parseStructured(raw, 3);
  assert.equal(parsed.structured, true, 'DSL 应走结构化路径');
  assert.equal(parsed.candidates.length, 2, '应解析出 2 条候选（前面的废话被忽略）');
  assert.equal(parsed.candidates[0].text, '排查爬虫中断：连续运行 <待确认：时长> 分钟不再中断。\n第二行正文。', '正文应保留多行');
  assert.equal(parsed.candidates[0].gaps.length, 2, '应有 2 个待定点');
  assert.equal(parsed.candidates[0].gaps[0].question, '这次要动代码吗？');
  assert.equal(parsed.candidates[0].gaps[0].options[1].fill, '定位根因后直接给出并应用修复');
  assert.equal(parsed.candidates[0].gaps[0].options[1].effect, '一次到位');
  assert.equal(parsed.candidates[0].gaps[0].options[1].placeholder, '', '行尾 || 空段应为空占位符');
  assert.equal(parsed.candidates[0].gaps[1].options[1].placeholder, '<待确认：时长>', '第四段应被识别为占位符');
  assert.equal(parsed.candidates[1].gaps.length, 0, '第二条候选没有待定点');
}

/* ---------- DSL 容错：编号变体 / 缺段 / 全角空格 / 用 · 当选项符号 ---------- */
{
  const raw = [
    '【候选一】',
    '只有标签的选项也要能用。',
    '【待定】要哪一版？',
    '· 简版',
    '· 详版 || 给出详细版本 || 更慢更全 ||',
  ].join('\n');
  const parsed = parseStructured(raw, 3);
  assert.equal(parsed.structured, true);
  assert.equal(parsed.candidates[0].gaps[0].options[0].label, '简版');
  assert.equal(parsed.candidates[0].gaps[0].options[0].fill, '简版', 'fill 缺省应回落到 label');
  assert.equal(parsed.candidates[0].gaps[0].options[1].effect, '更慢更全');
}

/* ---------- DSL 裁剪：单选项 gap 丢弃、gaps/options/候选 上限 ---------- */
{
  const raw = [
    '【候选】',
    '裁剪测试',
    '【待定】只有一个选项',
    '- 孤选项 || x || y ||',
    '【待定】选项超限',
    '- a || a1 || a2 ||',
    '- b || b1 || b2 ||',
    '- c || c1 || c2 ||',
    '- d || d1 || d2 ||',
    '- e || e1 || e2 ||',
    '- f || f1 || f2 ||',
    '【待定】第三个',
    '- x || x1 || x2 ||',
    '- y || y1 || y2 ||',
    '【待定】第四个应被裁掉',
    '- x || x1 || x2 ||',
    '- y || y1 || y2 ||',
  ].join('\n');
  const gaps = parseStructured(raw, 3).candidates[0].gaps;
  assert.equal(gaps.length, 3, 'gaps 应被裁到 3 个（单选项 gap 不占名额）');
  assert.equal(gaps[0].question, '选项超限', '单选项 gap 应被丢弃');
  assert.equal(gaps[0].options.length, 4, 'options 应被裁到 4 个');
  assert.equal(parseStructured(raw, 3).candidates[0].text, '裁剪测试', '被裁掉的选项不得漏进正文');
}
{
  const raw = Array.from({ length: 9 }, (_, i) => `【候选】\n候选 ${i}`).join('\n');
  assert.equal(parseStructured(raw, 3).candidates.length, 3, '候选数应被裁到 count');
}

/* ---------- JSON 次路径仍然可用 ---------- */
{
  const raw = ['结果：', '```json', '{"candidates":[{"text":"带围栏的候选","gaps":[]}]}', '```'].join('\n');
  const parsed = parseStructured(raw, 3);
  assert.equal(parsed.structured, true, '没有 DSL 标记时应回落到 JSON');
  assert.equal(parsed.candidates[0].text, '带围栏的候选');
}
{
  const raw = JSON.stringify({
    candidates: [
      {
        text: 'JSON 裁剪',
        gaps: [{ question: '只有一项', options: [{ label: '孤选项' }] }, { question: '两项', options: [{ label: 'a' }, { label: 'b', fill: 'b 完整表述' }] }],
      },
    ],
  });
  const gaps = parseStructured(raw, 3).candidates[0].gaps;
  assert.equal(gaps.length, 1, 'JSON 路径也要丢弃单选项 gap');
  assert.equal(gaps[0].options[1].fill, 'b 完整表述');
}

/* ---------- 兜底：既不是 DSL 也不是 JSON ---------- */
{
  const parsed = parseStructured('第一段\n===\n第二段', 3);
  assert.equal(parsed.structured, false, '不是结构化输出应退回纯文本');
  assert.deepEqual(
    parsed.candidates.map((item) => item.text),
    ['第一段', '第二段'],
  );
  assert.deepEqual(parsed.candidates[0].gaps, []);
}
{
  assert.equal(parseStructured('', 3).candidates.length, 0);
  assert.equal(parseStructured('{"candidates":[{"text":"截断了', 3).structured, false, '截断输入应兜底');
  assert.deepEqual(splitCandidates('a\n===\nb\n===\nc\n===\nd', 3), ['a', 'b', 'c']);
}

/* ---------- DSL：没有【候选】标记时不误判 ---------- */
{
  assert.deepEqual(parseDsl('就是一段普通文字\n没有标记', 3), [], '没有标记应返回空数组');
}

console.log('host-parse ok');
console.log('  DSL 主路径 / 容错 / 裁剪 + JSON 次路径 + 纯文本兜底 全部通过');
