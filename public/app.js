import { Microphone, Player } from './audio.js';

const $ = (selector) => document.querySelector(selector);

const LANGUAGE_LABELS = {
  en: '영어', ja: '일본어', zh: '중국어', es: '스페인어', fr: '프랑스어', de: '독일어',
};

const state = {
  ws: null,
  ctx: null,
  mic: null,
  player: null,
  options: null,
  responseActive: false,
  startedAt: 0,
  timer: null,
  rafId: null,
  // Ordered transcript entries: { itemId, role, text, el }
  turns: [],
  turnsById: new Map(),
  endedReason: null,
};

function showScreen(name) {
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.dataset.screen !== name;
}

function setStatus(text) {
  $('#call-status').textContent = text;
}

function showError(message) {
  const el = $('#call-error');
  el.textContent = message;
  el.hidden = false;
}

function readOptions() {
  const form = new FormData($('#setup-form'));
  return {
    language: form.get('language'),
    level: form.get('level'),
    topic: form.get('topic'),
    customTopic: (form.get('customTopic') ?? '').trim(),
    voice: form.get('voice'),
    correction: form.get('correction'),
  };
}

// ---------- transcript ----------

function upsertTurn(itemId, role, text, { append = false, final = false } = {}) {
  let turn = state.turnsById.get(itemId);
  if (!turn) {
    const el = document.createElement('div');
    el.className = `bubble ${role}`;
    turn = { itemId, role, text: '', el };
    state.turns.push(turn);
    state.turnsById.set(itemId, turn);
    $('#transcript').append(el);
  }
  turn.text = append ? turn.text + text : text;
  turn.el.textContent = turn.text || '…';
  turn.el.classList.toggle('interim', role === 'user' && !final);
  const box = $('#transcript');
  box.scrollTop = box.scrollHeight;
}

function transcriptForFeedback() {
  return state.turns
    .filter((t) => t.text.trim())
    .map((t) => ({ role: t.role, text: t.text.trim() }));
}

// ---------- call lifecycle ----------

