// api/_lib/record-fields.js
// Record shapes shared by both storage backends and the routes, so a new
// upload field or ticket format only has to be added in one place.

import { randomBytes } from 'node:crypto';

// Certificates an applicant may upload, validated by applications.js.
export const UPLOADED_CERTIFICATES = [
  { key: 'gstCertProof', label: 'GST certificate', required: true },
  { key: 'panCertProof', label: 'PAN certificate', required: true },
  { key: 'regCertProof', label: 'Registration certificate', required: false },
  { key: 'repAttachment', label: 'Representative attachment', required: false },
];

// Every field holding a base64 upload (hundreds of KB each). List views only
// need to know whether one exists, so they read summaries without them.
export const DOCUMENT_FIELDS = ['paymentProof', ...UPLOADED_CERTIFICATES.map((d) => d.key)];

/** Copy of an application with each upload reduced to a '[document]' marker. */
export function summarizeApplication(app) {
  if (!app) return null;
  const summary = { ...app };
  for (const f of DOCUMENT_FIELDS) summary[f] = app[f] ? '[document]' : '';
  return summary;
}

/**
 * Candidate ticket ID for an event. Confirmation looks tickets up by ID, so
 * callers must re-draw on the (40-bit, unlikely) clash with an existing one.
 */
export function newTicketId(eventId) {
  return `TKT-${String(eventId).replace(/^EVT-/, '')}-${randomBytes(5).toString('hex').toUpperCase()}`;
}

const CHECK_IN_METHODS = ['scan', 'manual'];

/**
 * The check-in transition for one attendee, shared by both backends so they
 * agree on every rule. Returns { success, attendee, changed,
 * alreadyCheckedIn } or { success: false, code, error } without mutating
 * the input.
 */
export function applyCheckIn(attendee, { checkedIn = true, by = 'admin', method = 'scan' } = {}) {
  const wasCheckedIn = Boolean(attendee.checkedInAt);

  if (!checkedIn) {
    if (!wasCheckedIn) return { success: true, attendee, changed: false, alreadyCheckedIn: false };
    const { checkedInAt, checkedInBy, checkInMethod, ...rest } = attendee;
    return { success: true, attendee: rest, changed: true, alreadyCheckedIn: false };
  }

  if (wasCheckedIn) return { success: true, attendee, changed: false, alreadyCheckedIn: true };

  if (attendee.status === 'pending' || attendee.paymentStatus === 'pending_verification') {
    return {
      success: false,
      code: 'payment_pending',
      error: 'Payment for this ticket has not been verified yet.',
      attendee,
    };
  }

  return {
    success: true,
    attendee: {
      ...attendee,
      checkedInAt: new Date().toISOString(),
      checkedInBy: String(by || 'admin'),
      checkInMethod: CHECK_IN_METHODS.includes(method) ? method : 'scan',
    },
    changed: true,
    alreadyCheckedIn: false,
  };
}
