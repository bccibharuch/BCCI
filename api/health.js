// api/health.js
// Liveness probe. Reports whether the pieces the portal depends on are
// actually configured and reachable, so a misconfigured deploy is visible
// immediately instead of surfacing as a broken form later.

import { pingKv } from './_lib/kv.js';
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

  const checks = {
    redis: { configured: Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN), reachable: false },
    smtp: { configured: Boolean((process.env.SMTP_USER || process.env.GMAIL_USER) && (process.env.SMTP_PASS || process.env.GMAIL_PASS)) },
    adminAuth: { configured: Boolean((process.env.ADMIN_EMAILS || process.env.ADMIN_USERNAME) && process.env.ADMIN_PASSWORD) },
  };

  // Upstash Redis holds the records, OTP codes, sessions and rate limits.
  if (checks.redis.configured) {
    try {
      checks.redis.reachable = await pingKv();
    } catch (err) {
      // The response is public; an error string can name an internal host,
      // port or credential. Log it, report only that it is unreachable.
      console.error('[health] redis probe failed:', err?.message || err);
    }
  }

  const healthy = checks.redis.configured && checks.redis.reachable && checks.smtp.configured && checks.adminAuth.configured;

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
}

export default withErrorHandling('Health', handler);