async function startCall() {
  state.options = readOptions();
  state.turns = [];
  state.turnsById = new Map();
  state.endedReason = null;
  state.responseActive = false;
  $('#transcript').replaceChildren();
  $('#call-error').hidden = true;
  $('#tutor-name').textContent = capitalize(state.options.voice);
  $('#tutor-lang').textContent = `${LANGUAGE_LABELS[state.options.language]} 튜터`;
  $('#call-timer').textContent = '00:00';
  $('#mute-btn').classList.remove('active');
  $('#mute-btn span').textContent = '음소거';
  showScreen('call');
  setStatus('연결 중…');

  // Must be created inside the click handler so the browser allows audio.
  state.ctx = new AudioContext();

  const params = new URLSearchParams(state.options);
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/call?${params}`);
  state.ws = ws;

  ws.onmessage = (msg) => handleServerEvent(JSON.parse(msg.data));
  ws.onclose = () => {
    if (state.ws === ws) endCall();
  };
  ws.onerror = () => showError('서버에 연결하지 못했어요.');
}

async function onReady(sampleRate) {
  state.player = new Player(state.ctx, sampleRate);
  state.mic = new Microphone(state.ctx, sampleRate, (audio) => {
    send({ type: 'input_audio_buffer.append', audio });
  });
  try {
    await state.mic.start();
  } catch (err) {
    showError('마이크를 사용할 수 없어요. 브라우저의 마이크 권한을 확인해주세요.');
    endCall();
    return;
  }
  state.startedAt = Date.now();
  state.timer = setInterval(updateTimer, 500);
  tick();
}

function updateTimer() {
  const sec = Math.floor((Date.now() - state.startedAt) / 1000);
  $('#call-timer').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function tick() {
  const speaking = state.player?.isPlaying;
  setStatus(speaking ? '튜터가 말하는 중' : state.mic?.muted ? '음소거됨' : '듣고 있어요');
  $('#avatar').classList.toggle('speaking', Boolean(speaking));
  const level = Math.min(1, (state.mic?.level ?? 0) * 3);
  $('#mic-ring').style.transform = `scale(${1 + level * 0.35})`;
  $('#mic-ring').style.opacity = String(0.15 + level * 0.6);
  state.rafId = requestAnimationFrame(tick);
}

function send(event) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(event));
}

function bargeIn() {
  if (!state.player?.isPlaying) return;
  const heard = state.player.interrupt();
  if (state.responseActive) send({ type: 'response.cancel' });
  if (heard) {
    send({
      type: 'conversation.item.truncate',
      item_id: heard.itemId,
      content_index: 0,
      audio_end_ms: heard.playedMs,
    });
  }
}

function handleServerEvent(event) {
  switch (event.type) {
    case 'relay.ready':
      onReady(event.sampleRate);
      break;
    case 'relay.error':
      showError(event.message);
      break;
    case 'relay.ended':
      state.endedReason = event.reason;
      break;
    case 'input_audio_buffer.speech_started':
      bargeIn();
      // Reserve the learner's bubble now so it stays above the tutor's reply.
      upsertTurn(event.item_id, 'user', '');
      break;
    case 'conversation.item.input_audio_transcription.updated':
      upsertTurn(event.item_id, 'user', event.transcript);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      upsertTurn(event.item_id, 'user', event.transcript, { final: true });
      break;
    case 'response.created':
      state.responseActive = true;
      break;
    case 'response.done':
      state.responseActive = false;
      break;
    case 'response.output_audio.delta':
      state.player?.enqueue(event.delta, event.item_id);
      break;
    case 'response.output_audio_transcript.delta':
      upsertTurn(event.item_id, 'assistant', event.delta, { append: true });
      break;
    case 'error': {
      const code = event.error?.code ?? '';
      if (code === 'response_cancel_not_active') break;
      console.warn('server error', event);
      showError(event.error?.message ?? '알 수 없는 오류가 발생했어요.');
      break;
    }
    default:
      break;
  }
}

function endCall() {
  if (!state.ws) return;
  const ws = state.ws;
  state.ws = null;
  ws.close();
  clearInterval(state.timer);
  cancelAnimationFrame(state.rafId);
  state.mic?.stop();
  state.player?.interrupt();
  state.ctx?.close();
  state.mic = null;
  state.player = null;
  state.ctx = null;
  showFeedback();
}

// ---------- feedback ----------

async function showFeedback() {
  showScreen('feedback');
  const turns = transcriptForFeedback();
  const duration = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
  $('#feedback-meta').textContent =
    `${LANGUAGE_LABELS[state.options.language]} · ${Math.floor(duration / 60)}분 ${duration % 60}초 · 발화 ${turns.filter((t) => t.role === 'user').length}회`
    + (state.endedReason === 'max_duration' ? ' · 최대 통화 시간에 도달했어요' : '');
  $('#feedback-body').innerHTML = '<p class="muted">튜터가 대화를 검토하고 있어요…</p>';
  renderTranscript(turns);
  state.startedAt = 0;

  if (!turns.some((t) => t.role === 'user')) {
    $('#feedback-body').innerHTML = '<p class="muted">대화 기록이 없어 피드백을 만들 수 없어요.</p>';
    return;
  }

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: state.options.language, level: state.options.level, transcript: turns }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    renderFeedback(await res.json());
  } catch (err) {
    $('#feedback-body').innerHTML = '';
    $('#feedback-body').append(el('p', 'muted', err.message || '피드백을 불러오지 못했어요.'));
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderFeedback(fb) {
  const body = $('#feedback-body');
  body.replaceChildren();
  if (fb.summary) body.append(el('p', 'summary', fb.summary));

  if (fb.corrections.length) {
    body.append(el('h3', null, '이렇게 말하면 더 자연스러워요'));
    for (const c of fb.corrections) {
      const card = el('div', 'card');
      card.append(el('div', 'original', c.original ?? ''), el('div', 'better', c.better ?? ''), el('div', 'explain', c.explanation ?? ''));
      body.append(card);
    }
  }

  if (fb.expressions.length) {
    body.append(el('h3', null, '오늘의 표현'));
    const list = el('ul', 'expressions');
    for (const e of fb.expressions) {
      const li = el('li');
      li.append(el('strong', null, e.phrase ?? ''), el('span', null, e.meaning ?? ''));
      list.append(li);
    }
    body.append(list);
  }

  if (fb.encouragement) body.append(el('p', 'encourage', fb.encouragement));
}

function renderTranscript(turns) {
  const box = $('#feedback-transcript');
  box.replaceChildren(...turns.map((t) => el('div', `bubble ${t.role}`, t.text)));
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- wiring ----------

$('#setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  startCall();
});
$('#topic').addEventListener('change', (e) => {
  $('#custom-topic-field').hidden = e.target.value !== 'custom';
});
$('#hangup-btn').addEventListener('click', endCall);
$('#mute-btn').addEventListener('click', (e) => {
  if (!state.mic) return;
  state.mic.muted = !state.mic.muted;
  e.currentTarget.classList.toggle('active', state.mic.muted);
  e.currentTarget.querySelector('span').textContent = state.mic.muted ? '음소거 해제' : '음소거';
});
$('#again-btn').addEventListener('click', () => showScreen('setup'));
