/**
 * 诊断脚本：把 dsh web 页面里已渲染的插槽、按钮、可见文本 dump 出来。
 * 用法: node test/verify-dom.mjs http://127.0.0.1:3999 <token>
 */
import { createRequire } from 'node:module';

const base = process.argv[2] ?? 'http://127.0.0.1:3999';
const token = process.argv[3] ?? '';
const appModules = 'C:/Users/ROG/AppData/Local/Programs/DeepSeek Harness Desktop/resources/app.asar.unpacked/node_modules/';
const require = createRequire(appModules);
const { chromium } = require('playwright');

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Users/ROG/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (error) => console.log('pageerror:', error.message.slice(0, 200)));
await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-composer-seat]', { timeout: 45000 });
await page.waitForTimeout(2500);

const dump = await page.evaluate(() => {
  const slots = [...document.querySelectorAll('[data-slot]')].map((node) => node.getAttribute('data-slot'));
  const buttons = [...document.querySelectorAll('button')].map((node) => ({
    aria: node.getAttribute('aria-label'),
    title: node.getAttribute('title'),
    text: (node.textContent ?? '').trim().slice(0, 24),
    cls: (node.className ?? '').toString().slice(0, 40),
  }));
  return {
    text: (document.body.innerText ?? '').slice(0, 1200),
    slots,
    buttons,
    contentEditables: document.querySelectorAll('[contenteditable]').length,
    ourButton: document.querySelectorAll('.dshpe_button').length,
    ourDock: document.querySelectorAll('.dshpe_dock').length,
    moduleLoaderKeys: Object.keys(window.__ModuleLoader__ ?? {}),
  };
});

console.log('=== 可见文本 ===\n' + dump.text);
console.log('\n=== 已渲染插槽 ===');
console.log([...new Set(dump.slots)].sort().join('\n'));
console.log('\n=== 按钮 (' + dump.buttons.length + ') ===');
for (const item of dump.buttons) console.log(`  aria=${item.aria} title=${item.title} text=${item.text} cls=${item.cls}`);
console.log('\ncontenteditable:', dump.contentEditables, ' ourButton:', dump.ourButton, ' ourDock:', dump.ourDock);
console.log('ModuleLoader keys:', dump.moduleLoaderKeys.join(','));

await browser.close();
