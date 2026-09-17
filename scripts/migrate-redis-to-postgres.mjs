#!/usr/bin/env node
/**
 * One-time copy of durable records from Upstash Redis to Postgres.
 *
 *   STORAGE_BACKEND=redis npm run migrate:pg          # uses .env.local
 *   docker compose exec app npm run migrate:pg        # on the VPS
 *
 * Requires both UPSTASH_* and DATABASE_URL. Existing Postgres rows win:
 * records are inserted with ON CONFLICT DO NOTHING, so the script is safe
 * to re-run. Redis data is left untouched — verify the portal first, then
 * flip STORAGE_BACKEND=postgres.
 */

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.DATABASE_URL) {
  console.error('Need UPSTASH_REDIS_REST_URL and DATABASE_URL in the environment.');
  process.exit(1);
}

process.env.STORAGE_BACKEND = 'postgres';
const pg = await import('../api/_lib/postgres.js');
await pg.initSchema();

const counts = { applications: 0, enquiries: 0, events: 0, attendees: 0, skipped: 0 };

async function migrateSet({ indexKey, recordKey, put, label }) {
  const ids = (await redis.zrange(indexKey, 0, -1)) || [];
  for (const id of ids) {
    const raw = await redis.get(recordKey(id));
    if (!raw) continue;
    const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
    try {
      await put(record);
      counts[label]++;
    } catch (err) {
      if (err?.code === '23505' || err?.statusCode === 409) counts.skipped++;
      else throw err;
    }
  }
}

await migrateSet({
  indexKey: 'bcci:app_index',
  recordKey: (id) => `bcci:app:${id}`,
  put: pg.putApplication,
  label: 'applications',
});

await migrateSet({
  indexKey: 'bcci:enq_index',
  recordKey: (id) => `bcci:enq:${id}`,
  put: pg.putEnquiry,
  label: 'enquiries',
});

// Events + their attendee lists.
const eventIds = (await redis.zrange('bcci:event_index', 0, -1)) || [];
for (const id of eventIds) {
  const raw = await redis.get(`bcci:event:${id}`);
  if (!raw) continue;
  const event = typeof raw === 'string' ? JSON.parse(raw) : raw;
  await pg.putEvent(event);
  counts.events++;
  const rawAtt = await redis.get(`bcci:event_attendees:${id}`);
  const attendees = Array.isArray(rawAtt) ? rawAtt : (typeof rawAtt === 'string' ? JSON.parse(rawAtt) : []);
  for (const a of attendees || []) {
    if (!a?.ticketId || !a?.email) continue;
    try {
      await pg.query(
        'INSERT INTO event_attendees (event_id, ticket_id, email, data) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [id, a.ticketId, String(a.email).trim().toLowerCase(), a]
      );
      counts.attendees++;
    } catch (err) {
      counts.skipped++;
    }
  }
  // Recompute the counter from the migrated rows.
  await pg.query(
    'UPDATE events SET registered_count = (SELECT COUNT(*) FROM event_attendees WHERE event_id = $1) WHERE id = $1',
    [id]
  );
}

console.log('Migration complete:', counts);
process.exit(0);
