import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createAuth } from './auth.js';
import { createDb, createMemoryDb } from './db.js';
import { handleCall, parseOptions } from './relay.js';
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

// Shorter calls aren't worth connecting for; the learner is told they're out of time.
const MIN_CALL_SECONDS = 30;

const { GOOGLE_CLIENT_ID, DATABASE_URL } = process.env;
if (Boolean(GOOGLE_CLIENT_ID) !== Boolean(DATABASE_URL)) {
  console.error('로그인을 쓰려면 GOOGLE_CLIENT_ID와 DATABASE_URL을 둘 다 설정하세요. (로컬 개발은 둘 다 비워두면 돼요)');
  process.exit(1);
}
const freeTrialMinutes = Number(process.env.FREE_TRIAL_MINUTES || 10);
const freeTrialSeconds = Number.isFinite(freeTrialMinutes) ? Math.max(0, Math.round(freeTrialMinutes * 60)) : 600;
const db = DATABASE_URL ? await createDb(DATABASE_URL) : createMemoryDb();
const auth = createAuth({ googleClientId: GOOGLE_CLIENT_ID, db, freeTrialSeconds });
if (!auth.enabled && process.env.RENDER) {
  console.warn('로그인이 꺼져 있어 누구나 접속해 API 키를 쓸 수 있습니다. 배포 환경에서는 GOOGLE_CLIENT_ID와 DATABASE_URL을 설정하세요.');
}

// One call per account at a time: user id -> the running call (null while it starts).
const activeCalls = new Map();
// Calls whose record is still being written: call id -> promise.
const finishingCalls = new Map();
// Reports being generated, so a retry doesn't pay for a second one: 'user:call' -> promise.
const pendingFeedback = new Map();

function publicUser(user) {
  if (!user) return null;
  return {
    email: user.email,
    name: user.name,
    picture: user.picture,
    // null means unlimited (local development).
    balanceSeconds: Number.isFinite(user.balanceSeconds) ? user.balanceSeconds : null,
  };
}

