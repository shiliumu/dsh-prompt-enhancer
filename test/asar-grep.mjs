/**
 * 在 app.asar 里按关键字找代码片段（asar 是「头部 JSON + 连续文件内容」，直接按字节搜索即可）。
 *
 * 用法: node test/asar-grep.mjs <asar路径> <关键字> [上下文长度]
 */
import { readFileSync } from 'node:fs';

const [asarPath, needle, contextRaw] = process.argv.slice(2);
const context = Number.parseInt(contextRaw ?? '1200', 10);
const buffer = readFileSync(asarPath);
const haystack = buffer.toString('latin1');

let index = -1;
let hits = 0;
while ((index = haystack.indexOf(needle, index + 1)) !== -1 && hits < 6) {
  hits += 1;
  const start = Math.max(0, index - context);
  const end = Math.min(haystack.length, index + needle.length + context);
  console.log(`\n===== hit #${hits} at byte ${index} =====`);
  console.log(haystack.slice(start, end).replace(/\u0000/g, ''));
}

if (hits === 0) console.log(`no hit for ${needle}`);
console.log(`\n(total hits: ${hits}, asar bytes: ${buffer.length})`);
