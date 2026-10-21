// WebSocket relay between the browser and xAI's Grok Voice Agent API.
// The browser never sees the API key: it talks to this server, which opens
// the upstream connection, configures the tutor session, and pipes events.

import WebSocket from 'ws';
import { buildTutorInstructions, LANGUAGES, LEVELS, TOPICS, VOICES } from './prompts.js';

// Event types the browser is allowed to send upstream. Session configuration
// stays server-side so a client cannot swap the instructions or model.
const CLIENT_EVENT_ALLOWLIST = new Set([
  'input_audio_buffer.append',
  'response.cancel',
  'conversation.item.truncate',
]);

export const SAMPLE_RATE = 24000;

function parseOptions(searchParams) {
  const pick = (key, allowed, fallback) => {
    const value = searchParams.get(key);
    return allowed.includes(value) ? value : fallback;
  };
  return {
    language: pick('language', Object.keys(LANGUAGES), 'en'),
    level: pick('level', Object.keys(LEVELS), 'intermediate'),
    topic: pick('topic', [...Object.keys(TOPICS), 'custom'], 'free'),
    customTopic: (searchParams.get('customTopic') ?? '').slice(0, 200),
    voice: pick('voice', VOICES, 'eve'),
    correction: pick('correction', ['gentle', 'active'], 'gentle'),
  };
}

export function handleCall(client, req, config) {
  const options = parseOptions(new URL(req.url, 'http://localhost').searchParams);
  const upstreamUrl = `${config.realtimeUrl}?model=${encodeURIComponent(config.voiceModel)}`;
  const upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });

  let ready = false;
  let closed = false;
  const tag = `[call ${Math.random().toString(36).slice(2, 8)}]`;
  console.log(`${tag} start`, options);

  const sendClient = (event) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
  };
  const sendUpstream = (event) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event));
  };

  const hangUp = (reason) => {
    if (closed) return;
    closed = true;
    clearTimeout(maxDurationTimer);
    console.log(`${tag} end: ${reason}`);
    sendClient({ type: 'relay.ended', reason });
    upstream.close();
    client.close();
  };

  const maxDurationTimer = setTimeout(
    () => hangUp('max_duration'),
    config.maxCallMinutes * 60 * 1000,
  );

  upstream.on('open', () => {
    sendUpstream({
      type: 'session.update',
      session: {
        instructions: buildTutorInstructions(options),
        voice: options.voice,
        turn_detection: {
          type: 'server_vad',
          // Learners pause to think mid-sentence; wait a bit longer than the
          // default before treating silence as the end of their turn.
          silence_duration_ms: options.level === 'beginner' ? 1200 : 800,
        },
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
            transcription: { model: 'grok-transcribe' },
          },
          output: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          },
        },
      },
    });
  });

  upstream.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (event.type === 'session.updated' && !ready) {
      ready = true;
      sendClient({ type: 'relay.ready', sampleRate: SAMPLE_RATE, voice: options.voice });
      // Let the tutor speak first, like answering a scheduled call.
      sendUpstream({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '(The call has just connected.)' }],
        },
      });
      sendUpstream({ type: 'response.create' });
      return;
    }

    if (event.type === 'error') console.warn(`${tag} upstream error`, event.error ?? event);
    sendClient(event);
  });

  upstream.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      console.error(`${tag} upstream rejected: ${res.statusCode} ${body}`);
      sendClient({
        type: 'relay.error',
        message: `xAI 연결 실패 (HTTP ${res.statusCode}). API 키와 모델 이름을 확인하세요.`,
      });
      hangUp('upstream_rejected');
    });
  });
  upstream.on('error', (err) => {
    console.error(`${tag} upstream socket error`, err.message);
    sendClient({ type: 'relay.error', message: `xAI 연결 오류: ${err.message}` });
    hangUp('upstream_error');
  });
  upstream.on('close', () => hangUp('upstream_closed'));

  client.on('message', (data) => {
    if (!ready) return;
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (CLIENT_EVENT_ALLOWLIST.has(event?.type)) sendUpstream(event);
  });
  client.on('close', () => hangUp('client_closed'));
  client.on('error', () => hangUp('client_error'));
}
