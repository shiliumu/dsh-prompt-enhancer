/**
 * 通过 DSH Desktop 的命名管道直接探测 Host 路由，用来验证 Host 侧插件是否真的加载了。
 *
 * 用法： node test/probe-pipe.mjs "\\.\pipe\dsh-desktop-xxxx"
 *
 * 判定：
 *   POST /prompt-enhancer/enhance  -> 400 {"error":"草稿是空的"}  表示路由已注册（插件已加载）
 *   404 / 无该路由                                             表示 Host 还没加载插件
 */
import net from 'node:net';

const pipePath = process.argv[2];
if (!pipePath) {
  console.error('usage: node test/probe-pipe.mjs "\\\\.\\pipe\\dsh-desktop-xxxx"');
  process.exit(2);
}

/** 在管道上发一条原始 HTTP 请求，返回响应文本。 */
function request(raw) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(buffer === '' ? '<timeout, no bytes>' : buffer);
    }, 8000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(raw));
    socket.on('data', (chunk) => {
      buffer += chunk;
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(buffer);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(buffer);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const firstLine = (text) => (text.split('\r\n')[0] || text.slice(0, 80)).trim();
const bodyOf = (text) => {
  const index = text.indexOf('\r\n\r\n');
  return index < 0 ? '' : text.slice(index + 4).trim();
};

const cases = [
  {
    label: 'GET  /prompt-enhancer/enhance   (期望 405 = 路由存在)',
    raw: 'GET /prompt-enhancer/enhance HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
  },
  {
    label: 'POST /prompt-enhancer/enhance   (期望 400 = 路由存在，报“草稿是空的”)',
    raw: 'POST /prompt-enhancer/enhance HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
  },
  {
    label: 'GET  /prompt-enhancer/nope      (期望 404 = 对照组)',
    raw: 'GET /prompt-enhancer/nope HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
  },
];

for (const item of cases) {
  try {
    const response = await request(item.raw);
    console.log(`${item.label}\n    -> ${firstLine(response)}\n       ${bodyOf(response).slice(0, 200)}`);
  } catch (error) {
    console.log(`${item.label}\n    -> ERROR ${error.message}`);
  }
}
