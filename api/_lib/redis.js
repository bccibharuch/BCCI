// api/_lib/redis.js
// Shared Upstash Redis client + record store.
//
// Records are stored one-per-key with a sorted-set index instead of a single
// JSON blob, so two concurrent writers can never clobber each other and a
// status lookup no longer downloads every application in the database.
//
// Legacy blobs (bcci:applications / bcci:enquiries) are migrated lazily on
// first access. The old key is left in place as a backup.

import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';
import { summarizeApplication, newTicketId, applyCheckIn } from './record-fields.js';
import { KEYS, withRetry } from './keys.js';

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export { KEYS, withRetry };

/** Redis is reachable and responding. Used by /api/health. */
export async function ping() {
  const probe = `bcci:health:${Date.now()}`;
  await redis.set(probe, '1', { ex: 10 });
  const v = await redis.get(probe);
  await redis.del(probe).catch(() => {});
  return v === '1' || v === 1;
}

// ── Status normalisation ───────────────────────────────────────────
// Historic rows were written as 'pending' (lowercase) while every reader
// compares against 'Pending'. Everything funnels through here so the two can
// never drift apart again.

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
  return Number.isFinite(t) ? t : Date.now();
}

// ── One-time migration from the legacy single-blob layout ──────────

async function waitForMigration(markerKey) {
  // A concurrent cold start holds the claim; wait for it to finish rather than
  // serving an empty list.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const status = await redis.get(markerKey);
    if (status === 'done' || !status) return;
  }
}

async function migrateLegacy({ legacyKey, indexKey, recordKey, emailKey, marker }) {
  const markerKey = KEYS.migrated(marker);
  const status = await redis.get(markerKey);
  if (status === 'done') return;
  if (status) {
    // Another cold start is mid-migration ('running').
    await waitForMigration(markerKey);
    return;
  }

  // Claim the migration so two concurrent cold starts don't both run it.
  const claimed = await redis.set(markerKey, 'running', { nx: true, ex: 300 });
  if (!claimed) {
    await waitForMigration(markerKey);
    return;
  }

  try {
    const legacy = (await redis.get(legacyKey)) || [];
    if (Array.isArray(legacy) && legacy.length) {
      for (const raw of legacy) {
        const record = emailKey ? normalizeApplication(raw) : raw;
        if (!record?.id) continue;
        await redis.set(recordKey(record.id), record);
        await redis.zadd(indexKey, { score: timeOf(record), member: record.id });
        if (emailKey && record.email) {
          await redis.set(emailKey(record.email), record.id);
        }
      }
      console.log(`[Migration] ${marker}: moved ${legacy.length} records to per-record keys`);
    }
    await redis.set(markerKey, 'done');
  } catch (err) {
    // Release the claim so the next request can retry.
    await redis.del(markerKey).catch(() => {});
    throw err;
  }
}

const ensureAppsMigrated = () =>
  migrateLegacy({
    legacyKey: KEYS.appLegacy,
    indexKey: KEYS.appIndex,
    recordKey: KEYS.app,
    emailKey: KEYS.appByEmail,
    marker: 'applications',
  });

const ensureEnquiriesMigrated = () =>
  migrateLegacy({
    legacyKey: KEYS.enqLegacy,
    indexKey: KEYS.enqIndex,
    recordKey: KEYS.enq,
    emailKey: null,
    marker: 'enquiries',
  });

// ── Applications ───────────────────────────────────────────────────

/** Newest-first page of applications. */
export async function listApplications({ limit = 500, offset = 0 } = {}) {
  return withRetry(async () => {
    await ensureAppsMigrated();
    const ids = await redis.zrange(KEYS.appIndex, offset, offset + limit - 1, {
      rev: true,
    });
    if (!ids || !ids.length) return [];
    const records = await redis.mget(...ids.map(KEYS.app));
    return records.filter(Boolean).map(normalizeApplication);
  });
}

/**
 * Newest-first page of applications with document fields reduced to a
 * '[document]' marker. Reads the summary keys, so it never downloads the
 * scans; records written before summaries existed are backfilled once.
 */
export async function listApplicationSummaries({ limit = 500, offset = 0 } = {}) {
  return withRetry(async () => {
    await ensureAppsMigrated();
    const ids = await redis.zrange(KEYS.appIndex, offset, offset + limit - 1, {
      rev: true,
    });
    if (!ids || !ids.length) return [];
    const summaries = await redis.mget(...ids.map(KEYS.appSummary));

    const missing = ids.flatMap((id, i) => (summaries[i] ? [] : [i]));
    for (let c = 0; c < missing.length; c += BACKFILL_CHUNK) {
      await backfillSummaries(ids, summaries, missing.slice(c, c + BACKFILL_CHUNK));
    }
    return summaries.filter(Boolean).map(normalizeApplication);
  });
}

