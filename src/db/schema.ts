import type { Pool } from 'pg';

// Idempotente: se puede correr en cada arranque.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_events (
  id              text PRIMARY KEY,                -- el id del evento de Stripe: la clave de idempotencia
  type            text        NOT NULL,
  payload         jsonb       NOT NULL,
  event_created   timestamptz NOT NULL,            -- cuándo ocurrió según Stripe, no cuándo llegó
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'done', 'ignored', 'dead')),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS webhook_events_claimable
  ON webhook_events (next_attempt_at) WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS orders (
  payment_intent_id text PRIMARY KEY,
  status            text        NOT NULL CHECK (status IN ('paid', 'failed', 'refunded')),
  amount            bigint      NOT NULL,
  currency          text        NOT NULL,
  last_event_id     text        NOT NULL,
  last_event_at     timestamptz NOT NULL           -- el evento más reciente ya aplicado
);
`;

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(SCHEMA);
}
