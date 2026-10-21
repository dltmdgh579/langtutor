// Google Gemini Live API (native audio). Gemini speaks its own protocol
// (setup / realtimeInput / serverContent), so this adapter translates it into
// the OpenAI-Realtime-style events the browser client already understands.

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

export const gemini = {
  id: 'gemini',
  apiKeyEnv: 'GEMINI_API_KEY',
  voices: ['Kore', 'Puck', 'Aoede', 'Charon', 'Leda', 'Orus', 'Fenrir', 'Zephyr'],

  readConfig(env) {
    return {
      apiKey: env.GEMINI_API_KEY,
      voiceModel: env.GEMINI_VOICE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025',
      textModel: env.GEMINI_TEXT_MODEL || 'gemini-flash-latest',
      realtimeUrl: env.GEMINI_REALTIME_URL
        || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
      apiBase: env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta',
    };
  },

  connection(config) {
    return { url: `${config.realtimeUrl}?key=${encodeURIComponent(config.apiKey)}`, headers: {} };
  },

  createSession({ options, instructions, config, sendUpstream, emit, ready }) {
    let counter = 0;
    let userItem = null;
    let userText = '';
    let modelItem = null;

    const startUser = () => {
      userItem = `gemini_user_${++counter}`;
      userText = '';
    };
    const finishUser = () => {
      if (userItem && userText) {
        emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: userItem, transcript: userText });
      }
      userItem = null;
      userText = '';
    };
    const ensureModelItem = () => {
      if (!modelItem) {
        modelItem = `gemini_model_${++counter}`;
        emit({ type: 'response.created' });
      }
      return modelItem;
    };
    const finishModel = () => {
      if (modelItem) emit({ type: 'response.done' });
      modelItem = null;
    };

    return {
      onOpen() {
        sendUpstream({
          setup: {
            model: `models/${config.voiceModel}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } },
            },
            systemInstruction: { parts: [{ text: instructions }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                // Learners pause to think mid-sentence; don't cut them off.
                endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
                silenceDurationMs: options.level === 'beginner' ? 1200 : 800,
              },
            },
          },
        });
      },

      onMessage(msg) {
        if (msg.setupComplete) {
          ready({ inputSampleRate: INPUT_SAMPLE_RATE, outputSampleRate: OUTPUT_SAMPLE_RATE });
          // Let the tutor speak first, like answering a scheduled call.
          sendUpstream({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text: '(The call has just connected.)' }] }],
              turnComplete: true,
            },
          });
          return;
        }

        const content = msg.serverContent;
        if (!content) return;

        // Gemini already stopped generating because the learner started
        // talking; tell the client so it drops the audio it has queued.
        if (content.interrupted) {
          finishModel();
          finishUser();
          startUser();
          emit({ type: 'input_audio_buffer.speech_started', item_id: userItem });
        }

        if (content.inputTranscription?.text) {
          if (!userItem) startUser();
          userText += content.inputTranscription.text;
          emit({ type: 'conversation.item.input_audio_transcription.updated', item_id: userItem, transcript: userText });
        }

        for (const part of content.modelTurn?.parts ?? []) {
          if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
            emit({ type: 'response.output_audio.delta', item_id: ensureModelItem(), delta: part.inlineData.data });
          }
        }

        if (content.outputTranscription?.text) {
          emit({ type: 'response.output_audio_transcript.delta', item_id: ensureModelItem(), delta: content.outputTranscription.text });
        }

        if (content.turnComplete) {
          finishUser();
          finishModel();
        }
      },

      onClientEvent(event) {
        // response.cancel / conversation.item.truncate need no forwarding:
        // Gemini handles barge-in and truncation server-side.
        if (event.type === 'input_audio_buffer.append') {
          sendUpstream({
            realtimeInput: { audio: { data: event.audio, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` } },
          });
        }
      },
    };
  },

  async generateText(config, { system, user }) {
    const res = await fetch(`${config.apiBase}/models/${config.textModel}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) throw new Error(`Gemini generateContent failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  },
};
