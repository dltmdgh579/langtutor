// Post-call feedback: send the call transcript to a Grok text model and get
// back corrections and useful expressions as JSON.

import { buildFeedbackPrompt } from './prompts.js';

const MAX_TURNS = 200;
const MAX_TURN_CHARS = 1000;

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in model output');
  return JSON.parse(text.slice(start, end + 1));
}

export async function generateFeedback(body, config) {
  const transcript = (Array.isArray(body?.transcript) ? body.transcript : [])
    .filter((t) => (t?.role === 'user' || t?.role === 'assistant') && typeof t.text === 'string')
    .slice(-MAX_TURNS)
    .map((t) => ({ role: t.role, text: t.text.slice(0, MAX_TURN_CHARS) }));

  if (!transcript.some((t) => t.role === 'user')) {
    return { summary: '대화 기록이 없어 피드백을 만들 수 없어요.', corrections: [], expressions: [], encouragement: '' };
  }

  const { system, user } = buildFeedbackPrompt({
    language: body.language,
    level: body.level,
    transcript,
  });

  const res = await fetch(`${config.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.textModel,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`xAI chat completions failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const feedback = extractJson(data.choices?.[0]?.message?.content ?? '');
  return {
    summary: String(feedback.summary ?? ''),
    corrections: Array.isArray(feedback.corrections) ? feedback.corrections : [],
    expressions: Array.isArray(feedback.expressions) ? feedback.expressions : [],
    encouragement: String(feedback.encouragement ?? ''),
  };
}
