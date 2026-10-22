// Paddle Billing. The browser opens Paddle's checkout overlay (Paddle.js); call
// time is credited only from Paddle's signed webhooks, never from anything the
// browser reports. Each pack is a one-time Paddle price worth a set number of
// minutes (PADDLE_PRICES). Without PADDLE_* (local development) there is no checkout.

import { createHmac, timingSafeEqual } from 'node:crypto';

// Paddle signs each delivery (and each retry) when it sends it; older
// signatures are treated as replays. Generous to allow for clock skew.
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;
const MAX_WEBHOOK_BYTES = 256 * 1024;

// Adjustments that take the money back, so the minutes go too.
const REVOKING_ACTIONS = new Set(['refund', 'chargeback']);

// "pri_01abc:60,pri_01def:300" -> [{ priceId, minutes }]
function parsePacks(value) {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [priceId, minutesText] = entry.split(':').map((part) => part?.trim());
    const minutes = Number(minutesText);
    if (!/^pri_\w+$/.test(priceId ?? '') || !Number.isInteger(minutes) || minutes <= 0) {
      throw new Error(`PADDLE_PRICES 항목을 읽지 못했어요: "${entry}" (예: pri_01abc:60)`);
    }
    return { priceId, minutes };
  });
}

// Returns null when payments are off; throws when they're half configured.
export function readPaddleConfig(env) {
  const keys = ['PADDLE_CLIENT_TOKEN', 'PADDLE_WEBHOOK_SECRET', 'PADDLE_PRICES'];
  const set = keys.filter((key) => env[key]);
  if (!set.length) return null;
  if (set.length < keys.length) {
    throw new Error(`결제를 쓰려면 ${keys.join(', ')}를 모두 설정하세요. (빠진 것: ${keys.filter((key) => !env[key]).join(', ')})`);
  }
  const environment = env.PADDLE_ENV || 'sandbox';
  if (!['sandbox', 'production'].includes(environment)) {
    throw new Error(`PADDLE_ENV는 sandbox 또는 production이어야 해요. (지금: ${environment})`);
  }
  const packs = parsePacks(env.PADDLE_PRICES);
  if (!packs.length) throw new Error('PADDLE_PRICES에 충전 상품이 없어요.');
  return { environment, clientToken: env.PADDLE_CLIENT_TOKEN, webhookSecret: env.PADDLE_WEBHOOK_SECRET, packs };
}

// Paddle-Signature: "ts=1671552777;h1=<hex>" (more than one h1 while a secret is rotated).
export function verifySignature(header, rawBody, secret, nowSeconds = Date.now() / 1000) {
  const parts = String(header ?? '').split(';').map((part) => part.split('='));
  const ts = parts.find(([key]) => key === 'ts')?.[1];
  const signatures = parts.filter(([key]) => key === 'h1').map(([, value]) => value ?? '');
  if (!/^\d+$/.test(ts ?? '') || !signatures.length) return false;
  if (Math.abs(nowSeconds - Number(ts)) > SIGNATURE_MAX_AGE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${ts}:`).update(rawBody).digest();
  return signatures.some((signature) => {
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

async function readRaw(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_WEBHOOK_BYTES) throw new Error('Webhook body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createPayments(config, db) {
  const minutesByPrice = new Map(config.packs.map((pack) => [pack.priceId, pack.minutes]));

  async function onTransactionCompleted(txn) {
    let seconds = 0;
    for (const item of txn.items ?? []) {
      const minutes = minutesByPrice.get(item.price?.id ?? item.price_id);
      if (minutes) seconds += minutes * 60 * (item.quantity ?? 1);
      else console.warn(`[paddle ${txn.id}] price ${item.price?.id ?? item.price_id} is not in PADDLE_PRICES`);
    }
    const result = await db.creditPayment({
      transactionId: txn.id,
      userId: txn.custom_data?.userId,
      seconds,
      amount: txn.details?.totals?.total ?? '0',
      currency: txn.currency_code ?? '',
    });
    if (!result.inserted) return; // a redelivery of a payment we already have
    if (result.credited) console.log(`[paddle ${txn.id}] credited ${seconds}s to user ${txn.custom_data.userId}`);
    else console.error(`[paddle ${txn.id}] paid, but no account matches custom_data ${JSON.stringify(txn.custom_data)}: grant ${seconds}s by hand`);
  }

  async function onAdjustment(adjustment) {
    if (adjustment.status !== 'approved' || !REVOKING_ACTIONS.has(adjustment.action)) return;
    const result = await db.revokePayment({
      adjustmentId: adjustment.id,
      transactionId: adjustment.transaction_id,
      action: adjustment.action,
      amount: adjustment.totals?.total ?? '0',
    });
    if (!result.found) console.error(`[paddle ${adjustment.transaction_id}] ${adjustment.action} for a payment we have no record of`);
    else if (result.applied) console.log(`[paddle ${adjustment.transaction_id}] ${adjustment.action}: took back ${result.seconds}s`);
  }

  return {
    // Safe to send to the browser.
    clientConfig: { environment: config.environment, clientToken: config.clientToken, packs: config.packs },

    // Answers 2xx only once the event is handled, so Paddle retries anything that failed.
    async handleWebhook(req, res) {
      const body = await readRaw(req);
      if (!verifySignature(req.headers['paddle-signature'], body, config.webhookSecret)) {
        console.warn('paddle webhook: bad signature');
        res.writeHead(401).end();
        return;
      }
      const event = JSON.parse(body.toString('utf8'));
      if (event.event_type === 'transaction.completed') await onTransactionCompleted(event.data);
      else if (event.event_type === 'adjustment.created' || event.event_type === 'adjustment.updated') await onAdjustment(event.data);
      res.writeHead(200).end();
    },
  };
}
