import type { PoolClient } from 'pg';
import type Stripe from 'stripe';

/** 'applied' cambió el estado; 'stale' llegó tarde y no se aplica; 'ignored' no es algo que este servicio modele. */
export type Outcome = 'applied' | 'stale' | 'ignored';
export type Handler = (
  client: PoolClient,
  event: Stripe.Event,
) => Promise<Outcome>;

type OrderStatus = 'paid' | 'failed' | 'refunded';

/**
 * Los eventos pueden llegar desordenados: un reembolso antes del pago que reembolsa. Cada pedido recuerda el
 * evento más reciente que aplicó y uno más viejo se descarta. Con el mismo segundo (Stripe solo da segundos)
 * gana el estado más avanzado: refunded > paid > failed.
 */
async function applyOrderState(
  client: PoolClient,
  o: {
    paymentIntentId: string;
    status: OrderStatus;
    amount: number;
    currency: string;
    event: Stripe.Event;
  },
): Promise<Outcome> {
  const res = await client.query(
    `INSERT INTO orders (payment_intent_id, status, amount, currency, last_event_id, last_event_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6))
     ON CONFLICT (payment_intent_id) DO UPDATE
       SET status = EXCLUDED.status, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
           last_event_id = EXCLUDED.last_event_id, last_event_at = EXCLUDED.last_event_at
       WHERE orders.last_event_at < EXCLUDED.last_event_at
          OR (orders.last_event_at = EXCLUDED.last_event_at
              AND ${rank('EXCLUDED.status')} > ${rank('orders.status')})`,
    [
      o.paymentIntentId,
      o.status,
      o.amount,
      o.currency,
      o.event.id,
      o.event.created,
    ],
  );
  return res.rowCount === 0 ? 'stale' : 'applied';
}

const rank = (col: string) =>
  `CASE ${col} WHEN 'refunded' THEN 3 WHEN 'paid' THEN 2 ELSE 1 END`;

const paymentSucceeded: Handler = (client, event) => {
  const pi = event.data.object as Stripe.PaymentIntent;
  return applyOrderState(client, {
    paymentIntentId: pi.id,
    status: 'paid',
    amount: pi.amount,
    currency: pi.currency,
    event,
  });
};

const paymentFailed: Handler = (client, event) => {
  const pi = event.data.object as Stripe.PaymentIntent;
  return applyOrderState(client, {
    paymentIntentId: pi.id,
    status: 'failed',
    amount: pi.amount,
    currency: pi.currency,
    event,
  });
};

// Solo un reembolso completo cambia el estado. Uno parcial se reconoce pero no se modela: está en el README.
const chargeRefunded: Handler = async (client, event) => {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId =
    typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!paymentIntentId || charge.amount_refunded < charge.amount)
    return 'ignored';
  return applyOrderState(client, {
    paymentIntentId,
    status: 'refunded',
    amount: charge.amount,
    currency: charge.currency,
    event,
  });
};

export const HANDLERS: Record<string, Handler> = {
  'payment_intent.succeeded': paymentSucceeded,
  'payment_intent.payment_failed': paymentFailed,
  'charge.refunded': chargeRefunded,
};
