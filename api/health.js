// api/health.js
// Liveness probe. Reports whether the pieces the portal depends on are
// actually configured and reachable, so a misconfigured deploy is visible
// immediately instead of surfacing as a broken form later.

import { ping } from './_lib/redis.js';
import { STORAGE_BACKEND, pingRecords } from './_lib/records.js';
import { applyCors, handlePreflight, withErrorHandling } from './_lib/http.js';

async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (handlePreflight(req, res)) return;

  const pgMode = STORAGE_BACKEND === 'postgres';
  const checks = {
    storageBackend: STORAGE_BACKEND,
    redis: { configured: Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN), reachable: false },
    smtp: { configured: Boolean((process.env.SMTP_USER || process.env.GMAIL_USER) && (process.env.SMTP_PASS || process.env.GMAIL_PASS)) },
    adminAuth: { configured: Boolean((process.env.ADMIN_EMAILS || process.env.ADMIN_USERNAME) && process.env.ADMIN_PASSWORD) },
  };
  if (pgMode) {
    checks.postgres = { configured: Boolean(process.env.DATABASE_URL), reachable: false };
  }

  if (checks.redis.configured) {
    try {
      checks.redis.reachable = await ping();
    } catch (err) {
      checks.redis.error = err.message;
    }
  }

  if (pgMode && checks.postgres.configured) {
    try {
      checks.postgres.reachable = await pingRecords();
    } catch (err) {
      checks.postgres.error = err.message;
    }
  }

  // Redis stays mandatory (OTP, sessions, rate limits). Postgres records are
  // mandatory only when selected as the record backend.
  const healthy =
    checks.redis.configured &&
    checks.redis.reachable &&
    (!pgMode || checks.postgres.reachable) &&
    checks.smtp.configured &&
    checks.adminAuth.configured;

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
}

export default withErrorHandling('Health', handler);
