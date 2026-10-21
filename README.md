# LangTutor — 원어민 전화 튜터 MVP

실시간 음성 AI로 만든 "외국인 튜터와 전화 영어" 스타일 MVP입니다.
음성 엔진은 `.env`의 `VOICE_PROVIDER` 하나로 바꿀 수 있어요.

| 제공자 | 용도 | 비용 |
| --- | --- | --- |
| `gemini` (기본) | 개발·프롬프트 튜닝 | Google AI Studio 무료 티어 (한도 내) |
| `grok` | 최종 품질 비교·서비스 | Grok Voice 3.0, 약 $0.08/분 |

브라우저에서 전화 걸기 → 원어민 튜터와 실시간 음성 대화 → 통화 후 교정 리포트까지 한 흐름으로 동작합니다.

## 기능

- **실시간 음성 통화**: speech-to-speech 모델이 바로 듣고 말함 (STT→LLM→TTS 파이프라인 없음)
- **끼어들기(barge-in)**: 튜터가 말하는 중에 말을 시작하면 튜터가 멈추고, 실제로 들은 부분까지만 대화 기록에 남김
- **설정**: 언어(영/일/중/스/프/독), 수준(초/중/고급), 주제(자유·일상·여행·비즈니스·면접·직접 입력), 튜터 목소리, 교정 방식
- **실시간 자막**: 내 말/튜터 말 모두 화면에 표시
- **통화 후 리포트**: 대화 기록을 선택한 제공자의 텍스트 모델(Gemini/Grok)로 분석해 교정 문장, 오늘의 표현, 한 줄 격려 제공 (설명은 한국어)

## 실행

Node.js 22.9 이상이 필요합니다.

```bash
npm install
cp .env.example .env   # GEMINI_API_KEY 입력 (https://aistudio.google.com/apikey)
npm start              # http://localhost:3000
```

Gemini 모델 이름은 자주 바뀌어요. 연결 시 "model ... is not found" 오류가 나면 내 키로 쓸 수 있는 Live 모델을 확인해서 `GEMINI_VOICE_MODEL`에 넣으세요.

```bash
npm run gemini:models
```

Grok으로 바꾸려면 `.env`에서 `VOICE_PROVIDER=grok`으로 바꾸고 `XAI_API_KEY`를 넣으면 돼요.

마이크 권한 때문에 `localhost` 또는 HTTPS에서만 동작합니다. 이어폰을 쓰면 튜터 목소리가 마이크로 다시 들어가지 않아 더 매끄럽습니다.

## 배포 (Render 무료)

저장소의 `render.yaml`(Blueprint)에 설정이 들어 있어서, 대시보드에서 몇 번만 누르면 됩니다.

1. https://render.com 에 GitHub 계정으로 가입
2. **New → Blueprint** → 이 저장소 선택 (Render GitHub 앱에 저장소 접근 권한을 주라고 나오면 허용)
3. 입력란이 나오면 채우기
   - `GEMINI_API_KEY`: Gemini 키
   - `APP_PASSWORD`: 접속 비밀번호 (직접 정하기)
4. **Deploy Blueprint** → 몇 분 뒤 `https://langtutor-xxxx.onrender.com` 주소가 생김

처음 접속하면 브라우저가 아이디/비밀번호를 묻습니다. 아이디는 아무거나, 비밀번호는 `APP_PASSWORD` 값을 넣으면 30일 동안 다시 묻지 않아요.
이후 `main`에 push하면 자동으로 다시 배포됩니다.

| 항목 | 값 |
| --- | --- |
| 리전 | 싱가포르 |
| 최대 통화 시간 | 10분 (`MAX_CALL_MINUTES`) |
| 상태 확인 | `/healthz` (비밀번호 없이 열림) |

무료 플랜 주의점:
- 15분 동안 접속이 없으면 서버가 잠들고, 다음 접속 때 켜지는 데 약 1분 걸려요. 잠들지 않게 하려면 Starter(월 $7)로 바꾸면 됩니다.
- 통화 1분에 서버가 내보내는 트래픽이 약 4~5MB예요. 무료 트래픽 한도를 넘지 않는지 Render 대시보드에서 확인하세요.
- `APP_PASSWORD`를 비워두면 주소를 아는 누구나 내 API 키로 통화할 수 있어요.