// Full records carry the scans, so the one-time backfill reads them a few
// at a time to bound memory, and writes each chunk in one request.
const BACKFILL_CHUNK = 50;

async function backfillSummaries(ids, summaries, positions) {
  const full = await redis.mget(...positions.map((i) => KEYS.app(ids[i])));
  const pipe = redis.pipeline();
  let writes = 0;
  positions.forEach((pos, j) => {
    const record = normalizeApplication(full[j]);
    if (!record) return;
    // Match by index position, not the stored id, which old records may lack.
    const summary = summarizeApplication({ ...record, id: record.id || ids[pos] });
    summaries[pos] = summary;
    // NX: never overwrite a summary a concurrent update wrote after our read.
    pipe.set(KEYS.appSummary(ids[pos]), summary, { nx: true });
    writes++;
  });
  if (writes) await pipe.exec();
}

/** Status counts and the newest few applications for the admin dashboard. */
export async function getApplicationStats({ recent = 5 } = {}) {
  const total = await countApplications();
  const apps = total > 0 ? await listApplicationSummaries({ limit: total }) : [];
  const count = (status) => apps.filter((a) => a.status === status).length;
  return {
    total,
    pending: count(STATUS.PENDING),
    approved: count(STATUS.APPROVED),
    rejected: count(STATUS.REJECTED),
    recent: apps.slice(0, recent),
  };
}

export async function countApplications() {
  await ensureAppsMigrated();
  return (await redis.zcard(KEYS.appIndex)) || 0;
}

export async function getApplication(id) {
  if (!id) return null;
  return withRetry(async () => {
    await ensureAppsMigrated();
    return normalizeApplication(await redis.get(KEYS.app(id)));
  });
}

export async function getApplicationByEmail(email) {
  if (!email) return null;
  return withRetry(async () => {
    await ensureAppsMigrated();
    const id = await redis.get(KEYS.appByEmail(email));
    if (!id) return null;
    return normalizeApplication(await redis.get(KEYS.app(id)));
  });
}

export async function putApplication(app) {
  const record = normalizeApplication(app);
  return withRetry(async () => {
    if (record.email) {
      const emailKey = KEYS.appByEmail(record.email);
      const claimed = await redis.set(emailKey, record.id, { nx: true });
      if (!claimed) {
        const existingId = await redis.get(emailKey);
        // The claim is ours when withRetry re-runs after a slow first attempt,
        // and stale when a crash landed between the claim and the record write.
        // Either way the email is free; anything else is a genuine duplicate.
        const holderExists = existingId && existingId !== record.id && (await redis.exists(KEYS.app(existingId)));
        if (holderExists) {
          const err = new Error(`An application for this email already exists (${existingId}).`);
          err.statusCode = 409;
          throw err;
        }
        await redis.set(emailKey, record.id);
      }
    }
    try {
      // One transaction, so the list summary can never disagree with the record.
      await redis
        .multi()
        .set(KEYS.app(record.id), record)
        .set(KEYS.appSummary(record.id), summarizeApplication(record))
        .zadd(KEYS.appIndex, { score: timeOf(record), member: record.id })
        .exec();
    } catch (err) {
      if (record.email) await redis.del(KEYS.appByEmail(record.email)).catch(() => {});
      throw err;
    }
    return record;
  });
}

/**
 * Read-modify-write a single application. Because each record lives under its
 * own key, this only races with concurrent edits to the *same* application —
 * and a per-id lock serializes those, so two admins acting at once can't
 * clobber each other (Postgres does the same with SELECT … FOR UPDATE).
 */
export async function updateApplication(id, mutate) {
  return withRetry(async () => {
    await ensureAppsMigrated();
    const lockName = `application:${id}`;
    const lock = await acquireLock(lockName);
    // Writing without the lock could overwrite a concurrent edit; refuse instead.
    if (!lock) {
      throw Object.assign(new Error('This application is being updated by someone else. Please try again.'), { statusCode: 409 });
    }
    try {
      const current = normalizeApplication(await redis.get(KEYS.app(id)));
      if (!current) return null;
      const next = normalizeApplication(mutate({ ...current }));
      // One transaction, so the list summary can never disagree with the record.
      const tx = redis
        .multi()
        .set(KEYS.app(id), next)
        .set(KEYS.appSummary(id), summarizeApplication(next));
      // A resubmission moves submittedAt; keep the list order in step. Records
      // without a usable date keep their slot rather than jumping to the top.
      const submitted = Date.parse(next.submittedAt || '');
      if (Number.isFinite(submitted)) tx.zadd(KEYS.appIndex, { score: submitted, member: id });
      await tx.exec();
      if (next.email) await redis.set(KEYS.appByEmail(next.email), next.id);
      return next;
    } finally {
      await releaseLock(lockName, lock);
    }
  });
}

