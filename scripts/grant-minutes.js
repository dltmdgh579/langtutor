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
// Accounts are keyed by Google id, so one address can belong to more than one
// (e.g. a deleted and recreated Google account). Never grant to all of them.
const { rows: matches } = await client.query(
  'select id, email, created_at from users where lower(email) = lower($1) order by created_at',
  [email],
);
if (matches.length !== 1) {
  await client.end();
  if (!matches.length) {
    console.error(`${email} 계정이 없습니다. 먼저 한 번 로그인해야 해요.`);
  } else {
    console.error(`${email} 주소를 쓰는 계정이 ${matches.length}개예요. SQL로 id를 지정해서 지급하세요.`);
    for (const row of matches) console.error(`  id ${row.id}, 가입 ${row.created_at.toISOString()}`);
  }
  process.exit(1);
}
const { rows } = await client.query(
  `update users set balance_seconds = greatest(balance_seconds + $2, 0)
   where id = $1 returning email, balance_seconds`,
  [matches[0].id, Math.round(minutes * 60)],
);
await client.end();
console.log(`${rows[0].email}: 남은 시간 ${Math.floor(rows[0].balance_seconds / 60)}분 ${rows[0].balance_seconds % 60}초`);
