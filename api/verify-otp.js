// api/verify-otp.js
// Checks a verification code and issues a server-side applicant session.

import crypto from 'crypto';
import { kv, KEYS, withRetry } from './_lib/kv.js';
import {
  applyCors,
  handlePreflight,
  bearerToken,
  rateLimit,
  refundRateLimit,
  clientIp,
  tooManyRequests,
  safeEqual,
  str,
  isSafeEmail,
  withErrorHandling,
} from './_lib/http.js';

const MAX_ATTEMPTS = 5;
const MAX_ATTEMPTS_PER_EMAIL = 20;
const MAX_WRONG_CODES_PER_DAY = 30;
const SESSION_TTL_SECONDS = 24 * 60 * 60;

async function handler(req, res) {
  applyCors(req, res, 'POST, DELETE, OPTIONS');
  if (handlePreflight(req, res)) return;

  // Sign out — invalidate the applicant's session server-side.
  if (req.method === 'DELETE') {
    const token = bearerToken(req);
    if (token) await kv.del(KEYS.applicantSession(token)).catch(() => {});
    return res.status(200).json({ success: true, message: 'Signed out' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  const email = str(req.body?.email, 254).toLowerCase();
  const code = str(req.body?.code, 12);
  const name = str(req.body?.name, 120);

  if (!isSafeEmail(email)) {
    return res.status(400).json({ success: false, error: 'A valid email address is required.' });
  }
  if (!code) {
    return res.status(400).json({ success: false, error: 'Verification code is required.' });
  }

  // The counter's TTL is set only when it is created, so repeated wrong
  // guesses can no longer keep extending their own window.
  // Per (email, IP) so one caller cannot lock the real owner out, plus a looser
  // per-email ceiling that keeps distributed guessing bounded. A tripped limiter
  // never deletes the pending code: that would let anyone burn a victim's OTP.
  // The ceiling is consulted only once the per-IP check passes, so requests one
  // network is already refused cannot keep counting toward everyone's limit.
  const ipKey = `otpverify:${email}:${clientIp(req)}`;
  const attempt = await rateLimit(ipKey, { max: MAX_ATTEMPTS, windowSec: 600 });
  if (!attempt.ok) {
    return tooManyRequests(res, attempt.retryAfter, 'Too many incorrect attempts. Please request a new verification code.');
  }
  const ceiling = await rateLimit(`otpverify:all:${email}`, { max: MAX_ATTEMPTS_PER_EMAIL, windowSec: 600 });
  if (!ceiling.ok) {
    return tooManyRequests(res, ceiling.retryAfter, 'Too many incorrect attempts. Please request a new verification code.');
  }

  // Wrong guesses per address per day. The limits above start afresh with every
  // new code, and ten codes a day would otherwise allow about 200 guesses at a
  // six-digit code. Counted up front so parallel guesses cannot slip past, and
  // given back unless the guess was actually wrong.
  const dailyKey = `otpfail:daily:${email}`;
  const daily = await rateLimit(dailyKey, { max: MAX_WRONG_CODES_PER_DAY, windowSec: 86400 });
  if (!daily.ok) {
    return tooManyRequests(res, daily.retryAfter, 'Too many incorrect codes for this address today. Please try again tomorrow.');
  }

  const storedOtp = await withRetry(() => kv.get(`bcci:otp:${email}`));
  if (!storedOtp) {
    await refundRateLimit(dailyKey);
    return res.status(400).json({
      success: false,
      error: 'That code has expired or was already used. Please request a new one.',
    });
  }

  if (!safeEqual(code, String(storedOtp))) {
    const remaining = Math.max(0, attempt.remaining ?? 0);
    return res.status(400).json({
      success: false,
      error: remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'Too many incorrect attempts. Please request a new verification code.',
    });
  }

  await refundRateLimit(dailyKey);

  // Atomic single-use claim: only the first concurrent request can claim this OTP
  const claimed = await kv.set(`bcci:otp:claimed:${email}`, '1', { nx: true, ex: 60 });
  if (!claimed) {
    return res.status(400).json({
      success: false,
      error: 'That code has expired or was already used. Please request a new one.',
    });
  }

  // Success — clear the code and the attempt counter.
  await kv.del(`bcci:otp:${email}`).catch(() => {});
  await kv.del(`bcci:rl:otpverify:all:${email}`).catch(() => {});
  await kv.del(`bcci:rl:${ipKey}`).catch(() => {});

  // Issue an opaque server-side token. The old response was an unsigned JSON
  // object the browser simply stored, so anyone could hand-write one in the
  // console and be treated as any member.
  const token = crypto.randomUUID();
  const sessionData = { email, issuedAt: Date.now() };
  await withRetry(() =>
    kv.set(KEYS.applicantSession(token), sessionData, { ex: SESSION_TTL_SECONDS })
  );

  console.log(`[OTP] verified ${email}`);

  return res.status(200).json({
    success: true,
    message: 'Verification successful.',
    session: {
      token,
      email,
      name: name || email.split('@')[0],
      authenticatedAt: new Date().toISOString(),
      authMethod: 'email_otp',
      expiresIn: SESSION_TTL_SECONDS, // seconds
    },
  });
}

export default withErrorHandling('VerifyOtp', handler);
