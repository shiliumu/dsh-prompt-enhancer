/**
 * 只读诊断探针：判断插件客户端模块「是否加载」以及「目标插槽是否存在」。
 * 用法: node diag-probe.mjs <base> <token>
 * 不做任何交互写入，只读 DOM / ModuleLoader 状态与 console 错误。
 */
import { createRequire } from 'node:module';

const base = process.argv[2] ?? 'http://127.0.0.1:41999';
const token = process.argv[3] ?? '';

const appModules = 'C:/Users/ROG/AppData/Local/Programs/DeepSeek Harness Desktop/resources/app.asar.unpacked/node_modules/';
const require = createRequire(appModules);
const { chromium } = require('playwright');

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Users/ROG/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 300)}`));
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') errors.push(`console.${message.type()}: ${message.text().slice(0, 300)}`);
});

await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

const report = await page.evaluate(() => {
  const loader = window.__ModuleLoader__;
  const own = loader === undefined || loader === null ? [] : Object.keys(loader);
  const interesting = {};
  for (const key of own) {
    const value = loader[key];
    const type = typeof value;
    if (type === 'object' && value !== null) {
      const keys = Object.keys(value);
      interesting[key] = { type, keyCount: keys.length, sample: keys.slice(0, 40) };
    } else if (type === 'function') {
      interesting[key] = { type };
    } else {
      interesting[key] = { type, value: String(value).slice(0, 80) };
    }
  }
  const html = document.documentElement.outerHTML;
  return {
    loaderKeys: interesting,
    pluginMentionedInLoader: own.some((k) => JSON.stringify(interesting[k]).includes('prompt-enhancer'))
      || html.includes('dshpe'),
    bodyHasSparkleButton: document.querySelectorAll('.dshpe_button').length,
    bodyHasDock: document.querySelectorAll('.dshpe_dock').length,
    contenteditable: document.querySelectorAll('[contenteditable="true"]').length,
    bodyHasPluginCss: document.querySelector('style[data-plugin-css]') !== null,
    styleTags: [...document.querySelectorAll('style')].map((s) => s.dataset.pluginCss ?? s.dataset.plugin ?? '(plain)'),
  };
});

console.log('== ModuleLoader 状态 ==');
console.log(JSON.stringify(report.loaderKeys, null, 2).slice(0, 2000));
console.log('== 判定 ==');
console.log('  .dshpe_button        :', report.bodyHasSparkleButton);
console.log('  .dshpe_dock          :', report.bodyHasDock);
console.log('  插件 CSS <style> 注入 :', report.bodyHasPluginCss);
console.log('  style 标签来源        :', JSON.stringify(report.styleTags));
console.log('  输入框 contenteditable:', report.contenteditable);
console.log('  loader/HTML 提到插件  :', report.pluginMentionedInLoader);
console.log('== 页面错误 / 警告 ==');
if (errors.length === 0) console.log('  (无)');
else for (const e of errors.slice(0, 25)) console.log('  -', e);

await browser.close();
