// api/_lib/keys.js
// Key names and the retry helper shared by both storage backends. Kept apart
// from redis.js so the Postgres build never has to construct an Upstash
// client just to name a session key.

// ── Key layout ─────────────────────────────────────────────────────
export const KEYS = {
  app: (id) => `bcci:app:${id}`,
  appSummary: (id) => `bcci:app_summary:${id}`,
  appIndex: 'bcci:app_index',
  appByEmail: (email) => `bcci:app_email:${String(email).trim().toLowerCase()}`,
  appLegacy: 'bcci:applications',

  enq: (id) => `bcci:enq:${id}`,
  enqIndex: 'bcci:enq_index',
  enqLegacy: 'bcci:enquiries',

  adminSession: (token) => `admin:${token}`,
  applicantSession: (token) => `applicant:${token}`,

  account: (email) => `bcci:account:${String(email).trim().toLowerCase()}`,
  otpReset: (email) => `bcci:otp:reset:${String(email).trim().toLowerCase()}`,

  event: (id) => `bcci:event:${id}`,
  eventIndex: 'bcci:event_index',
  eventAttendees: (id) => `bcci:event_attendees:${id}`,

  plan: (id) => `bcci:plan:${id}`,
  planIndex: 'bcci:plan_index',

  migrated: (what) => `bcci:migrated:${what}`,

  boardMemberSeq: 'bcci:board:seq:member',
  boardMember: (id) => `bcci:board:member:${id}`,
  boardMemberByEmail: (email) => `bcci:board:member_email:${String(email).trim().toLowerCase()}`,
  boardMeetingSeq: 'bcci:board:seq:meeting',
  boardMeeting: (id) => `bcci:board:meeting:${id}`,
  boardAttendance: (meetingId, memberId) => `bcci:board:att:${meetingId}:${memberId}`,
  boardSession: (token) => `board:${token}`,
  boardOtp: (email) => `bcci:board:otp:${String(email).trim().toLowerCase()}`,
  boardOtpTries: (email) => `bcci:board:otp_tries:${String(email).trim().toLowerCase()}`,
  boardOtpClaim: (email) => `bcci:board:otp_claim:${String(email).trim().toLowerCase()}`,
};

/**
 * Retry a storage operation a couple of times before giving up. Upstash and
 * Postgres are network hops; a single transient failure should not surface
 * as a 500 to an applicant who is halfway through a form.
 */
export async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 120 * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}
