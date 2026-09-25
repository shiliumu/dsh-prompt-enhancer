/**
 * 对着真实 DSH host 验证：Host 路由是否注册、客户端模块是否被组装并下发。
 *
 * 用法: node test/verify-host.mjs http://127.0.0.1:3999 <token>
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3999';
const token = process.argv[3] ?? '';

const headers = token === '' ? {} : { authorization: `Bearer ${token}` };
const withToken = (url) => {
  const absolute = new URL(url, base);
  if (token !== '') absolute.searchParams.set('token', token);
  return absolute;
};

async function probe(label, url, init = {}) {
  try {
    const response = await fetch(withToken(url), { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const text = await response.text();
    console.log(`${label}\n   -> ${response.status} ${response.headers.get('content-type') ?? ''}\n      ${text.slice(0, 220).replace(/\n/g, ' ')}`);
    return { status: response.status, text };
  } catch (error) {
    console.log(`${label}\n   -> ERROR ${error.message}`);
    return { status: 0, text: '' };
  }
}

console.log('=== 1. Host 路由 ===');
await probe('GET  /prompt-enhancer/enhance', '/prompt-enhancer/enhance');
await probe('POST /prompt-enhancer/enhance {}', '/prompt-enhancer/enhance', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
await probe('POST /prompt-enhancer/enhance 真草稿但假模型', '/prompt-enhancer/enhance', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '帮我看看这个爬虫为啥老是断', provider: 'nonexistent', model: 'nope', count: 3 }),
});
await probe('GET  /prompt-enhancer/does-not-exist (对照组)', '/prompt-enhancer/does-not-exist');

console.log('\n=== 2. 客户端模块清单 ===');
const root = await probe('GET  /', '/');
const candidates = [
  '/api/client/modules',
  '/client-modules.json',
  '/api/client-modules',
  '/dsh/client-modules',
  '/api/v1/client-modules',
];
for (const path of candidates) {
  const result = await probe(`GET  ${path}`, path);
  if (result.status === 200 && result.text.includes('dsh-client')) {
    console.log(`\n>>> 清单命中: ${path}`);
    console.log(result.text.slice(0, 4000));
    break;
  }
}

console.log('\n=== 3. 根 HTML 里的模块线索 ===');
const matches = [...root.text.matchAll(/["'`]([^"'`]*client[^"'`]*)["'`]/gi)].map((m) => m[1]);
console.log([...new Set(matches)].slice(0, 25).join('\n'));
