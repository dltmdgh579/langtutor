import { Microphone, Player } from './audio.js';

const $ = (selector) => document.querySelector(selector);

const LANGUAGE_LABELS = {
  en: '영어', ja: '일본어', zh: '중국어', es: '스페인어', fr: '프랑스어', de: '독일어',
};
const LEVEL_LABELS = { beginner: '초급', intermediate: '중급', advanced: '고급' };
const TOPIC_LABELS = {
  free: '자유 대화', daily: '일상 · 취미', travel: '여행 상황극', business: '비즈니스', interview: '면접 연습',
};
const CORRECTION_LABELS = { gentle: '자연스럽게', active: '적극적으로' };
// Browser text-to-speech languages for the report's "listen" buttons.
const SPEECH_LANGS = { en: 'en-US', ja: 'ja-JP', zh: 'zh-CN', es: 'es-ES', fr: 'fr-FR', de: 'de-DE' };
// Languages written without spaces are diffed per character instead of per word.
const UNSPACED_LANGUAGES = new Set(['ja', 'zh']);

// Persona for each provider voice. The portraits in
// /tutors are Open Peeps by Pablo Stanley (CC0), generated with DiceBear.
const TUTORS = {
  kore: { trait: '또렷하고 차분한', tile: '#dce5f9' },
  puck: { trait: '밝고 경쾌한', tile: '#fbefc4' },
  aoede: { trait: '산뜻하고 편안한', tile: '#d3eeee' },
  charon: { trait: '차분한 설명형', tile: '#d8f0da' },
  leda: { trait: '젊고 생기 있는', tile: '#f6dcef' },
  orus: { trait: '단단하고 믿음직한', tile: '#f7dcd8' },
  fenrir: { trait: '에너지 넘치는', tile: '#fde6c4' },
  zephyr: { trait: '밝고 화사한', tile: '#f9edbf' },
};
const DEFAULT_TUTOR = { trait: '원어민 튜터', tile: '#e5e8eb' };

// Why the server ended a call, shown under the report title.
const ENDED_MESSAGES = {
  out_of_minutes: () => '남은 통화 시간을 다 써서 통화가 끝났어요.',
  max_duration: () => `한 통화는 최대 ${state.config.maxCallMinutes}분이라 여기서 마무리했어요.`,
  server_shutdown: () => '서버 업데이트로 통화가 끊겼어요. 잠시 후 다시 걸어주세요.',
};

const SETTINGS_KEY = 'langtutor:settings';
const CAPTIONS_KEY = 'langtutor:captions';

