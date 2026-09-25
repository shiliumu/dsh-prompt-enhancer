/**
 * 端到端 UI 验证：真浏览器里输入草稿 -> 点 ✨ -> 等候选 -> 数字键采纳 -> 校验输入框内容。
 *
 * 用法: node test/verify-ui.mjs http://127.0.0.1:3999 <token>
 */
import { createRequire } from 'node:module';

const base = process.argv[2] ?? 'http://127.0.0.1:3999';
const token = process.argv[3] ?? '';
const shotPath = 'C:/Users/ROG/dsh-workspace/dsh-prompt-enhancer/verify-ui.png';

const appModules = 'C:/Users/ROG/AppData/Local/Programs/DeepSeek Harness Desktop/resources/app.asar.unpacked/node_modules/';
const require = createRequire(appModules);
const { chromium } = require('playwright');

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Users/ROG/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});
// 抓插件自己的请求/响应，出错时能直接看到 Host 返回的 error 文本
page.on('request', (request) => {
  if (request.url().includes('/prompt-enhancer/')) {
    const body = request.postData() ?? '';
    let summary = body;
    try {
      const parsed = JSON.parse(body);
      summary = `provider=${parsed.provider} model=${parsed.model} text=${(parsed.text ?? '').slice(0, 24)}…`;
    } catch {
      /* 原样打印 */
    }
    console.log(`  → POST ${request.url().split('/').pop()}  ${summary}`);
  }
});
page.on('response', async (response) => {
  if (!response.url().includes('/prompt-enhancer/')) return;
  const status = response.status();
  if (status === 200) {
    console.log(`  ← ${status}`);
    return;
  }
  let text = '';
  try {
    text = (await response.text()).slice(0, 200);
  } catch {
    text = '(body unavailable)';
  }
  console.log(`  ← ${status}  ${text}`);
  errors.push(`enhance ${status}: ${text}`);
});

await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('.dshpe_button', { timeout: 60000 });
await page.waitForTimeout(500);

const editor = await page.$('[contenteditable="true"]');
console.log('✨ 按钮已渲染, 输入框:', editor === null ? '未找到' : '已找到');
if (editor === null) {
  await browser.close();
  process.exit(1);
}

const DRAFT = '帮我看看这个爬虫为啥老是断';
await editor.click();
await page.keyboard.type(DRAFT);
await page.waitForTimeout(300);
const draftBefore = await editor.innerText();
console.log('输入草稿:', JSON.stringify(draftBefore));

await page.click('.dshpe_button');
console.log('已点击 ✨，等待候选…');

let dockText = null;
try {
  await page.waitForSelector('.dshpe_dock', { timeout: 90000 });
  await page.waitForTimeout(1200);
  dockText = await page.$eval('.dshpe_dock', (node) => node.innerText);
  console.log('\n候选框内容:\n' + dockText.split('\n').slice(0, 12).join('\n'));
} catch {
  console.log('候选框未出现');
}

const items = await page.$$eval('.dshpe_item', (nodes) => nodes.map((n) => n.innerText.replace(/\n/g, ' ').slice(0, 140)));
console.log('\n候选数量:', items.length);
items.forEach((text, index) => console.log(`  [${index + 1}] ${text}`));

await page.screenshot({ path: shotPath });

/* ---- 生成后切换模型 ---- */
const chip = await page.$('.dshpe_model');
console.log('\n=== 模型切换入口 ===');
if (chip === null) {
  console.log('  未找到 .dshpe_model');
} else {
  const chipLabel = (await chip.innerText()).trim();
  // chip 文案是「模型名 · provider名 ▾」；换模型时优先选同 provider 的另一个模型，
  // 否则可能挑到当前 profile 没挂适配器的 provider（会 500，那是环境问题不是插件问题）。
  const groupOf = (label) => (label.includes('·') ? label.split('·').pop().replace('▾', '').trim() : '');
  const currentGroup = groupOf(chipLabel);
  console.log('  当前模型 chip :', chipLabel, `(provider=${currentGroup || '未知'})`);
  await chip.click();
  await page.waitForTimeout(1500);
  const models = await page.$$eval('.dshpe_item', (nodes) => nodes.map((n) => n.innerText.replace(/\n/g, ' ').trim()));
  console.log('  模型列表条数  :', models.length);
  models.slice(0, 4).forEach((text, i) => console.log(`    [${i + 1}] ${text}`));
  const active = await page.$$eval('.dshpe_item[data-active="true"]', (nodes) => nodes.map((n) => n.innerText.replace(/\n/g, ' ').trim()));
  console.log('  列表里高亮的当前模型:', active.length === 0 ? '（无）' : active[0]);

  const sameGroupIndex = models.findIndex((text, i) => i > 0 && currentGroup !== '' && groupOf(text) === currentGroup && text !== chipLabel);
  const targetIndex = sameGroupIndex >= 1 ? sameGroupIndex : models.length >= 2 ? 1 : -1;
  if (targetIndex >= 1) {
    await page.keyboard.press(String(targetIndex + 1));
    console.log(`  选中第 ${targetIndex + 1} 个模型: ${models[targetIndex]}，等待重新生成…`);
    // 生成期间候选框会消失（busy），等它带着新候选回来
    await page.waitForSelector('.dshpe_dock', { timeout: 120000 });
    await page.waitForTimeout(1200);
    const newChip = await page.$('.dshpe_model');
    const newLabel = newChip === null ? null : (await newChip.innerText()).trim();
    const again = await page.$$eval('.dshpe_item', (nodes) => nodes.map((n) => n.innerText.replace(/\n/g, ' ').slice(0, 90)));
    console.log('  切换后模型 chip:', newLabel);
    console.log('  切换后候选条数 :', again.length);
    console.log('  模型是否真的换了:', newLabel !== null && newLabel !== chipLabel);
    await page.screenshot({ path: 'C:/Users/ROG/dsh-workspace/dsh-prompt-enhancer/verify-ui-switched.png' });
  }
}

