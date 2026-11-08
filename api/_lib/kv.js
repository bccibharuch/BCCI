// api/_lib/kv.js
// Key-value state that is not a record: OTP codes, sessions, rate-limit
// counters, applicant accounts and the email log, in Upstash Redis.

import { redis } from './redis.js';

export { KEYS, withRetry } from './keys.js';

export const kv = redis;