// Preferences only; the app works the same when storage is unavailable.
function loadPref(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

const state = {
  // From /api/config: { voices, googleClientId, freeTrialMinutes, minCallSeconds, maxCallMinutes }
  config: null,
  // Signed-in account, or null. balanceSeconds is null when time is unlimited (local development).
  user: null,
  ws: null,
  // Server-side id of the current call; the report is generated from its record.
  callId: null,
  ctx: null,
  mic: null,
  player: null,
  options: null,
  responseActive: false,
  startedAt: 0,
  timer: null,
  rafId: null,
  // Ordered transcript entries: { itemId, role, text, el, textEl }
  turns: [],
  turnsById: new Map(),
  endedReason: null,
  lastError: null,
  tutorAnswered: false,
  userSpoke: false,
  tutorLevel: 0,
  captions: loadPref(CAPTIONS_KEY) ?? true,
  // Bumped per report request so a slow response can't overwrite a newer one.
  feedbackToken: 0,
};

function tutorInfo(voice) {
  return TUTORS[voice?.toLowerCase()] ?? DEFAULT_TUTOR;
}

// Fills a .photo element with the tutor's portrait, or their initial if there is none.
function setPhoto(photo, voice) {
  photo.style.setProperty('--tile', tutorInfo(voice).tile);
  photo.classList.remove('fallback');
  const img = photo.querySelector('img') ?? photo.appendChild(document.createElement('img'));
  img.alt = '';
  img.hidden = false;
  img.onerror = () => {
    img.hidden = true;
    photo.classList.add('fallback');
    photo.dataset.initial = voice.charAt(0).toUpperCase();
    photo.append(document.createTextNode(photo.dataset.initial));
  };
  for (const node of [...photo.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
  img.src = `/tutors/${voice.toLowerCase()}.svg`;
}

function showScreen(name) {
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.dataset.screen !== name;
  window.scrollTo(0, 0);
}

function setStatus(text) {
  $('#call-status').textContent = text;
}

function showError(message) {
  state.lastError = message;
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

function topicLabel(options) {
  if (options.topic === 'custom') return options.customTopic || '직접 정하기';
  return TOPIC_LABELS[options.topic] ?? TOPIC_LABELS.free;
}

// ---------- live captions ----------

function upsertTurn(itemId, role, text, { append = false, final = false } = {}) {
  let turn = state.turnsById.get(itemId);
  if (!turn) {
    const el = document.createElement('div');
    el.className = `line ${role}`;
    const who = document.createElement('span');
    who.className = 'line-who';
    who.textContent = role === 'user' ? '나' : capitalize(state.options.voice);
    const textEl = document.createElement('p');
    textEl.className = 'line-text';
    el.append(who, textEl);
    turn = { itemId, role, text: '', el, textEl };
    state.turns.push(turn);
    state.turnsById.set(itemId, turn);
    $('#transcript').append(el);
  }
  turn.text = append ? turn.text + text : text;
  turn.textEl.textContent = turn.text || '…';
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
  savePref(SETTINGS_KEY, state.options);
  state.turns = [];
  state.turnsById = new Map();
  state.endedReason = null;
  state.lastError = null;
  state.tutorAnswered = false;
  state.userSpoke = false;
  state.tutorLevel = 0;
  state.responseActive = false;
  state.callId = null;
  state.feedbackToken++;

  const { voice, language, level } = state.options;
  document.body.style.setProperty('--tile', tutorInfo(voice).tile);
  document.body.classList.add('in-call');
  $('#call-backdrop').src = `/tutors/${voice.toLowerCase()}.svg`;
  setPhoto($('#orb .photo'), voice);
  $('#tutor-name').textContent = capitalize(voice);
  $('#call-meta').textContent = `${LANGUAGE_LABELS[language]} · ${LEVEL_LABELS[level]} · ${topicLabel(state.options)}`;
  $('#transcript').replaceChildren();
  $('#call-error').hidden = true;
  $('#call-tip').hidden = true;
  $('#call-timer').hidden = true;
  $('#call-timer').textContent = '00:00';
  $('#orb').classList.add('ringing');
  setMuted(false);
  applyCaptions();
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

async function onReady({ inputSampleRate, outputSampleRate }) {
  state.player = new Player(state.ctx, outputSampleRate);
  state.mic = new Microphone(state.ctx, inputSampleRate, (audio) => {
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
  $('#call-timer').textContent = formatClock(sec);
}

function tick() {
  const speaking = state.player?.isPlaying;
  if (!state.tutorAnswered) setStatus('전화 거는 중…');
  else if (speaking) setStatus('말하는 중');
  else if (state.mic?.muted) setStatus('음소거됨');
  else setStatus('듣고 있어요');

  $('#call-timer').hidden = !state.tutorAnswered;
  $('#orb').classList.toggle('ringing', !state.tutorAnswered);
  $('#call-tip').hidden = !state.tutorAnswered || state.userSpoke;

  // Smooth the tutor's level a little so the ring breathes instead of flickering.
  const target = Math.min(1, (state.player?.level ?? 0) * 2.5);
  state.tutorLevel += (target - state.tutorLevel) * 0.35;
  document.body.style.setProperty('--tutor-level', state.tutorLevel.toFixed(3));
  const micLevel = Math.min(1, (state.mic?.level ?? 0) * 3);
  $('#mute-btn .mic-level').style.setProperty('--mic-level', micLevel.toFixed(3));

  state.rafId = requestAnimationFrame(tick);
}

function send(event) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(event));
}

function setMuted(muted) {
  if (state.mic) state.mic.muted = muted;
  const btn = $('#mute-btn');
  btn.setAttribute('aria-pressed', String(muted));
  btn.querySelector('use').setAttribute('href', muted ? '#i-mic-off' : '#i-mic');
  btn.querySelector('.ctrl-label').textContent = muted ? '음소거 해제' : '음소거';
}

function applyCaptions() {
  $('#captions').classList.toggle('off', !state.captions);
  $('#captions-btn').setAttribute('aria-pressed', String(state.captions));
  if (state.captions) {
    const box = $('#transcript');
    box.scrollTop = box.scrollHeight;
  }
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
      state.callId = event.callId;
      onReady(event);
      break;
    case 'relay.error':
      showError(event.message);
      break;
    case 'relay.ended':
      state.endedReason = event.reason;
      break;
    case 'input_audio_buffer.speech_started':
      state.userSpoke = true;
      bargeIn();
      // Reserve the learner's line now so it stays above the tutor's reply.
      upsertTurn(event.item_id, 'user', '');
      break;
    case 'conversation.item.input_audio_transcription.updated':
      state.userSpoke = true;
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
      state.tutorAnswered = true;
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
  // Read the balance once the server has seen the hang-up and billed the call;
  // asking straight away can still return the old one.
  if (ws.readyState === WebSocket.CLOSED) refreshUser();
  else ws.addEventListener('close', refreshUser, { once: true });
  ws.close();
  clearInterval(state.timer);
  cancelAnimationFrame(state.rafId);
  state.mic?.stop();
  state.player?.interrupt();
  state.ctx?.close();
  state.mic = null;
  state.player = null;
  state.ctx = null;
  document.body.classList.remove('in-call');
  document.body.style.removeProperty('--tutor-level');
  showFeedback();
}

// ---------- report ----------

function showFeedback() {
  const turns = transcriptForFeedback();
  const userTurns = turns.filter((t) => t.role === 'user').length;
  const duration = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
  state.startedAt = 0;

  const { voice, language, level } = state.options;
  setPhoto($('.report-photo'), voice);
  $('#feedback-meta').textContent = `${capitalize(voice)} · ${LANGUAGE_LABELS[language]} ${LEVEL_LABELS[level]} · ${topicLabel(state.options)}`;
  $('#report-title').textContent = userTurns
    ? `${formatDuration(duration)} 동안 대화했어요`
    : state.lastError ? '통화가 연결되지 않았어요' : '통화가 끝났어요';
  $('#again-btn-label').textContent = `${capitalize(voice)}에게 다시 걸기`;
  const ended = ENDED_MESSAGES[state.endedReason];
  $('#report-ended').hidden = !ended;
  $('#report-ended').textContent = ended?.() ?? '';
  $('#metrics').hidden = !userTurns;
  $('#metric-turns').textContent = `${userTurns}번`;
  $('#metric-fixes').textContent = '–';
  $('#metric-expressions').textContent = '–';
  renderTranscript(turns);
  showScreen('feedback');

  if (!userTurns) {
    const message = state.lastError ?? '대화 기록이 없어서 리포트를 만들 수 없어요.\n다음엔 튜터에게 한두 마디라도 건네 보세요.';
    $('#feedback-body').replaceChildren(el('p', state.lastError ? 'report-note error' : 'report-note', message));
    return;
  }
  loadFeedback();
}

async function loadFeedback() {
  const token = ++state.feedbackToken;
  const body = $('#feedback-body');
  const loading = el('div', 'report-loading');
  loading.append(el('div', 'spinner'), el('b', null, '튜터가 대화를 다시 듣고 있어요'), el('span', null, '고칠 문장과 오늘의 표현을 정리하는 중이에요. 15~20초 걸려요.'));
  body.replaceChildren(loading);

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: state.callId }),
    });
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) throw new Error((await res.json()).error);
    const feedback = await res.json();
    if (token !== state.feedbackToken) return;
    renderFeedback(feedback);
  } catch (err) {
    if (token !== state.feedbackToken) return;
    const retry = el('button', 'btn-plain');
    retry.type = 'button';
    retry.append(icon('i-retry'), '다시 시도');
    retry.addEventListener('click', loadFeedback);
    const note = el('div', 'report-note');
    note.append(el('div', null, `${err.message || '리포트를 불러오지 못했어요.'}\n무료 사용량이 몰리면 가끔 이래요.`), retry);
    body.replaceChildren(note);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

// "Listen" button that reads a sentence aloud with the browser's own voice.
function listenButton(text) {
  const button = el('button', 'listen');
  button.type = 'button';
  button.setAttribute('aria-label', `"${text}" 듣기`);
  button.append(icon('i-volume'));
  if (!('speechSynthesis' in window)) button.hidden = true;
  button.addEventListener('click', () => {
    const wasPlaying = button.classList.contains('playing');
    speechSynthesis.cancel();
    for (const b of document.querySelectorAll('.listen.playing')) b.classList.remove('playing');
    if (wasPlaying) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = SPEECH_LANGS[state.options.language] ?? 'en-US';
    utterance.rate = 0.95;
    utterance.onend = () => button.classList.remove('playing');
    utterance.onerror = () => button.classList.remove('playing');
    button.classList.add('playing');
    speechSynthesis.speak(utterance);
  });
  return button;
}

// Word-level diff (character-level for ja/zh) via LCS, so the report can mark
// exactly what changed between what the learner said and the better version.
function diffTokens(said, better, language) {
  const unspaced = UNSPACED_LANGUAGES.has(language);
  const split = (s) => (unspaced ? Array.from(s) : s.split(/\s+/).filter(Boolean));
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const a = split(said);
  const b = split(better);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = norm(a[i]) === norm(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const removed = new Set();
  const added = new Set();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (norm(a[i]) === norm(b[j])) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) removed.add(i++);
    else added.add(j++);
  }
  while (i < a.length) removed.add(i++);
  while (j < b.length) added.add(j++);
  return { a, b, removed, added, joiner: unspaced ? '' : ' ' };
}