// ── Enquiries ──────────────────────────────────────────────────────

export async function listEnquiries({ limit = 500, offset = 0 } = {}) {
  return withRetry(async () => {
    await ensureEnquiriesMigrated();
    const ids = await redis.zrange(KEYS.enqIndex, offset, offset + limit - 1, {
      rev: true,
    });
    if (!ids || !ids.length) return [];
    const records = await redis.mget(...ids.map(KEYS.enq));
    return records.filter(Boolean);
  });
}

export async function countEnquiries() {
  await ensureEnquiriesMigrated();
  return (await redis.zcard(KEYS.enqIndex)) || 0;
}

export async function putEnquiry(enquiry) {
  return withRetry(async () => {
    await redis.set(KEYS.enq(enquiry.id), enquiry);
    await redis.zadd(KEYS.enqIndex, {
      score: timeOf(enquiry),
      member: enquiry.id,
    });
    return enquiry;
  });
}

/** Drop enquiries beyond the newest `keep`, so the index cannot grow forever. */
export async function trimEnquiries(keep = 1000) {
  const total = (await redis.zcard(KEYS.enqIndex)) || 0;
  if (total <= keep) return 0;
  const stale = await redis.zrange(KEYS.enqIndex, 0, total - keep - 1);
  if (!stale || !stale.length) return 0;
  await redis.del(...stale.map(KEYS.enq));
  await redis.zrem(KEYS.enqIndex, ...stale);
  return stale.length;
}

// ── Events ─────────────────────────────────────────────────────────

export async function getEvent(id) {
  if (!id) return null;
  return withRetry(async () => {
    const data = await redis.get(KEYS.event(id));
    if (!data) return null;
    return typeof data === 'string' ? JSON.parse(data) : data;
  });
}

export async function putEvent(event) {
  if (!event || !event.id) throw new Error('Event must have an ID');
  const record = {
    ...event,
    registeredCount: Number(event.registeredCount) || 0,
    updatedAt: new Date().toISOString(),
  };
  return withRetry(async () => {
    await redis.set(KEYS.event(record.id), record);
    const t = Date.parse(record.date || record.createdAt || '') || Date.now();
    await redis.zadd(KEYS.eventIndex, { score: t, member: record.id });
    return record;
  });
}

export async function listEvents({ limit = 100, offset = 0 } = {}) {
  return withRetry(async () => {
    const ids = await redis.zrange(KEYS.eventIndex, offset, offset + limit - 1, {
      rev: true,
    });
    if (!ids || !ids.length) return [];
    const records = await redis.mget(...ids.map(KEYS.event));
    return records.filter(Boolean).map(r => (typeof r === 'string' ? JSON.parse(r) : r));
  });
}

export async function countEvents() {
  return (await redis.zcard(KEYS.eventIndex)) || 0;
}

export async function deleteEvent(id) {
  if (!id) return false;
  return withRetry(async () => {
    await redis.del(KEYS.event(id), KEYS.eventAttendees(id));
    await redis.zrem(KEYS.eventIndex, id);
    return true;
  });
}

// ── Membership plans (admin-added tiers; built-ins live in code) ───

/** Admin-added membership plans, oldest first. */
export async function listCustomPlans() {
  return withRetry(async () => {
    const ids = await redis.zrange(KEYS.planIndex, 0, -1);
    if (!ids || !ids.length) return [];
    const records = await redis.mget(...ids.map(KEYS.plan));
    return records.filter(Boolean).map(r => (typeof r === 'string' ? JSON.parse(r) : r));
  });
}

/** Stores a new plan; false when a plan with the same id already exists. */
export async function insertCustomPlan(plan) {
  if (!plan || !plan.id) throw new Error('Membership plan must have an ID');
  return withRetry(async () => {
    // NX makes the id (a slug of the name) the uniqueness guarantee, so two
    // admins adding the same tier at once cannot both succeed.
    const created = await redis.set(KEYS.plan(plan.id), plan, { nx: true });
    if (!created) return false;
    await redis.zadd(KEYS.planIndex, { score: Date.parse(plan.createdAt) || Date.now(), member: plan.id });
    return true;
  });
}

