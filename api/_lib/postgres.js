// api/_lib/postgres.js
// Postgres record store — the VPS/docker backend for durable records.
//
// Same function names and semantics as api/_lib/redis.js for applications,
// enquiries and events, so callers switch backends without logic changes.
// Ephemeral data (OTP codes, sessions, rate-limit counters) stays in Redis
// by design: it needs TTL expiry, not durability.
//
// Each record is stored whole as JSONB plus a few indexed columns (status,
// email, timestamps) for listing and filtering. Updates run inside a
// transaction with SELECT … FOR UPDATE, so concurrent edits to the same
// record serialise instead of silently clobbering each other.

import pg from 'pg';

const { Pool } = pg;

let pool = null;

/** Override the pool (tests inject an in-memory database here). */
export function setPool(p) {
  pool = p;
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => console.error('[postgres] idle client error', err?.message || err));
  }
  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

/** Create tables/indexes when missing. Safe to run on every boot. */
export async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      data JSONB NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS applications_email_uidx
      ON applications (lower(email)) WHERE email IS NOT NULL AND email <> '';
    CREATE INDEX IF NOT EXISTS applications_status_idx ON applications (status);
    CREATE INDEX IF NOT EXISTS applications_submitted_idx ON applications (submitted_at DESC);

    CREATE TABLE IF NOT EXISTS enquiries (
      id TEXT PRIMARY KEY,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      data JSONB NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS enquiries_submitted_idx ON enquiries (submitted_at DESC);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      event_date TIMESTAMPTZ,
      registered_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      data JSONB NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS events_date_idx ON events (event_date DESC NULLS LAST);

    CREATE TABLE IF NOT EXISTS event_attendees (
      event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
      ticket_id TEXT NOT NULL,
      email TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      data JSONB NOT NULL DEFAULT '{}',
      PRIMARY KEY (event_id, ticket_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS event_attendees_email_uidx
      ON event_attendees (event_id, lower(email));

    CREATE TABLE IF NOT EXISTS locks (
      name TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
}

/** Postgres is reachable and responding. Used by /api/health. */
export async function ping() {
  const r = await query('SELECT 1 AS ok');
  return r.rows?.[0]?.ok === 1;
}

// ── Status normalisation (mirrors redis.js) ──────────────────────

export const STATUS = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export function normalizeStatus(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'approved') return STATUS.APPROVED;
  if (s === 'rejected' || s === 'declined') return STATUS.REJECTED;
  return STATUS.PENDING;
}

function normalizeApplication(app) {
  if (!app || typeof app !== 'object') return null;
  return { ...app, status: normalizeStatus(app.status) };
}

function timeOf(record) {
  const t = Date.parse(record?.submittedAt || '');
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

function conflictError(email, existingId) {
  const err = new Error(`An application for this email already exists (${existingId || 'in progress'}).`);
  err.statusCode = 409;
  return err;
}

// ── Cooperative locks (pool-safe; no session affinity needed) ────
// Token-checked like the Redis backend: release only clears the row when
// the token still matches, so a slow holder can never release the next
// holder's lock. Returns the token, or null when the lock stayed busy.

export async function acquireLock(name, ttlSeconds = 5, waits = 30, waitMs = 40) {
  const { randomUUID } = await import('node:crypto');
  const token = randomUUID();
  for (let i = 0; i < waits; i++) {
    await query('DELETE FROM locks WHERE name = $1 AND expires_at <= now()', [name]);
    const r = await query(
      'INSERT INTO locks (name, token, expires_at) VALUES ($1, $2, now() + ($3 || \' seconds\')::interval) ON CONFLICT (name) DO NOTHING RETURNING name',
      [name, token, String(ttlSeconds)]
    );
    if (r.rowCount > 0) return token;
    await new Promise((res) => setTimeout(res, waitMs));
  }
  return null;
}

export async function releaseLock(name, token) {
  if (token) {
    await query('DELETE FROM locks WHERE name = $1 AND token = $2', [name, token]).catch(() => {});
  } else {
    await query('DELETE FROM locks WHERE name = $1', [name]).catch(() => {});
  }
}

// ── Applications ─────────────────────────────────────────────────

function rowToApp(row) {
  if (!row) return null;
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return normalizeApplication({ ...data, id: row.id, status: row.status });
}

/** Newest-first page of applications. */
export async function listApplications({ limit = 500, offset = 0 } = {}) {
  const r = await query(
    'SELECT id, status, data FROM applications ORDER BY submitted_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return r.rows.map(rowToApp).filter(Boolean);
}

export async function countApplications() {
  const r = await query('SELECT COUNT(*)::int AS n FROM applications');
  return r.rows[0]?.n || 0;
}

export async function getApplication(id) {
  if (!id) return null;
  const r = await query('SELECT id, status, data FROM applications WHERE id = $1', [id]);
  return rowToApp(r.rows[0]);
}

export async function getApplicationByEmail(email) {
  if (!email) return null;
  const r = await query(
    'SELECT id, status, data FROM applications WHERE lower(email) = lower($1) LIMIT 1',
    [String(email).trim()]
  );
  return rowToApp(r.rows[0]);
}

export async function putApplication(app) {
  const record = normalizeApplication(app);
  if (!record?.id) throw new Error('Application must have an ID');
  const email = record.email ? String(record.email).trim().toLowerCase() : null;
  const submittedAt = timeOf(record);
  try {
    await query(
      `INSERT INTO applications (id, email, status, submitted_at, updated_at, data)
       VALUES ($1, $2, $3, $4, now(), $5)`,
      [record.id, email || null, record.status, submittedAt, record]
    );
  } catch (err) {
    if (err?.code === '23505') {
      const existing = email ? await getApplicationByEmail(email) : null;
      throw conflictError(email, existing?.id);
    }
    throw err;
  }
  return record;
}

/** Read-modify-write a single application inside a row-locked transaction. */
export async function updateApplication(id, mutate) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT id, status, data FROM applications WHERE id = $1 FOR UPDATE', [id]);
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const current = rowToApp(r.rows[0]);
    const next = normalizeApplication(mutate({ ...current }));
    const email = next.email ? String(next.email).trim().toLowerCase() : null;
    await client.query(
      'UPDATE applications SET email = $2, status = $3, updated_at = now(), data = $4 WHERE id = $1',
      [id, email || null, next.status, next]
    );
    await client.query('COMMIT');
    return next;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Enquiries ────────────────────────────────────────────────────

function rowToEnquiry(row) {
  if (!row) return null;
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return { ...data, id: row.id };
}

export async function listEnquiries({ limit = 500, offset = 0 } = {}) {
  const r = await query(
    'SELECT id, data FROM enquiries ORDER BY submitted_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return r.rows.map(rowToEnquiry).filter(Boolean);
}

export async function countEnquiries() {
  const r = await query('SELECT COUNT(*)::int AS n FROM enquiries');
  return r.rows[0]?.n || 0;
}

export async function putEnquiry(enquiry) {
  if (!enquiry?.id) throw new Error('Enquiry must have an ID');
  await query(
    `INSERT INTO enquiries (id, submitted_at, data) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [enquiry.id, timeOf(enquiry), enquiry]
  );
  return enquiry;
}

/** Drop enquiries beyond the newest `keep`, so the table cannot grow forever. */
export async function trimEnquiries(keep = 1000) {
  const r = await query(
    `DELETE FROM enquiries WHERE id NOT IN (
       SELECT id FROM enquiries ORDER BY submitted_at DESC LIMIT $1
     )`,
    [keep]
  );
  return r.rowCount || 0;
}

// ── Events ───────────────────────────────────────────────────────

function rowToEvent(row) {
  if (!row) return null;
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return { ...data, id: row.id, registeredCount: row.registered_count ?? data.registeredCount ?? 0 };
}

function eventTime(event) {
  const t = Date.parse(event?.date || event?.createdAt || '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export async function getEvent(id) {
  if (!id) return null;
  const r = await query('SELECT id, registered_count, data FROM events WHERE id = $1', [id]);
  return rowToEvent(r.rows[0]);
}

export async function putEvent(event) {
  if (!event || !event.id) throw new Error('Event must have an ID');
  const record = {
    ...event,
    registeredCount: Number(event.registeredCount) || 0,
    updatedAt: new Date().toISOString(),
  };
  await query(
    `INSERT INTO events (id, event_date, registered_count, updated_at, data)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (id) DO UPDATE SET
       event_date = EXCLUDED.event_date,
       registered_count = EXCLUDED.registered_count,
       updated_at = now(),
       data = EXCLUDED.data`,
    [record.id, eventTime(record), record.registeredCount, record]
  );
  return record;
}

export async function listEvents({ limit = 100, offset = 0 } = {}) {
  const r = await query(
    'SELECT id, registered_count, data FROM events ORDER BY event_date DESC NULLS LAST, id LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return r.rows.map(rowToEvent).filter(Boolean);
}

export async function countEvents() {
  const r = await query('SELECT COUNT(*)::int AS n FROM events');
  return r.rows[0]?.n || 0;
}

export async function deleteEvent(id) {
  if (!id) return false;
  await query('DELETE FROM events WHERE id = $1', [id]);
  return true;
}

export async function getEventAttendees(id) {
  if (!id) return [];
  const r = await query('SELECT data FROM event_attendees WHERE event_id = $1 ORDER BY registered_at ASC', [id]);
  return r.rows.map((row) => (row.data && typeof row.data === 'object' ? row.data : null)).filter(Boolean);
}

export async function registerForEvent(id, attendee) {
  if (!id || !attendee || !attendee.email) {
    return { success: false, error: 'Event ID and attendee email are required.' };
  }
  const email = String(attendee.email).trim().toLowerCase();

  const locked = await acquireLock(`eventreg:${id}`);
  if (!locked) {
    return { success: false, error: 'Registration service is busy. Please try again in a moment.' };
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const er = await client.query('SELECT id, registered_count, data FROM events WHERE id = $1 FOR UPDATE', [id]);
    if (!er.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Event not found.' };
    }
    const event = rowToEvent(er.rows[0]);

    const capacity = Number(event.capacity) || 0;
    const currentCount = Number(event.registeredCount) || 0;
    if (capacity > 0 && currentCount >= capacity) {
      await client.query('ROLLBACK');
      return { success: false, error: 'This event has reached maximum capacity.' };
    }

    const dup = await client.query(
      'SELECT 1 FROM event_attendees WHERE event_id = $1 AND lower(email) = $2 LIMIT 1',
      [id, email]
    );
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'You are already registered for this event.' };
    }

    const isPaid = event.pricingType === 'paid' && Number(event.fee) > 0;
    const { randomUUID } = await import('node:crypto');
    const newAttendee = {
      ticketId: attendee.ticketId || `TKT-${id.replace(/^EVT-/, '')}-${randomUUID().slice(0, 4).toUpperCase()}`,
      name: String(attendee.name || '').trim(),
      email,
      phone: String(attendee.phone || '').trim(),
      company: String(attendee.company || '').trim() || 'Delegate / Independent',
      paymentRef: String(attendee.paymentRef || '').trim() || null,
      status: isPaid ? 'pending' : 'confirmed',
      paymentStatus: isPaid ? 'pending_verification' : 'confirmed',
      registeredAt: new Date().toISOString(),
    };

    await client.query(
      'INSERT INTO event_attendees (event_id, ticket_id, email, data) VALUES ($1, $2, $3, $4)',
      [id, newAttendee.ticketId, email, newAttendee]
    );
    await client.query(
      'UPDATE events SET registered_count = registered_count + 1, updated_at = now(), data = $2 WHERE id = $1',
      [id, { ...event, registeredCount: currentCount + 1 }]
    );
    await client.query('COMMIT');
    return { success: true, event: { ...event, registeredCount: currentCount + 1 }, attendee: newAttendee, ticketId: newAttendee.ticketId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await releaseLock(`eventreg:${id}`);
  }
}

export async function confirmEventPayment(id, ticketId, confirmedBy = 'admin') {
  if (!id || !ticketId) {
    return { success: false, error: 'Event ID and ticket ID are required.' };
  }
  const locked = await acquireLock(`eventreg:${id}`);
  if (!locked) {
    return { success: false, error: 'Event service is busy. Please try again in a moment.' };
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const er = await client.query('SELECT id, registered_count, data FROM events WHERE id = $1 FOR UPDATE', [id]);
    if (!er.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Event not found.' };
    }
    const event = rowToEvent(er.rows[0]);
    const ar = await client.query(
      'SELECT ticket_id, data FROM event_attendees WHERE event_id = $1 AND ticket_id = $2 FOR UPDATE',
      [id, ticketId]
    );
    if (!ar.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Attendee ticket not found.' };
    }
    const current = ar.rows[0].data && typeof ar.rows[0].data === 'object' ? ar.rows[0].data : {};
    const alreadyConfirmed = current.paymentStatus === 'confirmed' || current.status === 'confirmed';
    let attendee = current;
    if (!alreadyConfirmed) {
      attendee = {
        ...current,
        status: 'confirmed',
        paymentStatus: 'confirmed',
        confirmedAt: new Date().toISOString(),
        confirmedBy,
      };
      await client.query('UPDATE event_attendees SET data = $3 WHERE event_id = $1 AND ticket_id = $2', [
        id,
        ticketId,
        attendee,
      ]);
    }
    await client.query('COMMIT');
    return { success: true, event, attendee, alreadyConfirmed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await releaseLock(`eventreg:${id}`);
  }
}