## 구조

```
server/
  index.js     HTTP 서버: 정적 파일, /api/config, /api/feedback, /call WebSocket 업그레이드
  relay.js     브라우저 ↔ 음성 제공자 중계. 세션 설정(프롬프트·목소리·VAD)은 서버에서만
  prompts.js   튜터 페르소나 / 피드백 프롬프트
  feedback.js  통화 후 리포트 생성
  providers/
    gemini.js  Gemini Live 어댑터 (Gemini 프로토콜 ↔ 클라이언트 이벤트 변환)
    grok.js    Grok Voice Agent 어댑터 (OpenAI Realtime 형식이라 거의 그대로 전달)
scripts/
  list-gemini-models.js  내 키로 쓸 수 있는 Gemini Live 모델 목록
public/
  index.html   설정 → 통화 → 리포트 3개 화면
  app.js       통화 상태, 이벤트 처리, 자막, 리포트 렌더링
  audio.js     마이크 캡처(AudioWorklet → PCM16, Gemini 16kHz / Grok 24kHz) / 스트리밍 재생
```

```
브라우저 ──(ws /call)──▶ Node 서버 ──(wss + API 키)──▶ Gemini Live  또는  Grok Voice
```

브라우저는 항상 같은 형식(OpenAI Realtime 스타일 이벤트)으로 말하고, 제공자별 차이는 `server/providers/`의 어댑터가 흡수합니다. 새 제공자(예: OpenAI gpt-realtime-mini)를 붙일 때도 어댑터 파일 하나만 추가하면 돼요.

API 키는 서버에만 있고, 브라우저는 오디오 전송(`input_audio_buffer.append`)과 끼어들기용 이벤트(`response.cancel`, `conversation.item.truncate`)만 보낼 수 있습니다. 클라이언트가 프롬프트나 모델을 바꿀 수 없습니다.

## 설정 (.env)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `VOICE_PROVIDER` | `gemini` | `gemini` 또는 `grok` |
| `GEMINI_API_KEY` | | Google AI Studio에서 발급 |
| `GEMINI_VOICE_MODEL` | `gemini-3.8-live` | Live API 음성 모델 (`npm run gemini:models`로 확인). 실측 응답 지연 약 1.6~2초 (2.5 native-audio 모델은 5~7초) |
| `GEMINI_TEXT_MODEL` | `gemini-flash-lite-latest` | 통화 후 리포트용. 무료 티어에서 가장 안정적 (실측 15~20초) |
| `GEMINI_TEXT_FALLBACK_MODEL` | `gemini-flash-latest` | 위 모델이 혼잡(503)하거나 응답이 없을 때 사용 |
| `XAI_API_KEY` | | xAI 콘솔에서 발급 |
| `XAI_VOICE_MODEL` | `grok-voice-latest` | 현재 Grok Voice 3.0을 가리키는 별칭. 버전 고정은 `grok-voice-3.0` |
| `XAI_TEXT_MODEL` | `grok-4-1-fast-non-reasoning` | 통화 후 리포트용 |
| `MAX_CALL_MINUTES` | `15` | 한 통화 최대 길이 (비용 방지, Gemini 음성 세션 한도도 15분) |
| `PORT` | `3000` | |
| `APP_PASSWORD` | (없음) | 설정하면 접속할 때 비밀번호를 물음. 배포 시 필수 |

## 튜닝 포인트

- 튜터 말투·교정 규칙: `server/prompts.js`의 `buildTutorInstructions`
- 생각하느라 잠깐 멈췄는데 튜터가 끼어든다면 제공자 어댑터(`server/providers/*.js`)의 무음 판정 시간을 늘리세요 (초급 1200ms, 그 외 800ms)
- 목소리 추가: 각 어댑터의 `voices` 배열 (화면 선택지는 자동으로 따라감)

## 다음 단계 아이디어

- 로그인 + 수업 기록 저장, 자주 틀리는 표현 누적 복습
- 예약 시간에 튜터가 먼저 전화 걸기 (Twilio 등 전화망 연동 — Grok API는 G.711 μ-law 8kHz도 지원)
- 수업 종료 1분 전 튜터가 자연스럽게 마무리하도록 안내
- 레벨 테스트 후 수준 자동 설정
