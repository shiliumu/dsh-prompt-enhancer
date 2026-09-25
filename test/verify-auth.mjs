/**
 * 摸清 dsh web 的浏览器信任栅栏，拿到客户端模块清单。
 * 用法: node test/verify-auth.mjs http://127.0.0.1:3999 <token>
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3999';
const token = process.argv[3] ?? '';

const show = async (label, path, init = {}) => {
  const url = new URL(path, base);
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    console.log(`\n--- ${label}\n    ${response.status} ${response.headers.get('content-type') ?? ''}`);
    for (const [key, value] of response.headers) {
      if (key.startsWith('set-cookie') || key === 'location' || key === 'www-authenticate') console.log(`    ${key}: ${value}`);
    }
    console.log(`    ${text.slice(0, 300).replace(/\n/g, ' ')}`);
    return { status: response.status, text, response };
  } catch (error) {
    console.log(`\n--- ${label}\n    ERROR ${error.message}`);
    return { status: 0, text: '', response: null };
  }
};

const browserish = {
  origin: base,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-verify',
};

console.log('token =', token);
await show('GET / (no token)', '/', { headers: browserish });
await show('GET /?token', `/?token=${token}`, { headers: browserish });
await show('GET /api/client/modules?token', `/api/client/modules?token=${token}`, { headers: browserish });
await show('GET /api/client/modules + Bearer', '/api/client/modules', {
  headers: { ...browserish, authorization: `Bearer ${token}` },
});
await show('GET /api/client/modules + x-dsh-token', '/api/client/modules', {
  headers: { ...browserish, 'x-dsh-token': token },
});
await show('GET /api/client/modules + cookie', '/api/client/modules', {
  headers: { ...browserish, cookie: `dsh_token=${token}; token=${token}` },
});
await show('GET /health', '/health', { headers: browserish });
