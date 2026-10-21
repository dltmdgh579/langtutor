// xAI Grok Voice Agent API. Its realtime protocol is OpenAI-Realtime-shaped,
// which is also the event shape the browser client speaks, so events pass
// through mostly unchanged.

const SAMPLE_RATE = 24000;

export const grok = {
  id: 'grok',
  apiKeyEnv: 'XAI_API_KEY',
  voices: ['eve', 'ara', 'leo', 'rex', 'sal'],

  readConfig(env) {
    return {
      apiKey: env.XAI_API_KEY,
      voiceModel: env.XAI_VOICE_MODEL || 'grok-voice-latest',
      textModel: env.XAI_TEXT_MODEL || 'grok-4-1-fast-non-reasoning',
      realtimeUrl: env.XAI_REALTIME_URL || 'wss://api.x.ai/v1/realtime',
      apiBase: env.XAI_API_BASE || 'https://api.x.ai/v1',
    };
  },

  connection(config) {
    return {
      url: `${config.realtimeUrl}?model=${encodeURIComponent(config.voiceModel)}`,
      headers: { Authorization: `Bearer ${config.apiKey}` },
    };
  },

  createSession({ options, instructions, sendUpstream, emit, ready }) {
    let isReady = false;
    return {
      onOpen() {
        sendUpstream({
          type: 'session.update',
          session: {
            instructions,
            voice: options.voice,
            turn_detection: {
              type: 'server_vad',
              // Learners pause to think mid-sentence; wait a bit longer than
              // the default before treating silence as the end of their turn.
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
      },

      onMessage(event) {
        if (event.type === 'session.updated' && !isReady) {
          isReady = true;
          ready({ inputSampleRate: SAMPLE_RATE, outputSampleRate: SAMPLE_RATE });
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
        emit(event);
      },

      onClientEvent(event) {
        sendUpstream(event);
      },
    };
  },

  async generateText(config, { system, user }) {
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
    if (!res.ok) throw new Error(`xAI chat completions failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  },
};
