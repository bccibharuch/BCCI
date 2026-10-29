// api/_lib/kv.js
// Key-value state that is not a record: OTP codes, sessions, rate-limit
// counters, applicant accounts and the email log.
//
//   STORAGE_BACKEND=redis     Upstash Redis (Vercel, serverless)
//   STORAGE_BACKEND=postgres  a `kv` table in the records database (the VPS)
//
// On a single server that keeps everything in one database with one backup.
// Only the Redis commands the routes use are offered — get, mget, set
// (ex / nx), del, incr, decr, expire, ttl — with Redis semantics, so callers cannot tell
// which backend answered. Expired rows read as absent and are swept on a
// timer by the long-running server.

import crypto from 'node:crypto';
import { STORAGE_BACKEND } from './records.js';

export { KEYS, withRetry } from './keys.js';

/** Postgres implementation of the Redis command subset the routes use. */
function postgresKv(query) {
  const live = '(expires_at IS NULL OR expires_at > now())';
  const seconds = (n) => {
    const s = Number(n);
    if (!Number.isInteger(s) || s <= 0) throw new Error(`kv: expiry must be a positive whole number of seconds, got ${n}`);
    return s;
  };

  return {
    async get(key) {
      const r = await query(`SELECT value FROM kv WHERE key = $1 AND ${live}`, [key]);
      return r.rows.length ? r.rows[0].value : null;
    },

    /** Mirrors Redis SET: 'OK', or null when `nx` finds a live key. */
    async set(key, value, { ex, nx } = {}) {
      if (value === undefined) throw new Error(`kv: refusing to store undefined at ${key}`);
      const expires = ex === undefined ? null : seconds(ex);
      const params = [key, JSON.stringify(value), expires];
      const expiresSql = `CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(secs => $3::int) END`;
      const sql = nx
        ? `INSERT INTO kv (key, value, expires_at) VALUES ($1, $2::jsonb, ${expiresSql})
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
           WHERE kv.expires_at IS NOT NULL AND kv.expires_at <= now()
           RETURNING key`
        : `INSERT INTO kv (key, value, expires_at) VALUES ($1, $2::jsonb, ${expiresSql})
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
           RETURNING key`;
      const r = await query(sql, params);
      return r.rows.length ? 'OK' : null;
    },

    /** Values for each key, in order; null where a key is absent. */
    async mget(...keys) {
      if (!keys.length) return [];
      const r = await query(`SELECT key, value FROM kv WHERE key = ANY($1::text[]) AND ${live}`, [keys]);
      const byKey = new Map(r.rows.map((row) => [row.key, row.value]));
      return keys.map((k) => (byKey.has(k) ? byKey.get(k) : null));
    },

    /** Number of live keys removed. */
    async del(...keys) {
      if (!keys.length) return 0;
      const r = await query(`DELETE FROM kv WHERE key = ANY($1::text[]) RETURNING ${live} AS was_live`, [keys]);
      return r.rows.filter((row) => row.was_live).length;
    },

    /** Atomic increment that keeps an existing TTL, like Redis INCR. */
    async incr(key) {
      const r = await query(
        `INSERT INTO kv (key, value, expires_at) VALUES ($1, '1'::jsonb, NULL)
         ON CONFLICT (key) DO UPDATE SET
           value = CASE WHEN kv.expires_at IS NOT NULL AND kv.expires_at <= now() THEN '1'::jsonb
                        ELSE to_jsonb((kv.value #>> '{}')::bigint + 1) END,
           expires_at = CASE WHEN kv.expires_at IS NOT NULL AND kv.expires_at <= now() THEN NULL
                             ELSE kv.expires_at END
         RETURNING value`,
        [key]
      );
      return Number(r.rows[0].value);
    },

    /** Atomic decrement that keeps an existing TTL, like Redis DECR. */
    async decr(key) {
      const r = await query(
        `INSERT INTO kv (key, value, expires_at) VALUES ($1, '-1'::jsonb, NULL)
         ON CONFLICT (key) DO UPDATE SET
           value = CASE WHEN kv.expires_at IS NOT NULL AND kv.expires_at <= now() THEN '-1'::jsonb
                        ELSE to_jsonb((kv.value #>> '{}')::bigint - 1) END,
           expires_at = CASE WHEN kv.expires_at IS NOT NULL AND kv.expires_at <= now() THEN NULL
                             ELSE kv.expires_at END
         RETURNING value`,
        [key]
      );
      return Number(r.rows[0].value);
    },

    /** 1 when a live key now expires in `sec` seconds, else 0. */
    async expire(key, sec) {
      const r = await query(
        `UPDATE kv SET expires_at = now() + make_interval(secs => $2::int) WHERE key = $1 AND ${live}`,
        [key, seconds(sec)]
      );
      return r.rowCount;
    },

    /** Seconds left; -1 for no expiry, -2 when absent — as Redis TTL. */
    async ttl(key) {
      const r = await query(
        `SELECT CASE WHEN expires_at IS NULL THEN -1
                     ELSE GREATEST(1, ceil(extract(epoch FROM expires_at - now())))::int END AS ttl
         FROM kv WHERE key = $1 AND ${live}`,
        [key]
      );
      return r.rows.length ? Number(r.rows[0].ttl) : -2;
    },
  };
}

const pg = STORAGE_BACKEND === 'postgres' ? await import('./postgres.js') : null;

export const kv = pg ? postgresKv(pg.query) : (await import('./redis.js')).redis;

/** kv is reachable and round-trips a value. Used by /api/health. */
export async function pingKv() {
  const probe = `bcci:health:${crypto.randomUUID()}`;
  await kv.set(probe, '1', { ex: 10 });
  const v = await kv.get(probe);
  await kv.del(probe).catch(() => {});
  return v === '1' || v === 1;
}

/**
 * Deletes expired rows. Redis expires keys itself; the Postgres table needs
 * this run periodically. Returns the number removed (0 on Redis).
 */
export async function sweepExpiredKv() {
  if (!pg) return 0;
  const r = await pg.query('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= now()');
  return r.rowCount;
}