/** Removes a plan; false when it did not exist. */
export async function deleteCustomPlan(id) {
  if (!id) return false;
  return withRetry(async () => {
    const removed = await redis.del(KEYS.plan(id));
    await redis.zrem(KEYS.planIndex, id);
    return removed > 0;
  });
}

export async function getEventAttendees(id) {
  if (!id) return [];
  return withRetry(async () => {
    const attendees = await redis.get(KEYS.eventAttendees(id));
    if (!attendees) return [];
    return Array.isArray(attendees) ? attendees : (typeof attendees === 'string' ? JSON.parse(attendees) : []);
  });
}

export async function registerForEvent(id, attendee) {
  if (!id || !attendee || !attendee.email) {
    return { success: false, error: 'Event ID and attendee email are required.' };
  }
  const email = String(attendee.email).trim().toLowerCase();

  return withRetry(async () => {
    const lockToken = await acquireLock(`eventreg:${id}`);
    if (!lockToken) {
      return { success: false, error: 'Registration service is busy. Please try again in a moment.' };
    }

    try {
      const rawEvent = await redis.get(KEYS.event(id));
      if (!rawEvent) {
        return { success: false, error: 'Event not found.' };
      }
      const event = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : rawEvent;

      const capacity = Number(event.capacity) || 0;
      const currentCount = Number(event.registeredCount) || 0;
      if (capacity > 0 && currentCount >= capacity) {
        return { success: false, error: 'This event has reached maximum capacity.' };
      }

      const rawAttendees = await redis.get(KEYS.eventAttendees(id));
      let attendees = [];
      if (rawAttendees) {
        attendees = Array.isArray(rawAttendees) ? rawAttendees : (typeof rawAttendees === 'string' ? JSON.parse(rawAttendees) : []);
      }

      if (attendees.some(a => String(a.email || '').trim().toLowerCase() === email)) {
        return { success: false, error: 'You are already registered for this event.' };
      }

      const isPaid = event.pricingType === 'paid' && Number(event.fee) > 0;
      const initialStatus = isPaid ? 'pending' : 'confirmed';
      const initialPaymentStatus = isPaid ? 'pending_verification' : 'confirmed';

      // Confirmation looks tickets up by ID, so re-draw on a clash.
      const taken = new Set(attendees.map((a) => a.ticketId));
      let ticketId;
      do {
        ticketId = newTicketId(id);
      } while (taken.has(ticketId));
      const newAttendee = {
        ticketId,
        name: String(attendee.name || '').trim(),
        email,
        phone: String(attendee.phone || '').trim(),
        company: String(attendee.company || '').trim() || 'Delegate / Independent',
        paymentRef: String(attendee.paymentRef || '').trim() || null,
        status: initialStatus,
        paymentStatus: initialPaymentStatus,
        registeredAt: new Date().toISOString(),
      };

      attendees.push(newAttendee);
      event.registeredCount = currentCount + 1;

      await redis.set(KEYS.eventAttendees(id), attendees);
      await redis.set(KEYS.event(id), event);

      return { success: true, event, attendee: newAttendee, ticketId };
    } finally {
      await releaseLock(`eventreg:${id}`, lockToken);
    }
  });
}

export async function confirmEventPayment(id, ticketId, confirmedBy = 'admin') {
  if (!id || !ticketId) {
    return { success: false, error: 'Event ID and ticket ID are required.' };
  }
  return withRetry(async () => {
    const lockToken = await acquireLock(`eventreg:${id}`);
    if (!lockToken) {
      return { success: false, error: 'Event service is busy. Please try again in a moment.' };
    }

    try {
      const rawEvent = await redis.get(KEYS.event(id));
      if (!rawEvent) {
        return { success: false, error: 'Event not found.' };
      }
      const event = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : rawEvent;

      const rawAttendees = await redis.get(KEYS.eventAttendees(id));
      let attendees = [];
      if (rawAttendees) {
        attendees = Array.isArray(rawAttendees) ? rawAttendees : (typeof rawAttendees === 'string' ? JSON.parse(rawAttendees) : []);
      }

      const idx = attendees.findIndex(a => a.ticketId === ticketId);
      if (idx === -1) {
        return { success: false, error: 'Attendee ticket not found.' };
      }

      const alreadyConfirmed = attendees[idx].paymentStatus === 'confirmed' || attendees[idx].status === 'confirmed';

      if (!alreadyConfirmed) {
        attendees[idx] = {
          ...attendees[idx],
          status: 'confirmed',
          paymentStatus: 'confirmed',
          confirmedAt: new Date().toISOString(),
          confirmedBy,
        };
        await redis.set(KEYS.eventAttendees(id), attendees);
      }

      return {
        success: true,
        event,
        attendee: attendees[idx],
        alreadyConfirmed,
      };
    } finally {
      await releaseLock(`eventreg:${id}`, lockToken);
    }
  });
}

