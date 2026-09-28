// Postgres record backend, exercised against a real database.
//
//   TEST_DATABASE_URL=postgresql://bcci:testpw@localhost:5433/bcci node tests/postgres.test.mjs
//
// Skips (exit 0) when no Postgres is reachable, so CI without a database
// still passes. Locally: `docker run -d --name bcci-pg-test -e
// POSTGRES_USER=bcci -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=bcci -p
// 5433:5432 postgres:17-alpine`.

import pg from 'pg';

const TEST_URL = process.env.TEST_DATABASE_URL || 'postgresql://bcci:testpw@localhost:5433/bcci';

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { results.push(`\n${t}\n${'─'.repeat(t.length)}`); }

// ── Reachability gate ────────────────────────────────────────────
const probe = new pg.Pool({ connectionString: TEST_URL, connectionTimeoutMillis: 3000 });
try {
  await probe.query('SELECT 1');
} catch {
  console.log('SKIP  postgres tests — no database reachable at ' + TEST_URL.replace(/:[^:@/]+@/, ':***@'));
  process.exit(0);
}
await probe.end();

process.env.DATABASE_URL = TEST_URL;
process.env.STORAGE_BACKEND = 'postgres';
const lib = await import('../api/_lib/postgres.js');
await lib.initSchema();

// Isolate from any other run: wipe record tables (locks included).
await lib.query('TRUNCATE event_attendees, events, enquiries, applications, locks');

// ── Applications ─────────────────────────────────────────────────
section('Postgres applications');

const a1 = await lib.putApplication({
  id: 'PG-APP-1', email: 'pg1@example.com', company: 'PG One',
  status: 'pending', submittedAt: new Date(Date.now() - 1000).toISOString(),
});
check('put normalises lowercase status → Pending', a1.status === 'Pending', a1.status);

let dup409 = null;
try {
  await lib.putApplication({ id: 'PG-APP-2', email: 'PG1@EXAMPLE.COM', company: 'Dup' });
} catch (err) { dup409 = err?.statusCode; }
check('duplicate email (case-insensitive) → 409', dup409 === 409, `got ${dup409}`);

const byEmail = await lib.getApplicationByEmail('pg1@example.com');
check('getApplicationByEmail finds it', byEmail?.id === 'PG-APP-1');

const upd = await lib.updateApplication('PG-APP-1', (a) => ({ ...a, status: 'Rejected', rejectionReason: 'bad docs' }));
check('update persists status + reason', upd?.status === 'Rejected' && upd?.rejectionReason === 'bad docs');

const cleared = await lib.updateApplication('PG-APP-1', (a) => {
  const n = { ...a, status: 'Approved' };
  delete n.rejectionReason;
  return n;
});
check('re-approve clears the reason', cleared?.status === 'Approved' && cleared?.rejectionReason === undefined);

await lib.putApplication({ id: 'PG-APP-3', email: 'pg3@example.com', company: 'PG Three', submittedAt: new Date().toISOString() });
const listed = await lib.listApplications();
check('list is newest-first', listed.length === 2 && listed[0].id === 'PG-APP-3', listed.map((a) => a.id).join(','));
check('count matches', (await lib.countApplications()) === 2);

const scan = 'data:image/png;base64,' + 'A'.repeat(200_000);
await lib.updateApplication('PG-APP-3', (a) => ({ ...a, paymentProof: scan, gstCertProof: scan, panCertProof: '' }));
const summaries = await lib.listApplicationSummaries();
const s3 = summaries.find((a) => a.id === 'PG-APP-3');
check('summaries are newest-first like the full list', summaries.map((a) => a.id).join() === listed.map((a) => a.id).join());
check('summary marks present documents', s3?.paymentProof === '[document]' && s3?.gstCertProof === '[document]');
check('summary marks empty/absent documents as empty', s3?.panCertProof === '' && s3?.regCertProof === '' && s3?.repAttachment === '');
check('summary keeps non-document fields', s3?.company === 'PG Three' && s3?.status === 'Pending');
check('summary payload excludes the scans', JSON.stringify(summaries).length < 5000, `${JSON.stringify(summaries).length} bytes`);
check('full record still holds the scan', (await lib.getApplication('PG-APP-3'))?.paymentProof === scan);

// ── Enquiries ────────────────────────────────────────────────────
section('Postgres enquiries');

await lib.putEnquiry({ id: 'PG-ENQ-1', name: 'A', message: 'hi', submittedAt: new Date().toISOString() });
await lib.putEnquiry({ id: 'PG-ENQ-2', name: 'B', message: 'hello', submittedAt: new Date().toISOString() });
check('list enquiries', (await lib.listEnquiries()).length === 2);
check('count enquiries', (await lib.countEnquiries()) === 2);
const trimmed = await lib.trimEnquiries(1);
check('trim keeps newest only', trimmed === 1 && (await lib.listEnquiries())[0].id === 'PG-ENQ-2');

