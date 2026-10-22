# Rinrin — 원어민 전화 튜터 MVP

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
- **설정**: 언어(영/일/중/스/프/독), 수준(초/중/고급), 주제(자유·일상·여행·비즈니스·면접·직접 입력), 튜터 목소리, 교정 방식. 마지막 설정은 브라우저에 저장
- **실시간 자막**: 내 말/튜터 말 모두 화면에 표시. 통화 중 자막을 끄고 듣기만 연습할 수도 있음
- **통화 후 리포트**: 대화 기록을 선택한 제공자의 텍스트 모델(Gemini/Grok)로 분석해 교정 문장, 오늘의 표현, 한 줄 격려 제공 (설명은 한국어). 교정 문장과 표현은 브라우저 음성으로 다시 들을 수 있음
- **Google 로그인 · 사용 시간**: 계정마다 남은 통화 시간이 있고, 통화한 만큼 차감. 새 계정에는 무료 체험 시간 지급. 통화 기록(대화 내용, 리포트)은 DB에 저장

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

`GOOGLE_CLIENT_ID`와 `DATABASE_URL`을 비워두면 로그인 없이 무제한으로 쓸 수 있어요(로컬 개발용). 로그인과 사용 시간을 로컬에서 확인하려면 아래 두 가지를 설정하세요.

## 로그인 · DB 준비

### 1. Google 로그인 (OAuth 클라이언트 ID)

1. https://console.cloud.google.com 에서 프로젝트 만들기
2. **API 및 서비스 → OAuth 동의 화면**: 앱 이름, 지원 이메일 입력, 사용자 유형 **외부**
3. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
   - 애플리케이션 유형: **웹 애플리케이션**
   - **승인된 JavaScript 원본**에 접속 주소 추가: `http://localhost:3000`, `https://langtutor-xxxx.onrender.com` (배포 주소)
   - 리디렉션 URI는 필요 없어요
4. 생성된 클라이언트 ID(`….apps.googleusercontent.com`)를 `GOOGLE_CLIENT_ID`에 넣기

동의 화면이 **테스트** 상태일 때는 테스트 사용자로 등록한 계정만 로그인할 수 있어요. 누구나 쓰게 하려면 **앱 게시**를 누르세요(이메일·프로필만 쓰므로 Google 심사는 필요 없어요).

### 2. Postgres (Neon 무료)

1. https://neon.tech 가입 → 프로젝트 만들기 (리전: 싱가포르 `ap-southeast-1`, Render와 같은 곳)
2. **Connect**에서 연결 문자열 복사 → 끝의 `sslmode=require`를 `sslmode=verify-full`로 바꿔서 `DATABASE_URL`에 넣기 (`channel_binding=require`는 그대로 둬도 돼요)

테이블은 서버가 시작할 때 자동으로 만들어요(`server/schema.sql`). Postgres라면 Supabase 등 다른 곳도 쓸 수 있어요.

### 사용 시간

- 처음 로그인한 계정에 `FREE_TRIAL_MINUTES`(기본 10분)를 줘요. 초대한 사람만 쓰게 하려면 `0`으로 두고 직접 지급하세요.
- 통화 시간은 튜터가 연결된 순간부터 끊을 때까지 초 단위로 차감돼요. 연결에 실패한 통화는 차감하지 않아요.
- 남은 시간이 30초 미만이면 전화를 걸 수 없고, 통화 중에 시간이 다 떨어지면 통화가 끝나요.
- 한 계정은 동시에 한 통화만 할 수 있어요.
- 시간 지급·회수 (상대가 한 번은 로그인해야 해요):

```bash
npm run grant -- someone@gmail.com 30    # 30분 추가
npm run grant -- someone@gmail.com -10   # 10분 회수
```

배포된 DB에 쓰려면 로컬 `.env`의 `DATABASE_URL`을 배포용 값으로 맞추거나, Neon 대시보드의 SQL Editor에서 직접 바꾸세요.

```sql
update users set balance_seconds = balance_seconds + 30 * 60 where email = 'someone@gmail.com';
```

## 배포 (Render)

저장소의 `render.yaml`(Blueprint)에 설정이 들어 있어서, 대시보드에서 몇 번만 누르면 됩니다.

1. https://render.com 에 GitHub 계정으로 가입
2. **New → Blueprint** → 이 저장소 선택 (Render GitHub 앱에 저장소 접근 권한을 주라고 나오면 허용)
3. 입력란이 나오면 채우기
   - `GEMINI_API_KEY`: Gemini 키
   - `GOOGLE_CLIENT_ID`, `DATABASE_URL`: 위에서 준비한 값
4. **Deploy Blueprint** → 몇 분 뒤 `https://langtutor-xxxx.onrender.com` 주소가 생김
5. 이 주소를 Google OAuth 클라이언트의 **승인된 JavaScript 원본**에 추가

이후 `main`에 push하면 자동으로 다시 배포됩니다. 배포 때 진행 중이던 통화는 끊기지만, 그때까지의 시간 차감과 대화 기록은 저장돼요.

| 항목 | 값 |
| --- | --- |
| 리전 | 싱가포르 |
| 최대 통화 시간 | 10분 (`MAX_CALL_MINUTES`) |
| 상태 확인 | `/healthz` (비밀번호 없이 열림) |

