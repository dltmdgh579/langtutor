// WebSocket relay between the browser and the voice provider (currently Gemini Live).
// The browser never sees the API key: it talks to this server, which opens
// the upstream connection, configures the tutor session, and pipes events.
// The browser always speaks OpenAI-Realtime-style events; each provider
// adapter translates to and from its own protocol.

import WebSocket from 'ws';
import { buildTutorInstructions, LANGUAGES, LEVELS, TOPICS } from './prompts.js';

// How long the provider may take to set up the session before we give up.
const CONNECT_TIMEOUT_MS = 20_000;

// A minute before the call is cut off, the tutor is told to wrap up. Calls too
// short for that (a nearly empty balance) just end.
const WRAP_UP_LEAD_SECONDS = 60;
const MIN_SECONDS_FOR_WRAP_UP = 90;
// The note starts a tutor turn, so it waits for a pause: the tutor done talking
// and the learner quiet this long. A learner who keeps talking gets it anyway
// after WRAP_UP_FORCE_MS, at the end of the tutor's next reply.
const WRAP_UP_PAUSE_MS = 1200;
const WRAP_UP_FORCE_MS = 25_000;
const WRAP_UP_NOTE = `[Call note] About one minute of this call is left. Now, in one or two short sentences: let the learner know warmly that you're almost out of time, mention one thing they did well today, and say goodbye. If they reply, answer in one short sentence and end the call warmly.`;

// Event types the browser is allowed to send upstream. Session configuration
// stays server-side so a client cannot swap the instructions or model.
const CLIENT_EVENT_ALLOWLIST = new Set([
  'input_audio_buffer.append',
  'response.cancel',
  'conversation.item.truncate',
]);

