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
await lib.query('TRUNCATE event_attendees, events, enquiries, applications, membership_plans, locks');

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

const pgStats = await lib.getApplicationStats({ recent: 1 });
check('stats count by status', pgStats.total === 2 && pgStats.approved === 1 && pgStats.pending === 1 && pgStats.rejected === 0, JSON.stringify({ ...pgStats, recent: undefined }));
check('stats recent is newest, without scans', pgStats.recent.length === 1 && pgStats.recent[0].id === 'PG-APP-3' && pgStats.recent[0].paymentProof === '[document]');

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

const ci = await lib.setAttendeeCheckIn('PG-EVT-1', reg1.ticketId, { by: 'desk@test', method: 'manual' });
check('check-in records time and method', ci.success && !!ci.attendee.checkedInAt && ci.attendee.checkInMethod === 'manual', JSON.stringify(ci).slice(0, 160));
const ciRace = await Promise.all([lib.setAttendeeCheckIn('PG-EVT-1', reg1.ticketId), lib.setAttendeeCheckIn('PG-EVT-1', reg1.ticketId)]);
check('repeat scans keep the first check-in', ciRace.every((r) => r.success && r.alreadyCheckedIn && r.attendee.checkedInAt === ci.attendee.checkedInAt));
const ciUndo = await lib.setAttendeeCheckIn('PG-EVT-1', reg1.ticketId, { checkedIn: false });
check('undo clears the check-in', ciUndo.success && !ciUndo.attendee.checkedInAt && !(await lib.getEventAttendees('PG-EVT-1'))[0].checkedInAt);
const ciMissing = await lib.setAttendeeCheckIn('PG-EVT-1', 'TKT-NOPE');
check('check-in of an unknown ticket → not_found', !ciMissing.success && ciMissing.code === 'not_found');

const rmMissing = await lib.removeEventAttendee('PG-EVT-1', 'TKT-NOPE');
check('remove of an unknown ticket → not found', !rmMissing.success && /not found/i.test(rmMissing.error || ''));
const rm = await lib.removeEventAttendee('PG-EVT-1', reg1.ticketId);
check('remove frees the seat (count 1 → 0)', rm.success && rm.event.registeredCount === 0, JSON.stringify(rm).slice(0, 160));
check('removed attendee no longer listed', (await lib.getEventAttendees('PG-EVT-1')).length === 0);
check('stored count matches after removal', (await lib.getEvent('PG-EVT-1')).registeredCount === 0);
const regAgain = await lib.registerForEvent('PG-EVT-1', { name: 'Other', email: 'other@example.com' });
check('the freed seat can be taken', regAgain.success, JSON.stringify(regAgain).slice(0, 120));

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

// Event writes rely on the event row's FOR UPDATE lock, not a cooperative
// lock: parallel registrations must still respect capacity and duplicates.
await lib.putEvent({ id: 'PG-EVT-RACE', title: 'Race', date: new Date(Date.now() + 86400000).toISOString(), capacity: 3, pricingType: 'free' });
const raced = await Promise.all(
  Array.from({ length: 10 }, (_, i) => lib.registerForEvent('PG-EVT-RACE', { name: `R${i}`, email: `race${i % 5}@example.com` }))
);
const won = raced.filter((r) => r.success);
check('parallel registrations stop at capacity', won.length === 3, `${won.length} succeeded`);
check('stored count matches capacity', (await lib.getEvent('PG-EVT-RACE'))?.registeredCount === 3);
check('no duplicate attendees', new Set((await lib.getEventAttendees('PG-EVT-RACE')).map((a) => a.email)).size === 3);
check('losers get a readable reason, not an error', raced.filter((r) => !r.success).every((r) => /capacity|already registered/.test(r.error)), JSON.stringify(raced.find((r) => !r.success)));
const lockRows = await lib.query("SELECT COUNT(*)::int n FROM locks WHERE name LIKE 'eventreg:%'");
check('event writes take no cooperative lock', lockRows.rows[0].n === 0);
await lib.deleteEvent('PG-EVT-RACE');

// ── Membership plans ─────────────────────────────────────────────
section('Postgres membership plans');

const planA = { id: 'pg-gold', name: 'PG Gold', fee: 40000, label: 'PG Gold - ₹40,000/-', createdAt: '2026-01-01T00:00:00.000Z' };
const planB = { id: 'pg-silver', name: 'PG Silver', fee: 20000, label: 'PG Silver - ₹20,000/-', createdAt: '2026-01-02T00:00:00.000Z' };
check('insertCustomPlan stores a new plan', (await lib.insertCustomPlan(planA)) === true);
check('insertCustomPlan stores a second plan', (await lib.insertCustomPlan(planB)) === true);
check('insertCustomPlan refuses a duplicate id', (await lib.insertCustomPlan({ ...planA, fee: 1 })) === false);
const storedPlans = await lib.listCustomPlans();
check('listCustomPlans returns plans oldest first', storedPlans.map((p) => p.id).join() === 'pg-gold,pg-silver', JSON.stringify(storedPlans));
check('duplicate insert did not overwrite the fee', storedPlans[0]?.fee === 40000);
check('deleteCustomPlan removes a plan', (await lib.deleteCustomPlan('pg-gold')) === true);
check('deleteCustomPlan reports a missing plan', (await lib.deleteCustomPlan('pg-gold')) === false);
check('only the remaining plan is listed', (await lib.listCustomPlans()).map((p) => p.id).join() === 'pg-silver');

