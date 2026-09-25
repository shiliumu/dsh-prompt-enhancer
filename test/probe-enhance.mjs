/**
 * 直接打 Host 路由，看原始返回（绕过浏览器，定位 500 / gaps 缺失）。
 *
 * 用法: node test/probe-enhance.mjs <base> <text> [provider] [model]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:4151';
const text = process.argv[3] ?? '帮我看看这个爬虫为啥老是断';
const provider = process.argv[4];
const model = process.argv[5];

async function post(body, label) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}/prompt-enhancer/enhance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    const elapsed = Date.now() - started;
    console.log(`\n=== ${label} -> HTTP ${response.status} (${elapsed}ms)`);
    if (response.status !== 200) {
      console.log('   ', raw.slice(0, 400));
      return null;
    }
    const payload = JSON.parse(raw);
    console.log('   structured:', payload.structured, '| candidates:', payload.candidates?.length);
    for (const [index, candidate] of (payload.candidates ?? []).entries()) {
      const gaps = candidate.gaps ?? [];
      console.log(`   [${index + 1}] text ${candidate.text.length} 字, gaps=${gaps.length}`);
      for (const gap of gaps) {
        console.log(`        ? ${gap.question}`);
        for (const option of gap.options) {
          console.log(`          - ${option.label} | fill=${option.fill.slice(0, 30)} | effect=${option.effect.slice(0, 40)} | ph=${option.placeholder}`);
        }
      }
    }
    return payload;
  } catch (error) {
    console.log(`\n=== ${label} -> ERROR ${error.message}`);
    return null;
  }
}

if (provider !== undefined && model !== undefined) {
  await post({ text, provider, model, count: 3, sessionId: 'probe-session' }, `${provider} / ${model}`);
} else {
  // 不给 provider/model：先看参数校验
  await post({ text, count: 3 }, '缺 provider/model');
  await post({ text, provider: 'custom:tr', model: 'deepseek-v4-flash-0731', count: 3, sessionId: 'probe-session' }, 'custom:tr / deepseek-v4-flash-0731');
}
