// One-off HTTP smoke test: full portal flow against the Postgres backend.
// Run: node --env-file=/dev/null scripts/smoke-postgres.mjs (env set below)
// Exits non-zero on the first failed expectation.
import { startMockRedis } from '../tests/mock-redis.mjs';
import { startMockSmtp } from '../tests/smtp-server.mjs';

const redisMock = await startMockRedis();
const smtp = await startMockSmtp();

process.env.UPSTASH_REDIS_REST_URL = redisMock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'smoke';
process.env.STORAGE_BACKEND = 'postgres';
process.env.DATABASE_URL = process.env.SMOKE_DATABASE_URL || 'postgresql://bcci:testpw@localhost:5433/bcci';
process.env.ADMIN_EMAILS = 'admin@bccibharuch.in';
process.env.ADMIN_PASSWORD = 'smoke-test-password-123';
process.env.INTERNAL_API_SECRET = 'smoke-secret';
process.env.ALLOWED_ORIGIN = 'http://localhost:3100';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.port);
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'smoke@bccibharuch.in';
process.env.SMTP_PASS = 'smoke';
process.env.EMAIL_FROM = 'BCCI Bharuch <admin@bccibharuch.in>';
process.env.PORT = '3100';
process.env.ALLOW_INCOMPLETE_CONFIG = '1';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

await import('../server.js');
await new Promise((r) => setTimeout(r, 800));

const BASE = 'http://localhost:3100';
let n = 0;
async function expect(name, cond, detail = '') {
  n++;
  if (!cond) {
    console.error(`FAIL #${n} ${name} ${detail}`);
    process.exit(1);
  }
  console.log(`ok #${n} ${name}`);
}
async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// Health reports the postgres backend.
let r = await api('/api/health');
await expect('health ok on postgres backend', r.json.status === 'ok', JSON.stringify(r.json));
await expect('health shows postgres reachable', r.json.checks?.postgres?.reachable === true);

// OTP + application flow.
await api('/api/send-otp', { method: 'POST', body: { email: 'smoke@example.com' } });
const otp = JSON.parse(redisMock.store.get('bcci:otp:smoke@example.com'));
await expect('otp issued to redis', !!otp);
r = await api('/api/verify-otp', { method: 'POST', body: { email: 'smoke@example.com', code: otp, name: 'Smoke Rao' } });
const applicantToken = r.json?.session?.token;
await expect('applicant verified', r.status === 200 && !!applicantToken, r.status);

r = await api('/api/applications', {
  method: 'POST', token: applicantToken,
  body: {
    fullName: 'Smoke Rao', subject: 'BCCI Membership Form', city: 'Bharuch', state: 'Gujarat',
    repName: 'Smoke Rao', repDesignation: 'Director', repMobile: '9876543211', repEmail: 'rep@smoke.example',
    company: 'Smoke Foods Ltd',
    legalStatus: 'Private Limited', enterpriseType: 'Small', businessServices: 'Food',
    primaryBusiness: 'Smoke Foods', businessDescription: 'Packaged snacks manufacturing unit.',
    feedback: 'Smoke test application.', membershipPlan: 'Micro & Small - ₹500 / Year', paymentMode: 'UPI',
    annualTurnover: '10000000', employees: '12', phone: '9876543210',
    address: 'Plot 1, GIDC', district: 'Bharuch', pincode: '392001',
    gstNo: '24AAAAA0000A1Z5', panNo: 'AAAAA0000A', paymentRef: 'UPI/123456789012',
    gstCertProof: TINY_PNG, panCertProof: TINY_PNG,
  },
});
const appId = r.json?.applicationId;
await expect('application created in postgres', r.status === 201 && !!appId, `${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);

r = await api('/api/admin-auth', { method: 'POST', body: { username: 'admin@bccibharuch.in', password: 'smoke-test-password-123' } });
const adminToken = r.json?.session?.token;
await expect('admin signed in', !!adminToken);

r = await api('/api/applications', { token: adminToken });
await expect('admin lists the postgres application', (r.json?.applications || []).some((a) => a.id === appId));

r = await api('/api/applications', { method: 'PATCH', token: adminToken, body: { id: appId, status: 'Rejected', reason: 'Smoke test reason' } });
await expect('rejection reason persisted via HTTP', r.json?.application?.rejectionReason === 'Smoke test reason', JSON.stringify(r.json?.application).slice(0, 200));

r = await api('/api/applications?email=smoke@example.com', { token: applicantToken });
await expect('applicant reads own rejection reason', r.json?.application?.rejectionReason === 'Smoke test reason');

// Enquiries.
r = await api('/api/enquiries', { method: 'POST', body: { name: 'Enq User', email: 'enq@example.com', phone: '9876543210', subject: 'Smoke', message: 'Hello world, this is a smoke test' } });
await expect('enquiry created', r.status === 201, r.status);
r = await api('/api/enquiries', { token: adminToken });
await expect('admin reads enquiries from postgres', (r.json?.enquiries || []).length >= 1);

// Events: broadcast → register → capacity.
r = await api('/api/events', { method: 'POST', token: adminToken, body: { title: 'Smoke Summit', date: '2026-12-01', time: '10:00', venue: 'City Center, Bharuch', capacity: 1 } });
const eventId = r.json?.event?.id;
await expect('event broadcast to postgres', r.status === 201 && !!eventId, `${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
r = await api('/api/events');
await expect('public event listing', (r.json?.events || []).some((e) => e.id === eventId));
r = await api('/api/events', { method: 'POST', body: { action: 'register', eventId, name: 'Attendee One', email: 'one@example.com', phone: '9876543210' } });
await expect('event registration in postgres', r.json?.success === true, JSON.stringify(r.json).slice(0, 150));
const ticketId = r.json?.ticketId;
r = await api('/api/events', { method: 'POST', body: { action: 'register', eventId, name: 'Attendee Two', email: 'two@example.com', phone: '9876543211' } });
await expect('capacity enforced over HTTP', r.json?.success !== true, JSON.stringify(r.json).slice(0, 150));
r = await api('/api/events', { method: 'POST', token: adminToken, body: { action: 'confirm-payment', eventId, ticketId } });
await expect('payment confirm path responds', r.status === 200, r.status);

console.log(`\nSMOKE OK — ${n} expectations passed`);
process.exit(0);
