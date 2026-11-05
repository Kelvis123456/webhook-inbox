Español: [README.es.md](README.es.md)

# webhook-inbox

A Stripe webhook receiver that stores every event before processing it, tolerates repeated and out-of-order deliveries, retries failures with growing delays, and puts events that can't be processed into a list you can review and send back to the queue.

I built it because a webhook endpoint that "works" in a tutorial fails in silent ways in production: Stripe retries (the same event arrives twice), doesn't guarantee order (a refund can arrive before the payment), and if your endpoint is slow, it sends the event again. I wanted to check each of those failure modes with tests.

**Stack:** NestJS 12 · TypeScript · PostgreSQL · Vitest · Testcontainers

## How it works

```
Stripe ──POST──> /webhooks/stripe ──firma ok──> INSERT (id = clave) ──> 200
                                                      │
                                    worker cada 1 s ──┴─> toma eventos listos
                                                          (UPDATE ... SKIP LOCKED)
                                                          efecto + "done" en una transacción
                                                          falla: reintento con backoff ──> tras 6 intentos: dead
```

1. **Receive.** It verifies the signature over the exact bytes of the body (the Stripe SDK, with a 5-minute tolerance against replays), stores the event with its id as primary key and answers 200. It processes nothing during the request.
2. **Idempotency.** `INSERT ... ON CONFLICT DO NOTHING` on the event id. Twenty simultaneous deliveries of the same event leave one row and a single `duplicate: false` response.
3. **Process.** A worker picks up ready events with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`. The change to the order and the `done` mark go in the same transaction.
4. **Ordering.** Each order remembers the date of the last event it applied. An older one is discarded. If two share the same second, the more advanced state wins (`refunded` > `paid` > `failed`).
5. **Failures.** Retry with a delay of `5 s × 2^(attempt-1)`, capped at 1 hour, with full jitter. After 6 attempts it moves to `dead`.
6. **Dead events.** `GET /admin/events` lists them and `POST /admin/events/:id/retry` puts them back in the queue. Both require `Authorization: Bearer <ADMIN_TOKEN>`; if `ADMIN_TOKEN` isn't configured, the panel doesn't exist (404).

It handles `payment_intent.succeeded`, `payment_intent.payment_failed` and `charge.refunded`. Any other type is stored and marked `ignored`.

## How to run it

You need Node 24 and Docker.

```bash
docker compose up -d db
cp .env.example .env        # y ajusta STRIPE_WEBHOOK_SECRET
npm install
DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres STRIPE_WEBHOOK_SECRET=whsec_dev npm run start
```

In another terminal, to see the flow without a Stripe account (it sends a refund before its payment, a repeated delivery and a forged signature):

```bash
STRIPE_WEBHOOK_SECRET=whsec_dev npm run simulate
```

The tests start their own Postgres with Testcontainers, so they only need Docker:

```bash
npm test
```

## What the tests check

31 tests against a real Postgres, not a mock, because what matters here (`ON CONFLICT`, `SKIP LOCKED`, transactions) is database behavior:

- **Signature:** no header, wrong secret, altered body, re-serialized JSON with the original signature, old signature; and that the rejection doesn't leak the reason.
- **Idempotency:** repeated delivery and 20 simultaneous deliveries.
- **Ordering:** refund before the payment, same second in both orders, old failure after a payment.
- **Retries:** exact backoff, not picked up again too early, move to `dead`, one broken event doesn't hold back the others.
- **Concurrency:** three workers over 40 events process each one once; a row locked by another transaction doesn't block the worker; an event abandoned with an expired lock is claimed by another worker.
- **Panel:** token, invented state with SQL inside, resend and 404.

To check that the tests can fail, I deliberately removed `ON CONFLICT`, the ordering guard and `SKIP LOCKED`, and each change broke the tests it should have. `SKIP LOCKED` was different: the three-worker test kept passing without it. It turned out that uniqueness is guaranteed by the `UPDATE` (Postgres re-evaluates the `WHERE` after waiting for the lock) and `SKIP LOCKED` only avoids the wait. I fixed the comment in the code and added the locked-row test, which does fail without it.

## What it is not

- **It isn't connected to a Stripe account.** The signatures in the tests and the simulator are computed by the SDK helper with a test secret. It never processed a real payment. Trying it with `stripe trigger` requires the Stripe CLI and an account in test mode.
- **It isn't an order system.** The `orders` table is a pretext to have some state that changes; there is no catalog, no customers and no charges.
- **Only three event types.** A partial refund is recognized and ignored.
- **I didn't measure performance.** Using Postgres as a queue is reasonable for this volume and simple to operate, but I don't know how many events per second it handles. With much more traffic I would have to measure before claiming anything.
- **At-least-once delivery.** The handlers are idempotent by design; if a handler had effects outside the database (an email, another API), they would need to be protected separately.
- **No metrics or traces.** Only Nest logs.
- **The panel is a fixed token in an environment variable.** It works for operating the service; it isn't a user system.

The decisions and what I ruled out are in [docs/decisions.md](docs/decisions.md).
