// api/health.js
// Liveness probe. Reports whether the pieces the portal depends on are
// actually configured and reachable, so a misconfigured deploy is visible
// immediately instead of surfacing as a broken form later.

import { pingKv } from './_lib/kv.js';
import { STORAGE_BACKEND, pingRecords } from './_lib/records.js';
import { applyCors, handlePreflight, withErrorHandling } from './_lib/http.js';

async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (handlePreflight(req, res)) return;

  // Liveness: is the process up? Touches no dependency, so a load balancer /
  // orchestrator can tell "restart me" apart from "temporarily can't reach the
  // DB" (which should shed load, not kill the process).
  if (req.query?.probe === 'live') {
    return res.status(200).json({ status: 'ok', probe: 'live', uptimeSec: Math.round(process.uptime()) });
  }

  const pgMode = STORAGE_BACKEND === 'postgres';
  const checks = {
    storageBackend: STORAGE_BACKEND,
    smtp: { configured: Boolean((process.env.SMTP_USER || process.env.GMAIL_USER) && (process.env.SMTP_PASS || process.env.GMAIL_PASS)) },
    adminAuth: { configured: Boolean((process.env.ADMIN_EMAILS || process.env.ADMIN_USERNAME) && process.env.ADMIN_PASSWORD) },
  };

  // On the VPS one Postgres database holds the records and the OTP codes,
  // sessions and rate limits. On serverless those live in Upstash Redis.
  if (pgMode) {
    checks.postgres = { configured: Boolean(process.env.DATABASE_URL), reachable: false };
    if (checks.postgres.configured) {
      try {
        checks.postgres.reachable = (await pingRecords()) && (await pingKv());
      } catch (err) {
        // The response is public; an error string can name an internal host,
        // port or credential. Log it, report only that it is unreachable.
        console.error('[health] postgres probe failed:', err?.message || err);
      }
    }
  } else {
    checks.redis = { configured: Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN), reachable: false };
    if (checks.redis.configured) {
      try {
        checks.redis.reachable = await pingKv();
      } catch (err) {
        // See above: log the detail, never send it to the caller.
        console.error('[health] redis probe failed:', err?.message || err);
      }
    }
  }

  const store = pgMode ? checks.postgres : checks.redis;
  const healthy = store.configured && store.reachable && checks.smtp.configured && checks.adminAuth.configured;

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
}

export default withErrorHandling('Health', handler);
