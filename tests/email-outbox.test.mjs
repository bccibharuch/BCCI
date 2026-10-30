import assert from 'node:assert/strict';
import { startMockRedis } from './mock-redis.mjs';

const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
const { redis, updateApplication, putApplication, putEvent, registerForEvent, confirmEventPayment } = await import('../api/_lib/redis.js');
const { emailIntentOps, outboxKey } = await import('../api/_lib/email-intent.js');
const { deliverEmailIntent, listEmailIntents } = await import('../api/_lib/email-outbox.js');

try {
  await putApplication({ id: 'outbox-app', email: 'test@example.com', status: 'Pending', submittedAt: new Date().toISOString() });
  await updateApplication('outbox-app', app => ({ ...app, status: 'Approved', decisionEmailId: 'decision-test' }), next => ({
    id: next.decisionEmailId,
    message: { type: 'application_approved', to: next.email, data: { appId: next.id } },
  }));
  assert.equal((await redis.get(outboxKey('decision-test'))).status, 'pending', 'intent committed with decision');

  let sends = 0;
  const failed = await deliverEmailIntent('decision-test', { send: async () => { sends++; return { success: false, error: 'temporary SMTP error' }; } });
  assert.equal(failed.pending, true);
  assert.equal((await redis.get(outboxKey('decision-test'))).attempts, 1);
  await deliverEmailIntent('decision-test', { send: async () => { throw new Error('backoff must prevent send'); } });
  const sent = await deliverEmailIntent('decision-test', { force: true, send: async () => { sends++; return { success: true }; } });
  assert.equal(sent.success, true);
  await deliverEmailIntent('decision-test', { force: true, send: async () => { sends++; return { success: true }; } });
  assert.equal(sends, 2, 'completed messages are not sent twice');
  assert.equal((await listEmailIntents()).length, 0);

  for (const [op, key, value, member] of emailIntentOps('concurrent', { type: 'application_declined', to: 'test@example.com', data: {} })) {
    if (op === 'set') await redis.set(key, value);
    else await redis.zadd(key, { score: value, member });
  }
  let concurrentSends = 0;
  const send = async () => { concurrentSends++; await new Promise(r => setTimeout(r, 40)); return { success: true }; };
  await Promise.all([deliverEmailIntent('concurrent', { send }), deliverEmailIntent('concurrent', { send })]);
  assert.equal(concurrentSends, 1, 'concurrent retries have one sender');

  await updateApplication('outbox-app', app => ({ ...app, decisionEmailId: 'obsolete' }), next => ({
    id: 'obsolete', message: { type: 'application_approved', to: next.email,
      context: { applicationId: next.id, field: 'decisionEmailId', status: 'Approved' }, data: {} },
  }));
  await updateApplication('outbox-app', app => ({ ...app, status: 'Rejected', decisionEmailId: 'new-decision' }));
  const obsolete = await deliverEmailIntent('obsolete', { force: true, send: async () => { throw new Error('obsolete approval sent'); } });
  assert.equal(obsolete.cancelled, true);

  for (const [op, key, value, member] of emailIntentOps('exhausted', { type: 'application_declined', to: 'test@example.com', data: {} })) {
    if (op === 'set') await redis.set(key, value);
    else await redis.zadd(key, { score: value, member });
  }
  for (let i = 0; i < 5; i++) await deliverEmailIntent('exhausted', { force: true, send: async () => ({ success: false }) });
  assert.equal((await redis.get(outboxKey('exhausted'))).status, 'failed');
  assert.equal((await deliverEmailIntent('exhausted')).exhausted, true);
  assert.equal((await deliverEmailIntent('exhausted', { force: true, send: async () => ({ success: true }) })).success, true);

  const { default: retries } = await import('../api/email-retries.js');
  let httpStatus;
  const response = { setHeader() {}, status(code) { httpStatus = code; return this; }, json() { return this; }, end() {} };
  await retries({ method: 'GET', headers: {}, query: {} }, response);
  assert.equal(httpStatus, 401, 'retry surface requires an admin session');

  await putEvent({ id: 'outbox-event', title: 'Event', date: '2026-11-01', capacity: 10, pricingType: 'paid', fee: 100 });
  const registered = await registerForEvent('outbox-event', { email: 'attendee@example.com', name: 'Attendee', paymentRef: 'UTR' });
  assert.equal(registered.success, true);
  const confirmed = await confirmEventPayment('outbox-event', registered.ticketId);
  assert.equal(confirmed.success, true);
  assert.ok(confirmed.attendee.ticketEmailId);
  const ticket = await redis.get(outboxKey(confirmed.attendee.ticketEmailId));
  assert.equal(ticket.message.type, 'event_ticket');
  await deliverEmailIntent(ticket.id, { send: async () => ({ success: false, error: 'SMTP down' }) });
  const again = await confirmEventPayment('outbox-event', registered.ticketId);
  assert.equal(again.attendee.ticketEmailId, ticket.id, 'repeat confirmation retains retryable ticket');
  assert.equal((await deliverEmailIntent(ticket.id, { force: true, send: async () => ({ success: true }) })).success, true);
  console.log('Email outbox: durable decision/ticket intent, backoff, retry and concurrency passed');
} finally {
  mock.server.close();
}
