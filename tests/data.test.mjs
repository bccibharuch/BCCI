import { startMockRedis } from './mock-redis.mjs';
const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 't';

const lib = await import(new URL('../api', import.meta.url).pathname + '/_lib/redis.js');
const { redis, KEYS, listApplications, listApplicationSummaries, getApplicationByEmail, putApplication, updateApplication, listEnquiries } = lib;

let pass=0, fail=0;
const ck=(n,c,d='')=>{ c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n+(d?' — '+d:''))); };

console.log('\nLegacy migration — existing production data must survive');
console.log('───────────────────────────────────────────────────────');

// Seed the OLD single-blob layout, exactly as production holds it today,
// including the lowercase status that broke the admin panel.
const legacy = [
  { id:'BCCI-1', company:'Alpha Chem', email:'a@x.com', repName:'A', status:'pending',  submittedAt:'2026-08-01T10:00:00Z' },
  { id:'BCCI-2', company:'Beta Pharma', email:'b@x.com', repName:'B', status:'Approved', submittedAt:'2026-08-02T10:00:00Z', approvedAt:'2026-08-03T10:00:00Z' },
  { id:'BCCI-3', company:'Gamma Ltd', email:'c@x.com', repName:'C', status:'rejected',  submittedAt:'2026-08-03T10:00:00Z' },
];
await redis.set('bcci:applications', legacy);
await redis.set('bcci:enquiries', [{ id:'ENQ-501', name:'Old Enquiry', email:'e@x.com', submittedAt:'2026-08-01T09:00:00Z' }]);

const apps = await listApplications();
ck('all 3 legacy applications migrated', apps.length === 3, `got ${apps.length}`);
ck('lowercase "pending" normalised to "Pending"', apps.some(a=>a.id==='BCCI-1' && a.status==='Pending'), apps.find(a=>a.id==='BCCI-1')?.status);
ck('lowercase "rejected" normalised to "Rejected"', apps.some(a=>a.id==='BCCI-3' && a.status==='Rejected'));
ck('already-correct "Approved" preserved', apps.some(a=>a.id==='BCCI-2' && a.status==='Approved'));
ck('newest-first ordering', apps[0].id === 'BCCI-3', `first is ${apps[0]?.id}`);
ck('email index built during migration', (await getApplicationByEmail('b@x.com'))?.company === 'Beta Pharma');
ck('email lookup is case-insensitive', (await getApplicationByEmail('B@X.COM'))?.id === 'BCCI-2');
ck('legacy blob left intact as a backup', ((await redis.get('bcci:applications'))||[]).length === 3);

const enq = await listEnquiries();
ck('legacy enquiries migrated', enq.length === 1 && enq[0].id === 'ENQ-501', `got ${enq.length}`);

// Migration must not run twice and duplicate everything.
const again = await listApplications();
ck('re-reading does not duplicate records', again.length === 3, `got ${again.length}`);

console.log('\nDATA-01 — concurrent writes no longer clobber each other');
console.log('────────────────────────────────────────────────────────');

// The old code did GET-whole-array → unshift → SET-whole-array. Twenty
// simultaneous submissions would collapse to a handful of survivors.
const N = 20;
await Promise.all(Array.from({length:N}, (_,i) => putApplication({
  id:`CONC-${i}`, company:`Concurrent ${i}`, email:`conc${i}@x.com`, repName:'R',
  status:'Pending', submittedAt:new Date(Date.now()+i).toISOString(),
})));

const after = await listApplications();
const survivors = after.filter(a=>a.id.startsWith('CONC-')).length;
ck(`all ${N} simultaneous submissions survived`, survivors === N, `only ${survivors} of ${N} persisted`);
ck('each is individually retrievable by email', (await getApplicationByEmail('conc7@x.com'))?.company === 'Concurrent 7');
ck('total is legacy + concurrent', after.length === 3 + N, `got ${after.length}`);

console.log('\nApplication summaries — admin list never loads document scans');
console.log('──────────────────────────────────────────────────────────────');

const scan = 'data:image/png;base64,' + 'A'.repeat(200_000);
await putApplication({
  id:'DOC-1', company:'Doc Co', email:'doc@x.com', repName:'D', status:'Pending',
  submittedAt:new Date(Date.now()+1e6).toISOString(), paymentProof:scan, gstCertProof:scan,
});
const docSummary = (await listApplicationSummaries()).find(a=>a.id==='DOC-1');
ck('summary marks present documents', docSummary?.paymentProof === '[document]' && docSummary?.gstCertProof === '[document]');
ck('summary marks absent documents as empty', docSummary?.panCertProof === '' && docSummary?.repAttachment === '');
ck('summary keeps non-document fields', docSummary?.company === 'Doc Co' && docSummary?.status === 'Pending');
const summaryKeyBytes = JSON.stringify(await redis.get(KEYS.appSummary('DOC-1'))).length;
ck('stored summary excludes the scans', summaryKeyBytes < 2000, `${summaryKeyBytes} bytes`);
ck('full record still holds the scan', (await getApplicationByEmail('doc@x.com'))?.paymentProof === scan);

await updateApplication('DOC-1', (a) => ({ ...a, status:'Approved' }));
ck('update refreshes the summary', (await listApplicationSummaries()).find(a=>a.id==='DOC-1')?.status === 'Approved');

// Records written before summaries existed (legacy migration) are backfilled.
await redis.del(KEYS.appSummary('BCCI-2'));
const backfilled = (await listApplicationSummaries()).find(a=>a.id==='BCCI-2');
ck('missing summary is backfilled on read', backfilled?.company === 'Beta Pharma' && !!(await redis.get(KEYS.appSummary('BCCI-2'))));
ck('summaries cover every application', (await listApplicationSummaries()).length === (await listApplications()).length);

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
mock.server.close();
process.exit(fail?1:0);