// ── Events ───────────────────────────────────────────────────────
section('Postgres events');

await lib.putEvent({ id: 'PG-EVT-1', title: 'Meet', date: new Date(Date.now() + 86400000).toISOString(), capacity: 1, pricingType: 'free' });
check('get event', (await lib.getEvent('PG-EVT-1'))?.title === 'Meet');

const reg1 = await lib.registerForEvent('PG-EVT-1', { name: 'Zed', email: 'zed@example.com' });
check('register → confirmed for free events', reg1.success && reg1.attendee.status === 'confirmed', JSON.stringify(reg1).slice(0, 120));
check('ticket ID carries a 10-hex-char random suffix', /-[0-9A-F]{10}$/.test(reg1.ticketId || ''), reg1.ticketId);

const regDup = await lib.registerForEvent('PG-EVT-1', { name: 'Zed', email: 'ZED@example.com' });
check('duplicate email → rejected', !regDup.success, JSON.stringify(regDup).slice(0, 120));

const regFull = await lib.registerForEvent('PG-EVT-1', { name: 'Other', email: 'other@example.com' });
check('capacity enforced', !regFull.success, JSON.stringify(regFull).slice(0, 120));

check('attendee listed', (await lib.getEventAttendees('PG-EVT-1')).length === 1);

const conf = await lib.confirmEventPayment('PG-EVT-1', reg1.ticketId, 'admin@test');
check('confirm is idempotent on confirmed tickets', conf.success && conf.alreadyConfirmed === true);

await lib.deleteEvent('PG-EVT-1');
check('delete removes event + attendees', (await lib.getEvent('PG-EVT-1')) === null && (await lib.getEventAttendees('PG-EVT-1')).length === 0);

// ── Locks ────────────────────────────────────────────────────────
section('Postgres locks');

const tok = await lib.acquireLock('pg-test-lock', 5, 3, 10);
check('acquire returns a token', typeof tok === 'string' && tok.length > 0);
await lib.releaseLock('pg-test-lock', 'wrong-token');
const held = await lib.query('SELECT COUNT(*)::int n FROM locks WHERE name = $1', ['pg-test-lock']);
check('wrong token does not release', held.rows[0].n === 1);
await lib.releaseLock('pg-test-lock', tok);
const freed = await lib.query('SELECT COUNT(*)::int n FROM locks WHERE name = $1', ['pg-test-lock']);
check('correct token releases', freed.rows[0].n === 0);

// A registration whose lock expired mid-flight must not release the lock a
// later request now holds. Stall it on the event row, hand the lock to an
// "intruder" as if the TTL had lapsed, then let it finish.
await lib.putEvent({ id: 'PG-EVT-LOCK', title: 'Lock', date: new Date(Date.now() + 86400000).toISOString(), capacity: 10, pricingType: 'free' });
const blocker = new pg.Client({ connectionString: TEST_URL });
await blocker.connect();
await blocker.query('BEGIN');
await blocker.query('SELECT 1 FROM events WHERE id = $1 FOR UPDATE', ['PG-EVT-LOCK']);
const stalled = lib.registerForEvent('PG-EVT-LOCK', { name: 'Slow', email: 'slow@example.com' });
let lockRow = null;
for (let i = 0; i < 100 && !lockRow; i++) {
  lockRow = (await lib.query('SELECT token FROM locks WHERE name = $1', ['eventreg:PG-EVT-LOCK'])).rows[0] || null;
  if (!lockRow) await new Promise((r) => setTimeout(r, 10));
}
check('stalled registration holds the event lock', !!lockRow);
await lib.query('UPDATE locks SET token = $2 WHERE name = $1', ['eventreg:PG-EVT-LOCK', 'intruder-token']);
await blocker.query('COMMIT');
await blocker.end();
const stalledResult = await stalled;
check('stalled registration still completes', stalledResult.success === true, JSON.stringify(stalledResult).slice(0, 120));
const intruder = await lib.query('SELECT token FROM locks WHERE name = $1', ['eventreg:PG-EVT-LOCK']);
check("finishing request does not release the new holder's lock", intruder.rows[0]?.token === 'intruder-token');
await lib.releaseLock('eventreg:PG-EVT-LOCK', 'intruder-token');
await lib.deleteEvent('PG-EVT-LOCK');

// ── Storage switch ───────────────────────────────────────────────
section('records.js switch');

const records = await import('../api/_lib/records.js');
check('records.js reports postgres backend', records.STORAGE_BACKEND === 'postgres');
const viaSwitch = await records.getApplication('PG-APP-3');
check('records.js serves postgres rows', viaSwitch?.company === 'PG Three');
check('records.js exposes locks', typeof records.acquireLock === 'function' && typeof records.releaseLock === 'function');

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
for (const line of results) console.log(line);
await lib.query('TRUNCATE event_attendees, events, enquiries, applications, locks');
process.exit(fail ? 1 : 0);
