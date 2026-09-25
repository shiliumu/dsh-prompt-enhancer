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
  console.log('  当前模型 chip :', chipLabel);
  await chip.click();
  await page.waitForTimeout(1500);
  const models = await page.$$eval('.dshpe_item', (nodes) => nodes.map((n) => n.innerText.replace(/\n/g, ' ').trim()));
  console.log('  模型列表条数  :', models.length);
  models.slice(0, 4).forEach((text, i) => console.log(`    [${i + 1}] ${text}`));
  const active = await page.$$eval('.dshpe_item[data-active="true"]', (nodes) => nodes.map((n) => n.innerText.replace(/\n/g, ' ').trim()));
  console.log('  列表里高亮的当前模型:', active.length === 0 ? '（无）' : active[0]);

  if (models.length >= 2) {
    const target = models[1];
    await page.keyboard.press('2');
    console.log(`  选中第 2 个模型: ${target}，等待重新生成…`);
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

if (items.length > 0) {
  await page.keyboard.press('2');
  await page.waitForTimeout(600);
  const after = await editor.innerText();
  const dockStillOpen = (await page.$('.dshpe_dock')) !== null;
  console.log('\n=== 数字键 2 采纳后 ===');
  console.log('  输入框内容前 160 字:', JSON.stringify(after.slice(0, 160)));
  console.log('  内容是否变化   :', after !== draftBefore);
  console.log('  候选框是否关闭 :', !dockStillOpen);
  await page.screenshot({ path: 'C:/Users/ROG/dsh-workspace/dsh-prompt-enhancer/verify-ui-adopted.png' });
}

console.log('\n页面错误:', errors.length === 0 ? '无' : errors.slice(0, 3).join(' | '));
console.log('截图:', shotPath);
await browser.close();
