// WebSocket relay between the browser and the voice provider (Grok or Gemini).
// The browser never sees the API key: it talks to this server, which opens
// the upstream connection, configures the tutor session, and pipes events.
// The browser always speaks OpenAI-Realtime-style events; each provider
// adapter translates to and from its own protocol.

import WebSocket from 'ws';
import { buildTutorInstructions, LANGUAGES, LEVELS, TOPICS } from './prompts.js';

// Event types the browser is allowed to send upstream. Session configuration
// stays server-side so a client cannot swap the instructions or model.
const CLIENT_EVENT_ALLOWLIST = new Set([
  'input_audio_buffer.append',
  'response.cancel',
  'conversation.item.truncate',
]);

function parseOptions(searchParams, voices) {
  const pick = (key, allowed, fallback) => {
    const value = searchParams.get(key);
    return allowed.includes(value) ? value : fallback;
  };
  return {
    language: pick('language', Object.keys(LANGUAGES), 'en'),
    level: pick('level', Object.keys(LEVELS), 'intermediate'),
    topic: pick('topic', [...Object.keys(TOPICS), 'custom'], 'free'),
    customTopic: (searchParams.get('customTopic') ?? '').slice(0, 200),
    voice: pick('voice', voices, voices[0]),
    correction: pick('correction', ['gentle', 'active'], 'gentle'),
  };
}

export function handleCall(client, req, { provider, providerConfig, maxCallMinutes }) {
  const options = parseOptions(new URL(req.url, 'http://localhost').searchParams, provider.voices);
  const { url, headers } = provider.connection(providerConfig);
  const upstream = new WebSocket(url, { headers });

  let ready = false;
  let closed = false;
  const tag = `[call ${Math.random().toString(36).slice(2, 8)}]`;
  console.log(`${tag} start (${provider.id})`, options);

  const sendClient = (event) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
  };
  const sendUpstream = (event) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event));
  };

  const maxDurationTimer = setTimeout(() => hangUp('max_duration'), maxCallMinutes * 60 * 1000);

  function hangUp(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(maxDurationTimer);
    console.log(`${tag} end: ${reason}`);
    sendClient({ type: 'relay.ended', reason });
    upstream.close();
    client.close();
  }

  const session = provider.createSession({
    options,
    instructions: buildTutorInstructions(options),
    config: providerConfig,
    sendUpstream,
    emit: (event) => {
      if (event.type === 'error') console.warn(`${tag} upstream error`, event.error ?? event);
      sendClient(event);
    },
    ready: ({ inputSampleRate, outputSampleRate }) => {
      ready = true;
      sendClient({ type: 'relay.ready', inputSampleRate, outputSampleRate, voice: options.voice });
    },
  });

  upstream.on('open', () => session.onOpen());

  upstream.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    session.onMessage(event);
  });

  upstream.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      console.error(`${tag} upstream rejected: ${res.statusCode} ${body}`);
      sendClient({
        type: 'relay.error',
        message: `${provider.id} 연결 실패 (HTTP ${res.statusCode}). API 키와 모델 이름을 확인하세요.`,
      });
      hangUp('upstream_rejected');
    });
  });
  upstream.on('error', (err) => {
    console.error(`${tag} upstream socket error`, err.message);
    sendClient({ type: 'relay.error', message: `${provider.id} 연결 오류: ${err.message}` });
    hangUp('upstream_error');
  });
  upstream.on('close', (code, reasonBuffer) => {
    // Gemini reports setup problems (bad model name, quota) as a close reason.
    const reason = reasonBuffer.toString();
    if (!closed && code !== 1000) {
      console.error(`${tag} upstream closed: ${code} ${reason}`);
      sendClient({ type: 'relay.error', message: `${provider.id} 연결 종료 (${code}): ${reason || '이유 없음'}` });
    }
    hangUp('upstream_closed');
  });

  client.on('message', (data) => {
    if (!ready) return;
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (CLIENT_EVENT_ALLOWLIST.has(event?.type)) session.onClientEvent(event);
  });
  client.on('close', () => hangUp('client_closed'));
  client.on('error', () => hangUp('client_error'));
}
