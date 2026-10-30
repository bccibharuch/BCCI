// Pure write operations, included in the same fenced transaction as the
// business record. No SMTP or Redis imports here (avoids a storage cycle).
export const OUTBOX_INDEX = 'bcci:email_outbox';
export const outboxKey = (id) => `bcci:email_outbox:${id}`;

export function emailIntentOps(id, message) {
  if (!id || !message) return [];
  const createdAt = Date.now();
  return [
    ['set', outboxKey(id), { id, message, status: 'pending', attempts: 0, createdAt, nextAttemptAt: createdAt }],
    ['zadd', OUTBOX_INDEX, createdAt, id],
  ];
}