export function parseOptions(searchParams, voices) {
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

// Builds the conversation from the same events the browser renders captions
// from, so the stored transcript doesn't depend on what the client sends back.
function createTranscript() {
  const turns = new Map(); // item_id -> { role, text }, in conversation order
  const turn = (id, role) => {
    if (!turns.has(id)) turns.set(id, { role, text: '' });
    return turns.get(id);
  };
  return {
    record(event) {
      switch (event.type) {
        case 'input_audio_buffer.speech_started':
          // Reserve the learner's turn now so it stays above the tutor's reply.
          turn(event.item_id, 'user');
          break;
        case 'conversation.item.input_audio_transcription.updated':
        case 'conversation.item.input_audio_transcription.completed':
          turn(event.item_id, 'user').text = event.transcript ?? '';
          break;
        case 'response.output_audio_transcript.delta':
          turn(event.item_id, 'assistant').text += event.delta ?? '';
          break;
        default:
          break;
      }
    },
    toJSON() {
      return [...turns.values()]
        .map((t) => ({ role: t.role, text: t.text.trim() }))
        .filter((t) => t.text);
    },
  };
}

// Sends the wrap-up note once it's due, at the next pause in the conversation,
// so the tutor isn't cut off mid-sentence and doesn't talk over the learner.
// Watches the same events the browser gets.
function createWrapUp(deliver) {
  let due = false;
  // Past WRAP_UP_FORCE_MS the learner's speech no longer holds the note back.
  let forced = false;
  let sent = false;
  let tutorTalking = false;
  let learnerTalking = false;
  let pauseTimer = null;
  let forceTimer = null;

  const send = () => {
    if (sent) return;
    sent = true;
    clearTimeout(pauseTimer);
    clearTimeout(forceTimer);
    deliver();
  };
  const check = () => {
    clearTimeout(pauseTimer);
    if (!due || sent || tutorTalking) return;
    if (forced) send();
    else if (!learnerTalking) pauseTimer = setTimeout(send, WRAP_UP_PAUSE_MS);
  };

  return {
    due() {
      due = true;
      forceTimer = setTimeout(() => {
        forced = true;
        check();
      }, WRAP_UP_FORCE_MS);
      check();
    },
    observe(event) {
      switch (event.type) {
        case 'response.created':
          tutorTalking = true;
          learnerTalking = false;
          break;
        case 'response.done':
          // Also sent when the learner barges in; their speech follows in the same message.
          tutorTalking = false;
          learnerTalking = false;
          break;
        case 'input_audio_buffer.speech_started':
        case 'conversation.item.input_audio_transcription.updated':
          // Transcripts can trail into the tutor's reply; only count them while the tutor is quiet.
          if (!tutorTalking) learnerTalking = true;
          break;
        default:
          return;
      }
      // Wait for the rest of the provider's message, e.g. a barge-in's speech_started.
      setImmediate(check);
    },
    stop() {
      sent = true;
      clearTimeout(pauseTimer);
      clearTimeout(forceTimer);
    },
  };
}

// limitSeconds (counted from the tutor picking up, like billing) cuts the call
// off, reported to the browser as limitReason; onEnd receives the billed
// seconds and transcript exactly once. It doesn't throw: a call that fails to
// start ends as 'start_failed'.
export function handleCall(client, { options, callId, limitSeconds, limitReason, onEnd }, { provider, providerConfig }) {
  let upstream = null;
  let ready = false;
  let closed = false;
  let answeredAt = 0;
  const transcript = createTranscript();
  const tag = `[call ${callId}]`;
  console.log(`${tag} start (${provider.id})`, options);
  let wrapUpTimer = null;
  const wrapUp = createWrapUp(() => {
    console.log(`${tag} asking the tutor to wrap up`);
    session.instruct(WRAP_UP_NOTE);
  });

  const sendClient = (event) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
  };
  const sendUpstream = (event) => {
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event));
  };

  let limitTimer = setTimeout(() => {
    sendClient({ type: 'relay.error', message: '튜터와 연결하지 못했어요. 잠시 후 다시 걸어주세요.' });
    hangUp('connect_timeout');
  }, CONNECT_TIMEOUT_MS);

  function hangUp(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(limitTimer);
    clearTimeout(wrapUpTimer);
    wrapUp.stop();
    // Billing starts when the tutor's session is ready, so failed calls are free.
    const billedSeconds = answeredAt ? Math.ceil((Date.now() - answeredAt) / 1000) : 0;
    console.log(`${tag} end: ${reason} (${billedSeconds}s)`);
    sendClient({ type: 'relay.ended', reason });
    upstream?.close();
    client.close();
    onEnd({ billedSeconds, reason, transcript: transcript.toJSON() });
  }

  // The upstream socket is opened last and gets its listeners straight away,
  // so a setup error can't leave it (or the connect timer) running unattended.
  let session;
  try {
    session = provider.createSession({
      options,
      instructions: buildTutorInstructions(options),
      config: providerConfig,
      sendUpstream,
      emit: (event) => {
        if (event.type === 'error') console.warn(`${tag} upstream error`, event.error ?? event);
        transcript.record(event);
        wrapUp.observe(event);
        sendClient(event);
      },
      ready: ({ inputSampleRate, outputSampleRate }) => {
        ready = true;
        answeredAt = Date.now();
        clearTimeout(limitTimer);
        limitTimer = setTimeout(() => hangUp(limitReason), limitSeconds * 1000);
        if (limitSeconds >= MIN_SECONDS_FOR_WRAP_UP) {
          wrapUpTimer = setTimeout(() => {
            sendClient({ type: 'relay.time_left', seconds: WRAP_UP_LEAD_SECONDS, reason: limitReason });
            wrapUp.due();
          }, (limitSeconds - WRAP_UP_LEAD_SECONDS) * 1000);
        }
        sendClient({ type: 'relay.ready', inputSampleRate, outputSampleRate, voice: options.voice, callId });
      },
    });
    const { url, headers } = provider.connection(providerConfig);
    upstream = new WebSocket(url, { headers });
  } catch (err) {
    console.error(`${tag} failed to start:`, err.message);
    sendClient({ type: 'relay.error', message: '통화를 시작하지 못했어요. 잠시 후 다시 걸어주세요.' });
    hangUp('start_failed');
    return { hangUp };
  }

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
  // The browser may have left while the call record was being created.
  if (client.readyState !== WebSocket.OPEN) hangUp('client_closed');

  return { hangUp };
}