/**
 * Marks an attendee present (or clears a mistaken check-in). Idempotent: a
 * second scan of the same ticket reports the original time instead of
 * overwriting it. A paid ticket whose payment is still unverified is refused
 * with code 'payment_pending' so the desk can settle it first.
 */
export async function setAttendeeCheckIn(id, ticketId, { checkedIn = true, by = 'admin', method = 'scan' } = {}) {
  if (!id || !ticketId) {
    return { success: false, code: 'invalid', error: 'Event ID and ticket ID are required.' };
  }
  return withRetry(async () => {
    const lockToken = await acquireLock(`eventreg:${id}`);
    if (!lockToken) {
      return { success: false, code: 'busy', error: 'Event service is busy. Please try again in a moment.' };
    }

    try {
      const rawEvent = await redis.get(KEYS.event(id));
      if (!rawEvent) {
        return { success: false, code: 'not_found', error: 'Event not found.' };
      }
      const event = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : rawEvent;

      const rawAttendees = await redis.get(KEYS.eventAttendees(id));
      let attendees = [];
      if (rawAttendees) {
        attendees = Array.isArray(rawAttendees) ? rawAttendees : (typeof rawAttendees === 'string' ? JSON.parse(rawAttendees) : []);
      }

      const idx = attendees.findIndex(a => a.ticketId === ticketId);
      if (idx === -1) {
        return { success: false, code: 'not_found', error: 'Attendee ticket not found.' };
      }

      const outcome = applyCheckIn(attendees[idx], { checkedIn, by, method });
      if (!outcome.success) return outcome;
      if (outcome.changed) {
        attendees[idx] = outcome.attendee;
        await redis.set(KEYS.eventAttendees(id), attendees);
      }
      return { ...outcome, event };
    } finally {
      await releaseLock(`eventreg:${id}`, lockToken);
    }
  });
}

/**
 * Removes one attendee (e.g. a fake or duplicate registration) and frees
 * their seat. Returns { success, attendee } or { success: false, error }.
 */
export async function removeEventAttendee(id, ticketId) {
  if (!id || !ticketId) {
    return { success: false, error: 'Event ID and ticket ID are required.' };
  }
  return withRetry(async () => {
    const lockToken = await acquireLock(`eventreg:${id}`);
    if (!lockToken) {
      return { success: false, error: 'Event service is busy. Please try again in a moment.' };
    }

    try {
      const rawEvent = await redis.get(KEYS.event(id));
      if (!rawEvent) {
        return { success: false, error: 'Event not found.' };
      }
      const event = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : rawEvent;

      const rawAttendees = await redis.get(KEYS.eventAttendees(id));
      let attendees = [];
      if (rawAttendees) {
        attendees = Array.isArray(rawAttendees) ? rawAttendees : (typeof rawAttendees === 'string' ? JSON.parse(rawAttendees) : []);
      }

      const idx = attendees.findIndex(a => a.ticketId === ticketId);
      if (idx === -1) {
        return { success: false, error: 'Attendee ticket not found.' };
      }

      const [removed] = attendees.splice(idx, 1);
      event.registeredCount = Math.max(0, (Number(event.registeredCount) || 0) - 1);

      await redis.set(KEYS.eventAttendees(id), attendees);
      await redis.set(KEYS.event(id), event);

      return { success: true, event, attendee: removed };
    } finally {
      await releaseLock(`eventreg:${id}`, lockToken);
    }
  });
}

// ── Cooperative locks ────────────────────────────────────────────
// Token-checked: release only deletes the key when the token still matches,
// so a slow holder can never delete the next holder's lock after its own
// TTL expired. Returns the token, or null when the lock stayed busy.

export async function acquireLock(name, ttlSeconds = 5, waits = 25, waitMs = 40) {
  const key = `bcci:lock:${name}`;
  const token = crypto.randomUUID();
  for (let i = 0; i < waits; i++) {
    const ok = await redis.set(key, token, { nx: true, ex: ttlSeconds });
    if (ok) return token;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return null;
}

export async function releaseLock(name, token) {
  // Without the holder's token there is nothing of ours to release; deleting
  // the key would free a lock someone else holds.
  if (!token) return;
  const key = `bcci:lock:${name}`;
  try {
    await redis.eval(
      'if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',
      [key],
      [token]
    );
  } catch (err) {
    // The lock's TTL frees it shortly; a blind DEL here could free the next holder's.
    console.warn(`[Lock] release of ${name} failed:`, err?.message || err);
  }
}

