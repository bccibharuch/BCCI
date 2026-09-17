// api/_lib/records.js
// Storage switch for durable records (applications, enquiries, events).
//
//   STORAGE_BACKEND=redis     Upstash Redis (default — Vercel, serverless)
//   STORAGE_BACKEND=postgres  Postgres on the VPS (docker-compose)
//
// OTP codes, sessions and rate-limit counters always stay in Redis: they
// need TTL expiry, not durability. Only this module (and health.js) decide
// where records live; every route imports record functions from here.
//
// The backend is loaded with a top-level await so the unused driver is
// never even imported — importing redis.js constructs its client, which
// throws when Upstash env is absent (postgres mode), and vice versa.

const BACKEND = (process.env.STORAGE_BACKEND || 'redis').trim().toLowerCase();
export const STORAGE_BACKEND = BACKEND === 'postgres' ? 'postgres' : 'redis';

const backend = STORAGE_BACKEND === 'postgres'
  ? await import('./postgres.js')
  : await import('./redis.js');

export const {
  STATUS,
  normalizeStatus,
  listApplications,
  countApplications,
  getApplication,
  getApplicationByEmail,
  putApplication,
  updateApplication,
  listEnquiries,
  countEnquiries,
  putEnquiry,
  trimEnquiries,
  getEvent,
  putEvent,
  listEvents,
  countEvents,
  deleteEvent,
  getEventAttendees,
  registerForEvent,
  confirmEventPayment,
  acquireLock,
  releaseLock,
} = backend;

/** Ensure the backend is ready (creates Postgres tables; no-op on Redis). */
export async function initStorage() {
  if (typeof backend.initSchema === 'function') await backend.initSchema();
}

/** Backend reachability probe for /api/health. */
export async function pingRecords() {
  return backend.ping();
}
