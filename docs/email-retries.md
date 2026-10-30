# Retrying decision and paid-ticket emails

Membership decisions, renewal decisions and payment confirmations now store an
email intent in the **same Redis fenced transaction** as the business update.
SMTP failure does not reverse approval/payment and does not discard the email.
No migration is required. Existing decisions made before this change do not
have intents and cannot be recovered automatically.

Using the existing admin bearer session:

- `GET /api/email-retries` lists up to 50 outstanding/failed intents, including
  attempt count, recipient and last error. This endpoint is admin-only.
- `POST /api/email-retries` with `{}` attempts the next due message (one per
  request to bound serverless execution time). Invoke repeatedly to drain.
- `POST /api/email-retries` with `{"id":"<intent id>"}` explicitly retries that
  intent, bypassing backoff and resetting an exhausted message for one attempt.
- Repeating the original application decision or payment-confirmation request
  also retries its pending intent when due, without applying the payment or
  renewal twice. Renewal retries after approval use the admin retry endpoint.

There is **no background scheduler enabled by this change**: use the admin
endpoint after an SMTP outage. Automatic attempts use exponential backoff
(30 seconds, 60 seconds, etc., capped at one hour) and stop after five failed
attempts. An explicit per-id retry remains possible after exhaustion.
Completed sends are not repeated. A per-intent Redis lease serializes retries.
Superseded decisions and removed attendees' ticket intents are cancelled when
retried; an already-running SMTP send cannot be retracted by a later edit.

Delivery is **at-least-once**, not exactly-once: if SMTP accepts a message and
the process dies before Redis records success, a subsequent retry may duplicate
it. The sender does not use a response deadline that abandons an in-flight SMTP
send; it awaits the transport's configured timeouts. Inspect ambiguous delivery
failures before manually retrying. Only status/attempt identifiers are logged
by the outbox; recipients and stored error details require admin access.