function markedSentence(className, tokens, changed, markTag, joiner) {
  const p = el('p', className);
  tokens.forEach((token, index) => {
    if (index > 0 && joiner) p.append(joiner);
    p.append(changed.has(index) ? el(markTag, null, token) : token);
  });
  return p;
}

function renderFeedback(fb) {
  const { voice, language } = state.options;
  const body = $('#feedback-body');
  body.replaceChildren();
  $('#metric-fixes').textContent = `${fb.corrections.length}개`;
  $('#metric-expressions').textContent = `${fb.expressions.length}개`;

  if (fb.summary) body.append(el('p', 'report-summary', fb.summary));

  if (fb.corrections.length) {
    body.append(el('h2', 'report-h', '이렇게 말하면 더 자연스러워요'));
    const list = el('ol', 'fixes');
    for (const c of fb.corrections) {
      const said = String(c.original ?? '');
      const better = String(c.better ?? '');
      const diff = diffTokens(said, better, language);
      const item = el('li');
      const betterRow = el('div', 'fix-better');
      betterRow.append(markedSentence(null, diff.b, diff.added, 'ins', diff.joiner), listenButton(better));
      item.append(markedSentence('fix-said', diff.a, diff.removed, 'del', diff.joiner), betterRow);
      if (c.explanation) item.append(el('p', 'fix-why', c.explanation));
      list.append(item);
    }
    body.append(list);
  } else {
    body.append(el('p', 'report-note', '이번 통화에서는 크게 고칠 문장이 없었어요.'));
  }

  if (fb.expressions.length) {
    body.append(el('h2', 'report-h', '오늘의 표현'));
    const list = el('ul', 'phrases');
    for (const e of fb.expressions) {
      const item = el('li');
      const text = el('div');
      text.append(el('strong', null, e.phrase ?? ''), el('span', null, e.meaning ?? ''));
      item.append(text, listenButton(e.phrase ?? ''));
      list.append(item);
    }
    body.append(list);
  }

  if (fb.encouragement) {
    const note = el('div', 'tutor-note');
    const photo = el('span', 'photo');
    photo.setAttribute('aria-hidden', 'true');
    setPhoto(photo, voice);
    note.append(photo, el('p', null, fb.encouragement));
    body.append(note);
  }
}