무료 플랜 주의점:
- 15분 동안 접속이 없으면 서버가 잠들고, 다음 접속 때 켜지는 데 약 1분 걸려요. 잠들지 않게 하려면 Starter(월 $7)로 바꾸면 됩니다.
- 통화 1분에 서버가 내보내는 트래픽이 약 4~5MB예요. 무료 트래픽 한도를 넘지 않는지 Render 대시보드에서 확인하세요.
- Render에서는 `GOOGLE_CLIENT_ID`·`DATABASE_URL`이 없으면 서버가 시작되지 않아요(누구나 내 API 키로 무제한 통화하는 걸 막기 위해). 이때 배포는 실패하고 이전 버전이 계속 돌아가요.
- 서버를 여러 대로 늘리면 "한 계정 한 통화" 제한이 서버마다 따로 걸려요. 지금 구조는 서버 1대 기준이에요.

## 구조

```
server/
  index.js     HTTP 서버: 정적 파일, /api/*, /call WebSocket 업그레이드, 사용 시간 확인
  auth.js      Google ID 토큰 검증, 세션 쿠키
  db.js        Postgres(계정·세션·통화 기록). DATABASE_URL이 없으면 메모리에 통화만 보관
  schema.sql   테이블 정의 (서버 시작 시 자동 적용)
  relay.js     브라우저 ↔ 음성 제공자 중계. 세션 설정(프롬프트·목소리·VAD)은 서버에서만. 대화 기록과 과금 시간 집계
  prompts.js   튜터 페르소나 / 피드백 프롬프트
  feedback.js  통화 후 리포트 생성
  providers/
    gemini.js  Gemini Live 어댑터 (Gemini 프로토콜 ↔ 클라이언트 이벤트 변환)
    grok.js    Grok Voice Agent 어댑터 (OpenAI Realtime 형식이라 거의 그대로 전달)
scripts/
  list-gemini-models.js  내 키로 쓸 수 있는 Gemini Live 모델 목록
  grant-minutes.js       계정에 통화 시간 지급·회수 (npm run grant)
public/
  index.html   로그인 → 설정 → 통화 → 리포트 화면
  app.js       통화 상태, 이벤트 처리, 자막, 리포트 렌더링
  audio.js     마이크 캡처(AudioWorklet → PCM16, Gemini 16kHz / Grok 24kHz) / 스트리밍 재생
  tutors/      튜터 일러스트 (Open Peeps by Pablo Stanley, CC0 — DiceBear로 생성)
```

```
브라우저 ──(ws /call)──▶ Node 서버 ──(wss + API 키)──▶ Gemini Live  또는  Grok Voice
```

브라우저는 항상 같은 형식(OpenAI Realtime 스타일 이벤트)으로 말하고, 제공자별 차이는 `server/providers/`의 어댑터가 흡수합니다. 새 제공자(예: OpenAI gpt-realtime-mini)를 붙일 때도 어댑터 파일 하나만 추가하면 돼요.

API 키는 서버에만 있고, 브라우저는 오디오 전송(`input_audio_buffer.append`)과 끼어들기용 이벤트(`response.cancel`, `conversation.item.truncate`)만 보낼 수 있습니다. 클라이언트가 프롬프트나 모델을 바꿀 수 없습니다.

리포트는 브라우저가 보낸 대화가 아니라 서버가 통화 중에 기록한 대화로 만들고, 통화당 한 번만 생성해 DB에 저장합니다(다시 요청하면 저장된 리포트를 돌려줌). 그래서 텍스트 모델을 통화와 상관없이 쓸 수 없어요.

로그인은 Google Identity Services 버튼으로 받은 ID 토큰을 서버가 Google 공개키로 검증한 뒤, 30일짜리 세션 쿠키(HttpOnly, SameSite=Lax)를 발급하는 방식입니다. DB에는 쿠키 값의 해시만 저장하고, 다른 사이트에서 온 POST와 WebSocket 연결은 거부합니다.

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
| `GOOGLE_CLIENT_ID` | (없음) | Google OAuth 웹 클라이언트 ID. 배포 시 필수 |
| `DATABASE_URL` | (없음) | Postgres 연결 문자열. 배포 시 필수 (`GOOGLE_CLIENT_ID`와 함께) |
| `FREE_TRIAL_MINUTES` | `10` | 새 계정에 주는 무료 통화 시간(분) |

## 튜닝 포인트

- 튜터 말투·교정 규칙: `server/prompts.js`의 `buildTutorInstructions`
- 생각하느라 잠깐 멈췄는데 튜터가 끼어든다면 제공자 어댑터(`server/providers/*.js`)의 무음 판정 시간을 늘리세요 (초급 1200ms, 그 외 800ms)
- 목소리 추가: 각 어댑터의 `voices` 배열 (화면 선택지는 자동으로 따라감)

## 다음 단계 아이디어

- 지난 수업 목록 화면, 자주 틀리는 표현 누적 복습 (기록은 이미 `calls` 테이블에 쌓이고 있음)
- 결제(토스페이먼츠·포트원)로 통화 시간 충전
- 예약 시간에 튜터가 먼저 전화 걸기 (Twilio 등 전화망 연동 — Grok API는 G.711 μ-law 8kHz도 지원)
- 수업 종료 1분 전 튜터가 자연스럽게 마무리하도록 안내
- 레벨 테스트 후 수준 자동 설정
