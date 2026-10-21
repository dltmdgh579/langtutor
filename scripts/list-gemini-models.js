// Lists the Gemini models your API key can use with the Live API
// (supportedGenerationMethods includes "bidiGenerateContent").
// Usage: npm run gemini:models

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY가 설정되지 않았습니다.');
  process.exit(1);
}

const live = [];
let pageToken = '';
do {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) {
    console.error(`모델 목록 조회 실패: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  for (const model of data.models ?? []) {
    if (model.supportedGenerationMethods?.includes('bidiGenerateContent')) live.push(model);
  }
  pageToken = data.nextPageToken ?? '';
} while (pageToken);

console.log('Live API 지원 모델 (GEMINI_VOICE_MODEL에 넣을 값):');
for (const model of live) console.log(`  ${model.name.replace(/^models\//, '')}  — ${model.displayName ?? ''}`);