// ── Key-value state (sessions, OTP codes, rate limits) ──────────
section('Postgres kv (Redis command subset)');

const { kv, sweepExpiredKv } = await import('../api/_lib/kv.js');
await lib.query('TRUNCATE kv');

check('get of a missing key → null', (await kv.get('t:none')) === null);
check('set → OK', (await kv.set('t:obj', { email: 'a@b.in', n: 2 })) === 'OK');
const obj = await kv.get('t:obj');
check('objects round-trip', obj?.email === 'a@b.in' && obj?.n === 2, JSON.stringify(obj));
await kv.set('t:otp', '048213', { ex: 600 });
check('a code with a leading zero stays a string', (await kv.get('t:otp')) === '048213');
check('ttl of a key with expiry is its seconds left', (await kv.ttl('t:otp')) > 595);
check('ttl of a key without expiry → -1', (await kv.ttl('t:obj')) === -1);
check('ttl of a missing key → -2', (await kv.ttl('t:none')) === -2);

check('set nx on a live key → null', (await kv.set('t:obj', 'x', { nx: true })) === null);
check('set nx did not overwrite', (await kv.get('t:obj'))?.email === 'a@b.in');
check('set nx on a new key → OK', (await kv.set('t:claim', '1', { nx: true, ex: 60 })) === 'OK');
const claims = await Promise.all(Array.from({ length: 8 }, () => kv.set('t:race', '1', { nx: true, ex: 60 })));
check('concurrent set nx: exactly one wins', claims.filter((c) => c === 'OK').length === 1, JSON.stringify(claims));

await lib.query("INSERT INTO kv (key, value, expires_at) VALUES ('t:old', '\"stale\"', now() - interval '1 second')");
check('an expired key reads as absent', (await kv.get('t:old')) === null && (await kv.ttl('t:old')) === -2);
check('set nx may claim an expired key', (await kv.set('t:old', 'fresh', { nx: true })) === 'OK' && (await kv.get('t:old')) === 'fresh');

check('incr on a new key → 1', (await kv.incr('t:rl')) === 1);
check('expire on a live key → 1', (await kv.expire('t:rl', 120)) === 1);
check('incr keeps the existing ttl', (await kv.incr('t:rl')) === 2 && (await kv.ttl('t:rl')) > 115);
const counts = await Promise.all(Array.from({ length: 20 }, () => kv.incr('t:rl')));
check('20 concurrent incr all count', Math.max(...counts) === 22 && new Set(counts).size === 20, JSON.stringify(counts));
check('expire on a missing key → 0', (await kv.expire('t:none', 30)) === 0);
await lib.query("UPDATE kv SET expires_at = now() - interval '1 second' WHERE key = 't:rl'");
check('incr after expiry restarts at 1 with no ttl', (await kv.incr('t:rl')) === 1 && (await kv.ttl('t:rl')) === -1);

check('del counts live keys removed', (await kv.del('t:obj', 't:otp', 't:none')) === 2);
check('deleted keys are gone', (await kv.get('t:obj')) === null);
await lib.query("INSERT INTO kv (key, value, expires_at) VALUES ('t:gone', '1', now() - interval '1 second')");
check('sweep removes expired rows only', (await sweepExpiredKv()) === 1 && (await kv.get('t:claim')) === '1');
let refused = false;
try { await kv.set('t:bad', 'x', { ex: 0 }); } catch { refused = true; }
check('a zero expiry is refused rather than stored forever', refused);
await lib.query('TRUNCATE kv');

// ── Storage switch ───────────────────────────────────────────────
section('records.js switch');

const records = await import('../api/_lib/records.js');
check('records.js reports postgres backend', records.STORAGE_BACKEND === 'postgres');
const viaSwitch = await records.getApplication('PG-APP-3');
check('records.js serves postgres rows', viaSwitch?.company === 'PG Three');
check('records.js exposes locks', typeof records.acquireLock === 'function' && typeof records.releaseLock === 'function');

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
for (const line of results) console.log(line);
await lib.query('TRUNCATE event_attendees, events, enquiries, applications, membership_plans, locks');
process.exit(fail ? 1 : 0);
