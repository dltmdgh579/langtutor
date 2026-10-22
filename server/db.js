// Storage for accounts, sessions and call records. With DATABASE_URL the data
// lives in Postgres; without it (local development) calls are kept in memory
// and there are no accounts.

import { readFile } from 'node:fs/promises';
import pg from 'pg';

// Calls left open by a crash can't be billed any more. Only touch ones older
// than any real call, so a new instance starting during a deploy doesn't close
// calls the old instance is still serving.
const ORPHAN_CALL_AGE = '2 hours';

// Without these a stalled connection (e.g. Neon waking up, a network drop)
// waits forever, so saving a call never retries and redials hang behind it.
// The query limit is enforced by the client: a server-side statement_timeout
// would be a startup parameter, which Neon's pooled endpoint (PgBouncer) rejects.
const CONNECT_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 5_000;

const isId = (value) => typeof value === 'string' && /^\d{1,18}$/.test(value);

function toUser(row) {
  return {
    id: String(row.id),
    email: row.email,
    name: row.name,
    picture: row.picture,
    balanceSeconds: row.balance_seconds,
  };
}

export async function createDb(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  pool.on('error', (err) => console.error('db pool error:', err.message));
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  await pool.query(
    `update calls set ended_at = now(), end_reason = 'server_restart', billed_seconds = 0
     where ended_at is null and started_at < now() - $1::interval`,
    [ORPHAN_CALL_AGE],
  );

  return {
    async upsertGoogleUser({ sub, email, name, picture }, trialSeconds) {
      // New accounts start with the free trial; returning ones keep their balance.
      const { rows } = await pool.query(
        `insert into users (google_sub, email, name, picture, balance_seconds) values ($1, $2, $3, $4, $5)
         on conflict (google_sub) do update
           set email = excluded.email, name = excluded.name, picture = excluded.picture, last_login_at = now()
         returning *`,
        [sub, email, name, picture, trialSeconds],
      );
      return toUser(rows[0]);
    },

    async createSession(tokenHash, userId, maxAgeSeconds) {
      await pool.query('delete from sessions where expires_at < now()');
      await pool.query(
        `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(secs => $3))`,
        [tokenHash, userId, maxAgeSeconds],
      );
    },

    async userForSession(tokenHash) {
      const { rows } = await pool.query(
        `select u.* from sessions s join users u on u.id = s.user_id
         where s.token_hash = $1 and s.expires_at > now()`,
        [tokenHash],
      );
      return rows[0] ? toUser(rows[0]) : null;
    },

    async deleteSession(tokenHash) {
      await pool.query('delete from sessions where token_hash = $1', [tokenHash]);
    },

    async startCall(userId, provider, options) {
      const { rows } = await pool.query(
        'insert into calls (user_id, provider, options) values ($1, $2, $3) returning id',
        [userId, provider, options],
      );
      return String(rows[0].id);
    },

    // Records the end of a call and deducts its time in one statement. Only
    // the first save counts: a retry after a timed-out attempt that did commit
    // must not deduct twice.
    async finishCall(callId, { billedSeconds, reason, transcript }) {
      await pool.query(
        `with c as (
           update calls set ended_at = now(), end_reason = $2, billed_seconds = $3, transcript = $4
           where id = $1 and ended_at is null returning user_id
         )
         update users set balance_seconds = greatest(balance_seconds - $3, 0) from c where users.id = c.user_id`,
        [callId, reason, billedSeconds, JSON.stringify(transcript)],
      );
    },

    async getCall(callId, userId) {
      if (!isId(callId)) return null;
      const { rows } = await pool.query(
        'select options, transcript, feedback from calls where id = $1 and user_id = $2',
        [callId, userId],
      );
      return rows[0] ?? null;
    },

    async saveFeedback(callId, feedback) {
      await pool.query('update calls set feedback = $2 where id = $1', [callId, feedback]);
    },

    // Records a payment and adds its time in one statement. A transaction
    // already recorded changes nothing, so redelivered webhooks are harmless.
    // Returns whether it was new and whether an account got the time.
    async creditPayment({ transactionId, userId, seconds, amount, currency }) {
      const { rows } = await pool.query(
        `with p as (
           insert into payments (paddle_transaction_id, user_id, seconds, amount, currency)
           values ($1, (select id from users where id = $2), $3, $4, $5)
           on conflict (paddle_transaction_id) do nothing
           returning user_id, seconds
         ), u as (
           update users set balance_seconds = balance_seconds + p.seconds from p
           where users.id = p.user_id returning users.id
         )
         select (select count(*) from p)::int as inserted, (select count(*) from u)::int as credited`,
        [transactionId, isId(userId) ? userId : null, seconds, amount, currency],
      );
      return { inserted: rows[0].inserted > 0, credited: rows[0].credited > 0 };
    },

    // Takes back a refunded payment's time: all of it for a full refund, the
    // refunded share for a partial one, never more than is left unrevoked.
    // Time already spent can't be taken back below zero.
    async revokePayment({ adjustmentId, transactionId, action, amount }) {
      const { rows } = await pool.query(
        `with pay as (
           select p.id, p.user_id, p.amount,
             p.seconds - coalesce((select sum(seconds) from payment_adjustments where payment_id = p.id), 0) as unrevoked,
             p.seconds
           from payments p where p.paddle_transaction_id = $2
         ), a as (
           insert into payment_adjustments (paddle_adjustment_id, payment_id, action, seconds)
           select $1, pay.id, $3, greatest(least(pay.unrevoked,
             case when pay.amount <= 0 or $4::bigint >= pay.amount then pay.seconds
                  else ceil(pay.seconds * $4::numeric / pay.amount)::int end), 0)
           from pay
           on conflict (paddle_adjustment_id) do nothing
           returning seconds
         ), u as (
           update users set balance_seconds = greatest(balance_seconds - a.seconds, 0) from a, pay
           where users.id = pay.user_id returning users.id
         )
         select (select count(*) from pay)::int as found, (select count(*) from a)::int as applied,
           (select seconds from a) as seconds`,
        [adjustmentId, transactionId, action, amount],
      );
      return { found: rows[0].found > 0, applied: rows[0].applied > 0, seconds: rows[0].seconds };
    },

    close: () => pool.end(),
  };
}

// Local development: no accounts, just enough to hand the transcript of a
// finished call to the report.
export function createMemoryDb() {
  const MAX_CALLS = 50;
  const calls = new Map();
  let nextId = 1;

  return {
    async startCall(userId, provider, options) {
      const id = String(nextId++);
      calls.set(id, { userId, options, transcript: null, feedback: null });
      if (calls.size > MAX_CALLS) calls.delete(calls.keys().next().value);
      return id;
    },
    async finishCall(callId, { transcript }) {
      const call = calls.get(callId);
      if (call) call.transcript = transcript;
    },
    async getCall(callId, userId) {
      const call = calls.get(callId);
      return call?.userId === userId ? call : null;
    },
    async saveFeedback(callId, feedback) {
      const call = calls.get(callId);
      if (call) call.feedback = feedback;
    },
    close: async () => {},
  };
}