// 切换模型后可能已经处于错误态；先确认面板回到候选列表再继续
const errorBanner = await page.$eval('.dshpe_msg[data-kind="error"]', (n) => n.innerText.trim()).catch(() => null);
if (errorBanner !== null) console.log('\n  !! 面板处于错误态:', errorBanner);

/* ---- 待定点 + 方向选项 + 缩进树 ---- */
console.log('\n=== 待定点 / 方向选项 ===');
const gapInfo = await page.evaluate(() => {
  const gaps = [...document.querySelectorAll('.dshpe_gap')].map((node) => ({
    question: node.querySelector('.dshpe_gap_q')?.innerText.trim() ?? '',
    chips: [...node.querySelectorAll('.dshpe_chip')].map((chip) => chip.innerText.replace(/\s+/g, ' ').trim()),
  }));
  return {
    count: gaps.length,
    gaps,
    head: document.querySelector('.dshpe_gaps_head')?.innerText.trim() ?? null,
    badge: document.querySelector('.dshpe_badge')?.innerText.trim() ?? null,
    hasToggle: document.querySelector('.dshpe_toggle') !== null,
    hasTree: document.querySelector('.dshpe_tree') !== null,
  };
});
console.log('  候选卡标记   :', gapInfo.badge);
console.log('  拍板区表头   :', gapInfo.head);
console.log('  待定点数量   :', gapInfo.count);
gapInfo.gaps.forEach((gap, i) => console.log(`    ${i + 1} ${gap.question}  ->  ${gap.chips.join(' | ')}`));
console.log('  方向图入口   :', gapInfo.hasToggle ? '有' : '无');
console.log('  方向图默认   :', gapInfo.hasTree ? '展开' : '收起');

if (gapInfo.count > 0) {
  const chipTexts = [];
  for (let i = 0; i < gapInfo.count; i += 1) {
    const chips = await page.$$('.dshpe_gap .dshpe_chip');
    const index = i === 0 ? 1 : 0;
    if (chips[index] !== undefined) {
      chipTexts.push(`${i + 1}->${(await chips[index].innerText()).replace(/\s+/g, ' ').trim()}`);
      await chips[index].click();
      await page.waitForTimeout(250);
    }
  }
  console.log('  已点选方向   :', chipTexts.join('  '));
  const afterPick = await page.$eval('.dshpe_gaps_head', (n) => n.innerText.trim()).catch(() => null);
  console.log('  勾选后表头   :', afterPick);

  const toggle = await page.$('.dshpe_toggle');
  if (toggle !== null) {
    await toggle.click();
    await page.waitForTimeout(400);
    const treeText = await page.$eval('.dshpe_tree', (n) => n.innerText).catch(() => null);
    console.log('  缩进树内容   :');
    if (treeText === null) console.log('    (未渲染)');
    else treeText.split('\n').slice(0, 14).forEach((line) => console.log(`    ${line}`));
    await page.screenshot({ path: 'C:/Users/ROG/dsh-workspace/dsh-prompt-enhancer/verify-ui-tree.png' });
  }
}

if (items.length > 0) {
  // 有待定点时采纳「当前高亮的那条」（待定点属于它），否则采纳第 2 条
  const adoptKey = gapInfo.count > 0 ? '1' : '2';
  await page.keyboard.press(adoptKey);
  await page.waitForTimeout(600);
  const after = await editor.innerText();
  const dockStillOpen = (await page.$('.dshpe_dock')) !== null;
  console.log(`\n=== 数字键 ${adoptKey} 采纳后 ===`);
  console.log('  输入框内容前 300 字:', JSON.stringify(after.slice(0, 300)));
  console.log('  内容是否变化   :', after !== draftBefore);
  console.log('  候选框是否关闭 :', !dockStillOpen);
  console.log('  占位符是否已填 :', !after.includes('<待确认：'));
  console.log('  是否有补充要求 :', after.includes('【补充要求】'));
  if (gapInfo.count > 0) {
    const picked = gapInfo.gaps[0].chips[1] ?? '';
    console.log('  所选方向       :', picked);
    console.log('  采纳文本是否包含所选方向的关键词:',
      picked.includes('环境') ? after.includes('环境') : '(无法自动判定，见上方全文)');
  }
  await page.screenshot({ path: 'C:/Users/ROG/dsh-workspace/dsh-prompt-enhancer/verify-ui-adopted.png' });
}

console.log('\n页面错误:', errors.length === 0 ? '无' : errors.slice(0, 3).join(' | '));
console.log('截图:', shotPath);
await browser.close();