function renderTranscript(turns) {
  const box = $('#feedback-transcript');
  box.replaceChildren(...turns.map((t) => el('div', `bubble ${t.role}`, t.text)));
  box.closest('details').hidden = turns.length === 0;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatClock(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function formatDuration(sec) {
  return sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
}

// ---------- setup screen ----------

function renderVoices(voices) {
  $('#voice-list').replaceChildren(...voices.map((voice, i) => {
    const label = el('label', 'tutor');
    const input = el('input');
    input.type = 'radio';
    input.name = 'voice';
    input.value = voice;
    input.checked = i === 0;
    const photo = el('span', 'photo');
    setPhoto(photo, voice);
    const check = el('span', 'tutor-check');
    check.append(icon('i-check'));
    photo.append(check);
    label.append(input, photo, el('span', 'tutor-name', capitalize(voice)), el('span', 'tutor-trait', tutorInfo(voice).trait));
    return label;
  }));
}

function restoreSettings() {
  const saved = loadPref(SETTINGS_KEY);
  if (!saved || typeof saved !== 'object') return;
  for (const name of ['language', 'level', 'topic', 'voice', 'correction']) {
    if (typeof saved[name] !== 'string') continue;
    const input = document.querySelector(`#setup-form input[name="${name}"][value="${CSS.escape(saved[name])}"]`);
    if (input) input.checked = true;
  }
  if (typeof saved.customTopic === 'string') $('#custom-topic').value = saved.customTopic;
}

function syncSetup() {
  const options = readOptions();
  const values = {
    language: LANGUAGE_LABELS[options.language],
    level: LEVEL_LABELS[options.level],
    topic: topicLabel(options),
    correction: CORRECTION_LABELS[options.correction],
  };
  for (const [name, value] of Object.entries(values)) $(`[data-value="${name}"]`).textContent = value ?? '';
  $('#custom-topic-field').hidden = options.topic !== 'custom';
  $('#call-btn-label').textContent = options.voice ? `${capitalize(options.voice)}에게 전화 걸기` : '전화 걸기';
  $('#call-btn').disabled = !options.voice || outOfTime();
}

// ---------- account ----------

function outOfTime() {
  const balance = state.user?.balanceSeconds;
  return balance != null && balance < (state.config?.minCallSeconds ?? 0);
}

function formatBalance(sec) {
  return sec >= 60 ? `${Math.floor(sec / 60)}분` : `${sec}초`;
}

// Google profile photo, or the first letter of the name when there is none.
function setAvatar(avatar, user) {
  const initial = (user.name || user.email || '?').charAt(0).toUpperCase();
  if (!user.picture) {
    avatar.replaceChildren(initial);
    return;
  }
  const img = el('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.onerror = () => avatar.replaceChildren(initial);
  img.src = user.picture;
  avatar.replaceChildren(img);
}

function renderAccount() {
  const user = state.user;
  // Without login (local development) there's no account to show.
  $('#account-btn').hidden = !user || !state.config.googleClientId;
  if (user && state.config.googleClientId) {
    const balance = user.balanceSeconds ?? 0;
    $('#account-minutes').textContent = outOfTime() ? '시간 없음' : `${formatBalance(balance)} 남음`;
    $('#account-btn').classList.toggle('empty', outOfTime());
    $('#account-btn').setAttribute('aria-label', `내 계정, 남은 통화 시간 ${formatBalance(balance)}`);
    setAvatar($('#account-avatar'), user);
    setAvatar($('#account-sheet-avatar'), user);
    $('#account-name').textContent = user.name ?? '';
    $('#account-email').textContent = user.email ?? '';
    $('#account-balance').textContent = formatBalance(balance);
  }
  $('#call-note').textContent = outOfTime()
    ? (state.config.payments
      ? '남은 통화 시간이 없어요. 오른쪽 위 내 계정에서 충전할 수 있어요.'
      : '남은 통화 시간이 없어요. 시간이 충전되면 다시 걸 수 있어요.')
    : '이어폰을 끼면 튜터 목소리가 마이크로 다시 들어가지 않아요';
  $('#again-btn').disabled = outOfTime();
  if (user && state.config.payments) renderPacks();
  syncSetup();
}

async function refreshUser() {
  // On a server or network error keep what we have rather than dropping the
  // account (which would also lift the out-of-time lock on the call button).
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return;
    state.user = (await res.json()).user;
  } catch {
    return;
  }
  renderAccount();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
}

function loadGoogleScript() {
  if (window.google?.accounts) return Promise.resolve();
  return loadScript('https://accounts.google.com/gsi/client');
}

async function showLogin() {
  showScreen('login');
  const minutes = state.config.freeTrialMinutes;
  $('#login-note').textContent = minutes > 0 ? `처음 가입하면 무료 통화 ${minutes}분을 드려요` : '';
  renderPricing();
  const faces = $('#login-faces');
  if (!faces.childElementCount) {
    faces.replaceChildren(...state.config.voices.slice(0, 3).map((voice) => {
      const photo = el('span', 'photo');
      setPhoto(photo, voice);
      return photo;
    }));
  }
  try {
    await loadGoogleScript();
  } catch {
    showLoginError('Google 로그인을 불러오지 못했어요. 네트워크를 확인하고 새로고침해 주세요.');
    return;
  }
  google.accounts.id.initialize({ client_id: state.config.googleClientId, callback: onGoogleCredential });
  const box = $('#google-btn');
  google.accounts.id.renderButton(box, {
    theme: 'outline',
    size: 'large',
    shape: 'pill',
    text: 'continue_with',
    locale: 'ko',
    width: Math.min(400, box.clientWidth || 320),
  });
}

function showLoginError(message) {
  $('#login-error').textContent = message;
  $('#login-error').hidden = !message;
}

async function onGoogleCredential({ credential }) {
  showLoginError('');
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    state.user = body.user;
  } catch (err) {
    showLoginError(err.message || '로그인하지 못했어요. 다시 시도해주세요.');
    return;
  }
  renderAccount();
  showScreen('setup');
}

async function logout() {
  $('#sheet-account').close();
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.google?.accounts.id.disableAutoSelect();
  state.user = null;
  renderAccount();
  showLogin();
}

// ---------- payments ----------

// The time arrives with Paddle's webhook, usually a few seconds after paying.
const CREDIT_POLL_MS = 2000;
const CREDIT_WAIT_MS = 60_000;

let paddleReady = null;
function initPaddle() {
  const { payments } = state.config;
  paddleReady ??= loadScript('https://cdn.paddle.com/paddle/v2/paddle.js').then(() => {
    if (payments.environment === 'sandbox') Paddle.Environment.set('sandbox');
    Paddle.Initialize({
      token: payments.clientToken,
      checkout: { settings: { displayMode: 'overlay', locale: 'ko' } },
      eventCallback: (event) => {
        if (event.name === 'checkout.completed') waitForCredit();
      },
    });
  });
  // Let a later attempt retry a script that failed to load.
  paddleReady.catch(() => { paddleReady = null; });
  return paddleReady;
}

function setPayNote(text) {
  $('#pay-note').textContent = text;
}

// Pack prices (tax included), localized by Paddle for the visitor's country: priceId -> "₩9,900".
let pricesReady = null;
function loadPrices() {
  const { packs } = state.config.payments;
  pricesReady ??= initPaddle()
    .then(() => Paddle.PricePreview({ items: packs.map((pack) => ({ priceId: pack.priceId, quantity: 1 })) }))
    .then((preview) => new Map(preview.data.details.lineItems.map((item) => [item.price.id, item.formattedTotals.total])));
  pricesReady.catch(() => { pricesReady = null; });
  return pricesReady;
}

// Each pack as its label plus an empty price slot, filled in once prices load.
function packRows(tag, onPick) {
  const slots = new Map();
  const rows = state.config.payments.packs.map((pack) => {
    const row = el(tag, tag === 'button' ? 'pack' : null, `${pack.minutes}분`);
    if (tag === 'button') {
      row.type = 'button';
      row.addEventListener('click', () => onPick(pack));
    }
    const price = el('span');
    slots.set(pack.priceId, price);
    row.append(price);
    return row;
  });
  return { rows, fill: async () => {
    const prices = await loadPrices();
    for (const [priceId, price] of slots) price.textContent = prices.get(priceId) ?? '';
  } };
}

// Public price list on the sign-in screen. index.html ships the KRW prices so they show
// without Paddle; once Paddle answers, swap in its prices for the visitor's country.
function renderPricing() {
  const list = $('#price-list');
  if (!state.config.payments || list.dataset.source === 'paddle') return;
  list.dataset.source = 'paddle';
  const { rows, fill } = packRows('li');
  fill().then(() => list.replaceChildren(...rows)).catch(() => {});
}

// Pack buttons in the account sheet.
function renderPacks() {
  if ($('#pack-list').childElementCount) return;
  const { rows, fill } = packRows('button', buyPack);
  $('#pack-list').replaceChildren(...rows);
  $('#account-packs').hidden = false;
  fill().catch(() => setPayNote('가격을 불러오지 못했어요. 결제는 그대로 할 수 있어요.'));
}

async function buyPack(pack) {
  setPayNote('');
  try {
    await initPaddle();
  } catch {
    setPayNote('결제창을 불러오지 못했어요. 네트워크를 확인하고 다시 시도해주세요.');
    return;
  }
  // A modal sheet stays above everything else, so the checkout would open behind it.
  $('#sheet-account').close();
  Paddle.Checkout.open({
    items: [{ priceId: pack.priceId, quantity: 1 }],
    ...(state.user.email && { customer: { email: state.user.email } }),
    customData: { userId: state.user.id },
  });
}

async function waitForCredit() {
  const before = state.user?.balanceSeconds ?? 0;
  setPayNote('결제를 확인하고 있어요…');
  for (const until = Date.now() + CREDIT_WAIT_MS; Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, CREDIT_POLL_MS));
    await refreshUser();
    if ((state.user?.balanceSeconds ?? 0) > before) {
      setPayNote('충전됐어요.');
      return;
    }
  }
  setPayNote('결제는 완료됐는데 충전이 늦어지고 있어요. 잠시 후 새로고침해 보세요.');
}

