// api/admin-auth.js
// Admin sign-in / sign-out. Issues an opaque session token stored in Redis.
//
// Sign-in is two steps. The password alone only earns a one-time code,
// emailed to the admin address; the session is issued once that code is
// entered. A leaked or guessed password is therefore not enough on its own.

import crypto from 'crypto';
import { redis, KEYS, withRetry } from './_lib/redis.js';
import { sendRaw } from './_lib/email.js';
import {
  applyCors,
  handlePreflight,
  bearerToken,
  safeEqual,
  rateLimit,
  tooManyRequests,
  clientIp,
  str,
  esc,
  withErrorHandling,
} from './_lib/http.js';

const SESSION_TTL_SECONDS = 8 * 60 * 60;
const CODE_TTL_SECONDS = 600;
const MAX_CODE_ATTEMPTS = 5;
const challengeKey = (id) => `bcci:adminotp:${id}`;

const codeEmail = (code) => `
<div style="font-family:Arial,sans-serif;text-align:center;padding:40px;background:#F1F5F9;">
  <div style="max-width:400px;margin:0 auto;background:#FFF;border-radius:12px;padding:32px;border:1px solid #E2E8F0;">
    <h2 style="color:#0F2C59;margin-bottom:8px;">BCCI Admin Sign-in</h2>
    <p style="color:#64748B;font-size:14px;margin-bottom:24px;">Enter this code to finish signing in to the admin portal</p>
    <div style="font-size:36px;font-weight:bold;letter-spacing:12px;color:#0F2C59;background:#F8FAFC;padding:16px;border-radius:8px;border:2px dashed #D4AF37;">${esc(code)}</div>
    <p style="color:#94A3B8;font-size:12px;margin-top:24px;">This code expires in 10 minutes.</p>
    <p style="color:#B91C1C;font-size:12px;margin-top:8px;">If you did not just sign in, someone has your admin password. Change ADMIN_PASSWORD now.</p>
  </div>
</div>`;

/** Step 2: exchange a challenge + emailed code for a session. */
async function verifyCode(req, res) {
  const challenge = str(req.body?.challenge, 64);
  const code = str(req.body?.code, 12);
  if (!challenge || !code) {
    return res.status(400).json({ error: 'Sign-in code required.' });
  }

  const attempt = await rateLimit(`adminotp:${challenge}`, { max: MAX_CODE_ATTEMPTS, windowSec: CODE_TTL_SECONDS });
  if (!attempt.ok) {
    await redis.del(challengeKey(challenge)).catch((err) => console.warn('[Admin Auth] challenge cleanup failed:', err.message));
    return tooManyRequests(res, attempt.retryAfter, 'Too many incorrect codes. Please sign in again.');
  }

  const pending = await withRetry(() => redis.get(challengeKey(challenge)));
  const stored = typeof pending === 'string' ? JSON.parse(pending) : pending;
  if (!stored?.email || !stored?.code) {
    return res.status(400).json({ error: 'That code has expired. Please sign in again.' });
  }
  if (!safeEqual(code, String(stored.code))) {
    return res.status(401).json({ error: 'Incorrect code.' });
  }
  // Single use: only the request that actually deletes the challenge wins.
  const claimed = await withRetry(() => redis.del(challengeKey(challenge)));
  if (claimed !== 1) {
    return res.status(400).json({ error: 'That code has expired. Please sign in again.' });
  }

  const token = crypto.randomUUID();
  await withRetry(() =>
    redis.set(KEYS.adminSession(token), stored.email, { ex: SESSION_TTL_SECONDS })
  );
  console.log(`[Admin Auth] ${stored.email} signed in`);

  return res.status(200).json({
    success: true,
    session: {
      token,
      username: stored.email,
      createdAt: new Date().toISOString(),
      expiresIn: SESSION_TTL_SECONDS, // seconds
    },
  });
}

async function handler(req, res) {
  applyCors(req, res, 'POST, DELETE, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── Sign out ─────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const token = bearerToken(req);
    if (token) await redis.del(KEYS.adminSession(token)).catch(() => {});
    return res.status(200).json({ success: true, message: 'Signed out' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.body?.challenge !== undefined) return verifyCode(req, res);

  const email = str(req.body?.username, 254).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  // Brute-force protection: the admin password is a single shared secret, so
  // an unlimited guess rate against it is the whole attack.
  const ip = clientIp(req);
  const byIp = await rateLimit(`adminlogin:ip:${ip}`, { max: 10, windowSec: 900 });
  if (!byIp.ok) {
    return tooManyRequests(res, byIp.retryAfter, 'Too many sign-in attempts. Please try again later.');
  }
  const byUser = await rateLimit(`adminlogin:user:${email}`, { max: 10, windowSec: 900 });
  if (!byUser.ok) {
    return tooManyRequests(res, byUser.retryAfter, 'Too many sign-in attempts. Please try again later.');
  }

  const adminEmails = (process.env.ADMIN_EMAILS || process.env.ADMIN_USERNAME || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmails.length || !adminPassword) {
    console.error('[Admin Auth] ADMIN_EMAILS / ADMIN_PASSWORD are not configured');
    return res.status(503).json({ error: 'Admin sign-in is not configured.' });
  }

  // Evaluate both checks before branching, so a wrong username and a wrong
  // password take the same path.
  const emailOk = adminEmails.includes(email);
  const passwordOk = safeEqual(password, adminPassword);
  if (!emailOk || !passwordOk) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Password correct: email a one-time code instead of issuing a session.
  const challenge = crypto.randomUUID();
  const code = crypto.randomInt(100000, 1000000).toString();
  await withRetry(() =>
    redis.set(challengeKey(challenge), { email, code }, { ex: CODE_TTL_SECONDS })
  );
  const sent = await sendRaw({ to: email, subject: 'Your BCCI admin sign-in code', html: codeEmail(code) });
  if (!sent.success) {
    await redis.del(challengeKey(challenge)).catch((err) => console.warn('[Admin Auth] challenge cleanup failed:', err.message));
    return res.status(502).json({ error: 'We could not email your sign-in code. Please try again in a moment.' });
  }

  return res.status(200).json({
    success: true,
    step: 'code',
    challenge,
    message: `A sign-in code was sent to ${email}.`,
  });
}

export default withErrorHandling('AdminAuth', handler);