// Cookies are SameSite=Lax, but also refuse cross-site POSTs and WebSockets outright.
function isSameOrigin(req) {
  const { origin } = req.headers;
  if (!origin) return req.method === 'GET';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
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

async function readJson(req, limit = 64 * 1024) {
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
  // Health check for the hosting platform; must not require the password.
  if (req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.url.startsWith('/api/')) {
    try {
      await handleApi(req, res);
    } catch (err) {
      console.error(`${req.method} ${req.url} failed:`, err.message);
      if (!res.headersSent) sendJson(res, 500, { error: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
    }
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(req, res);
    return;
  }
  res.writeHead(405).end();
});

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function handleApi(req, res) {
  const route = `${req.method} ${new URL(req.url, 'http://localhost').pathname}`;
  if (req.method === 'POST' && !isSameOrigin(req)) {
    sendJson(res, 403, { error: '허용되지 않은 요청이에요.' });
    return;
  }

  if (route === 'GET /api/config') {
    sendJson(res, 200, {
      provider: provider.id,
      voices: provider.voices,
      googleClientId: auth.googleClientId,
      freeTrialMinutes: auth.enabled ? freeTrialSeconds / 60 : 0,
      minCallSeconds: MIN_CALL_SECONDS,
      maxCallMinutes: config.maxCallMinutes,
    });
    return;
  }
  if (route === 'POST /api/auth/google' && auth.enabled) {
    const { credential } = await readJson(req);
    let user;
    try {
      user = await auth.login(req, res, credential);
    } catch (err) {
      console.warn('google login rejected:', err.message);
      sendJson(res, 401, { error: 'Google 로그인을 확인하지 못했어요. 다시 시도해주세요.' });
      return;
    }
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }
  if (route === 'POST /api/auth/logout' && auth.enabled) {
    await auth.logout(req, res);
    sendJson(res, 200, { ok: true });
    return;
  }

  const user = await auth.userFromRequest(req);
  if (route === 'GET /api/me') {
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }
  if (!user) {
    sendJson(res, 401, { error: '로그인이 필요해요.' });
    return;
  }
  if (route === 'POST /api/feedback') {
    const { callId } = await readJson(req);
    const id = String(callId ?? '');
    const key = `${user.id}:${id}`;
    if (!pendingFeedback.has(key)) {
      pendingFeedback.set(key, feedbackForCall(id, user).finally(() => pendingFeedback.delete(key)));
    }
    try {
      const feedback = await pendingFeedback.get(key);
      if (feedback) sendJson(res, 200, feedback);
      else sendJson(res, 404, { error: '통화 기록을 찾지 못했어요.' });
    } catch (err) {
      console.error('feedback failed:', err.message);
      sendJson(res, 502, { error: '피드백 생성에 실패했어요.' });
    }
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

// Reports are made from the transcript the server recorded and generated once per call.
async function feedbackForCall(callId, user) {
  await finishingCalls.get(callId);
  const call = await db.getCall(callId, user.id);
  if (!call?.transcript) return null;
  if (call.feedback) return call.feedback;
  const feedback = await generateFeedback({
    language: call.options.language,
    level: call.options.level,
    transcript: call.transcript,
  }, config);
  await db.saveFeedback(callId, feedback);
  return feedback;
}

async function startCall(client, req, user) {
  const refuse = (message) => {
    client.send(JSON.stringify({ type: 'relay.error', message }));
    client.close();
  };
  if (activeCalls.has(user.id)) {
    refuse('이미 다른 창에서 통화 중이에요. 그 통화를 끊고 다시 걸어주세요.');
    return;
  }
  if (user.balanceSeconds < MIN_CALL_SECONDS) {
    refuse('남은 통화 시간이 없어요.');
    return;
  }

  activeCalls.set(user.id, null);
  const options = parseOptions(new URL(req.url, 'http://localhost').searchParams, provider.voices);
  let callId;
  try {
    callId = await db.startCall(user.id, provider.id, options);
  } catch (err) {
    activeCalls.delete(user.id);
    console.error('could not create call record:', err.message);
    refuse('통화를 시작하지 못했어요. 잠시 후 다시 걸어주세요.');
    return;
  }

  const maxSeconds = config.maxCallMinutes * 60;
  const limitSeconds = Math.min(maxSeconds, user.balanceSeconds);
  const call = handleCall(client, {
    options,
    callId,
    limitSeconds,
    limitReason: limitSeconds < maxSeconds ? 'out_of_minutes' : 'max_duration',
    onEnd(result) {
      activeCalls.delete(user.id);
      const saving = db.finishCall(callId, result)
        .catch((err) => console.error(`[call ${callId}] could not save:`, err.message))
        .finally(() => finishingCalls.delete(callId));
      finishingCalls.set(callId, saving);
    },
  }, config);
  if (activeCalls.has(user.id)) activeCalls.set(user.id, call);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', async (req, socket, head) => {
  if (!req.url.startsWith('/call') || !isSameOrigin(req)) {
    socket.destroy();
    return;
  }
  let user;
  try {
    user = await auth.userFromRequest(req);
  } catch (err) {
    console.error('session lookup failed:', err.message);
  }
  if (!user) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    startCall(client, req, user).catch((err) => {
      console.error('call failed to start:', err.message);
      client.close();
    });
  });
});

// Hosting platforms stop the old instance on every deploy: end its calls
// first so they're billed and their transcripts saved.
async function shutdown(signal) {
  console.log(`${signal}: ending ${activeCalls.size} call(s)`);
  server.close();
  for (const call of activeCalls.values()) call?.hangUp('server_shutdown');
  await Promise.allSettled(finishingCalls.values());
  await db.close();
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(config.port, () => {
  const login = auth.enabled ? 'Google 로그인' : '로그인 없음(로컬 개발)';
  console.log(`LangTutor running at http://localhost:${config.port} (${provider.id}: ${config.providerConfig.voiceModel}, ${login})`);
});
