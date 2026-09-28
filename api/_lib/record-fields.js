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
