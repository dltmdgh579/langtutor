# LangTutor — 원어민 전화 튜터 MVP

xAI **Grok Voice Agent API**(Grok Voice 3.0)로 만든 "외국인 튜터와 전화 영어" 스타일 MVP입니다.
브라우저에서 전화 걸기 → 원어민 튜터와 실시간 음성 대화 → 통화 후 교정 리포트까지 한 흐름으로 동작합니다.

## 기능

- **실시간 음성 통화**: speech-to-speech 모델이 바로 듣고 말함 (STT→LLM→TTS 파이프라인 없음)
- **끼어들기(barge-in)**: 튜터가 말하는 중에 말을 시작하면 튜터가 멈추고, 실제로 들은 부분까지만 대화 기록에 남김
- **설정**: 언어(영/일/중/스/프/독), 수준(초/중/고급), 주제(자유·일상·여행·비즈니스·면접·직접 입력), 튜터 목소리, 교정 방식
- **실시간 자막**: 내 말/튜터 말 모두 화면에 표시
- **통화 후 리포트**: 대화 기록을 Grok 텍스트 모델로 분석해 교정 문장, 오늘의 표현, 한 줄 격려 제공 (설명은 한국어)

## 실행

Node.js 22.9 이상이 필요합니다.

```bash
npm install
cp .env.example .env   # XAI_API_KEY 입력
npm start              # http://localhost:3000
```

마이크 권한 때문에 `localhost` 또는 HTTPS에서만 동작합니다. 이어폰을 쓰면 튜터 목소리가 마이크로 다시 들어가지 않아 더 매끄럽습니다.

## 구조

```
server/
  index.js     HTTP 서버: 정적 파일, /api/feedback, /call WebSocket 업그레이드
  relay.js     브라우저 ↔ xAI 실시간 API 중계. 세션 설정(프롬프트·목소리·VAD)은 서버에서만
  prompts.js   튜터 페르소나 / 피드백 프롬프트
  feedback.js  통화 후 리포트 생성 (chat completions)
public/
  index.html   설정 → 통화 → 리포트 3개 화면
  app.js       통화 상태, 이벤트 처리, 자막, 리포트 렌더링
  audio.js     마이크 캡처(AudioWorklet → 24kHz PCM16) / 스트리밍 재생
```

```
브라우저 ──(ws /call, PCM16 base64)──▶ Node 서버 ──(wss + API 키)──▶ wss://api.x.ai/v1/realtime
```

API 키는 서버에만 있고, 브라우저는 오디오 전송(`input_audio_buffer.append`)과 끼어들기용 이벤트(`response.cancel`, `conversation.item.truncate`)만 보낼 수 있습니다. 클라이언트가 프롬프트나 모델을 바꿀 수 없습니다.

## 설정 (.env)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `XAI_API_KEY` | (필수) | xAI 콘솔에서 발급 |
| `XAI_VOICE_MODEL` | `grok-voice-latest` | 현재 Grok Voice 3.0을 가리키는 별칭. 버전 고정은 `grok-voice-3.0` |
| `XAI_TEXT_MODEL` | `grok-4-1-fast-non-reasoning` | 통화 후 리포트용 텍스트 모델 |
| `MAX_CALL_MINUTES` | `15` | 한 통화 최대 길이 (비용 방지) |
| `PORT` | `3000` | |

## 튜닝 포인트

- 튜터 말투·교정 규칙: `server/prompts.js`의 `buildTutorInstructions`
- 생각하느라 잠깐 멈췄는데 튜터가 끼어든다면 `server/relay.js`의 `silence_duration_ms`를 늘리세요 (초급 1200ms, 그 외 800ms)
- 목소리 추가: `server/prompts.js`의 `VOICES`와 `public/index.html`의 선택지

## 다음 단계 아이디어

- 로그인 + 수업 기록 저장, 자주 틀리는 표현 누적 복습
- 예약 시간에 튜터가 먼저 전화 걸기 (Twilio 등 전화망 연동 — API가 G.711 μ-law 8kHz도 지원)
- 수업 종료 1분 전 튜터가 자연스럽게 마무리하도록 안내
- 레벨 테스트 후 수준 자동 설정
