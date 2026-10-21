import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { handleCall } from './relay.js';
import { generateFeedback } from './feedback.js';
import { PROVIDERS } from './providers/index.js';

const providerId = process.env.VOICE_PROVIDER || 'gemini';
const provider = PROVIDERS[providerId];
if (!provider) {
  console.error(`알 수 없는 VOICE_PROVIDER: ${providerId} (사용 가능: ${Object.keys(PROVIDERS).join(', ')})`);
  process.exit(1);
}

const config = {
  provider,
  providerConfig: provider.readConfig(process.env),
  maxCallMinutes: Number(process.env.MAX_CALL_MINUTES) || 15,
  port: Number(process.env.PORT) || 3000,
};

if (!config.providerConfig.apiKey) {
  console.error(`${provider.apiKeyEnv}가 설정되지 않았습니다. .env.example을 .env로 복사하고 키를 넣어주세요.`);
  process.exit(1);
}

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const filePath = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!filePath.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

async function readJson(req, limit = 512 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ provider: provider.id, voices: provider.voices }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/feedback') {
    try {
      const feedback = await generateFeedback(await readJson(req), config);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(feedback));
    } catch (err) {
      console.error('feedback failed:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: '피드백 생성에 실패했어요.' }));
    }
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(req, res);
    return;
  }
  res.writeHead(405).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/call')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => handleCall(client, req, config));
});

server.listen(config.port, () => {
  console.log(`LangTutor running at http://localhost:${config.port} (${provider.id}: ${config.providerConfig.voiceModel})`);
});
