// Adds (or with a negative number, removes) call minutes for an account,
// e.g. for beta testers before payments exist. The person must have signed in once.
// Usage: npm run grant -- someone@gmail.com 30

import pg from 'pg';

const [email, minutesArg] = process.argv.slice(2);
const minutes = Number(minutesArg);
if (!email || !Number.isFinite(minutes)) {
  console.error('사용법: npm run grant -- <이메일> <분>   예) npm run grant -- someone@gmail.com 30');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL이 설정되지 않았습니다.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query(
  `update users set balance_seconds = greatest(balance_seconds + $2, 0)
   where lower(email) = lower($1) returning email, balance_seconds`,
  [email, Math.round(minutes * 60)],
);
await client.end();

if (!rows.length) {
  console.error(`${email} 계정이 없습니다. 먼저 한 번 로그인해야 해요.`);
  process.exit(1);
}
for (const row of rows) {
  console.log(`${row.email}: 남은 시간 ${Math.floor(row.balance_seconds / 60)}분 ${row.balance_seconds % 60}초`);
}
