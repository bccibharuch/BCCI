// api/_lib/kv.js
// Key-value state that is not a record: OTP codes, sessions, rate-limit
// counters, applicant accounts and the email log, in Upstash Redis.

import crypto from 'node:crypto';
import { redis } from './redis.js';

export { KEYS, withRetry } from './keys.js';

export const kv = redis;

/** kv is reachable and round-trips a value. Used by /api/health. */
export async function pingKv() {
  const probe = `bcci:health:${crypto.randomUUID()}`;
  await kv.set(probe, '1', { ex: 10 });
  const v = await kv.get(probe);
  await kv.del(probe).catch(() => {});
  return v === '1' || v === 1;
}