async function init() {
  syncSetup();
  state.config = await (await fetch('/api/config')).json();
  renderVoices(state.config.voices);
  restoreSettings();
  await refreshUser();
  if (state.user) showScreen('setup');
  else showLogin();
}

// ---------- wiring ----------

init();

$('#setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (readOptions().voice) startCall();
});
$('#setup-form').addEventListener('change', (e) => {
  syncSetup();
  const sheet = e.target.closest('dialog');
  if (!sheet || e.target.type !== 'radio') return;
  if (e.target.name === 'topic' && e.target.value === 'custom') {
    $('#custom-topic').focus();
    return;
  }
  // Like a native picker: choosing an option closes the sheet.
  setTimeout(() => sheet.close(), 160);
});
$('#custom-topic').addEventListener('input', syncSetup);
$('#custom-topic').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.target.closest('dialog').close();
  }
});
for (const row of document.querySelectorAll('[data-sheet]')) {
  row.addEventListener('click', () => $(`#sheet-${row.dataset.sheet}`).showModal());
}
for (const sheet of document.querySelectorAll('.sheet')) {
  // Clicking the dimmed backdrop (outside the sheet's box) closes the sheet.
  sheet.addEventListener('click', (e) => {
    const box = sheet.getBoundingClientRect();
    if (e.target === sheet && (e.clientY < box.top || e.clientX < box.left || e.clientX > box.right)) sheet.close();
  });
}
for (const button of document.querySelectorAll('[data-close-sheet]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}
$('#hangup-btn').addEventListener('click', endCall);
$('#mute-btn').addEventListener('click', () => {
  if (state.mic) setMuted(!state.mic.muted);
});
$('#captions-btn').addEventListener('click', () => {
  state.captions = !state.captions;
  savePref(CAPTIONS_KEY, state.captions);
  applyCaptions();
});
$('#account-btn').addEventListener('click', () => $('#sheet-account').showModal());
$('#logout-btn').addEventListener('click', logout);
$('#again-btn').addEventListener('click', () => {
  window.speechSynthesis?.cancel();
  startCall();
});
$('#settings-btn').addEventListener('click', () => {
  window.speechSynthesis?.cancel();
  showScreen('setup');
});
