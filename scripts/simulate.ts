// Manda eventos firmados a una instancia local, sin cuenta de Stripe: la firma se calcula con el mismo secreto que
// usa el servidor, con el helper del SDK. Sirve para ver el flujo completo; no prueba nada contra Stripe de verdad.
//
//   docker compose up -d db
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres STRIPE_WEBHOOK_SECRET=whsec_dev npm run start
//   STRIPE_WEBHOOK_SECRET=whsec_dev npm run simulate        (en otra terminal)
import Stripe from 'stripe';

const base = process.env.BASE_URL ?? 'http://localhost:3000';
const secret = process.env.STRIPE_WEBHOOK_SECRET;
if (!secret)
  throw new Error(
    'Falta STRIPE_WEBHOOK_SECRET (el mismo que usa el servidor).',
  );

let n = Date.now();
const event = (type: string, object: object, created: number) => ({
  id: `evt_sim_${n++}`,
  object: 'event',
  type,
  created,
  data: { object },
});

async function post(label: string, body: string, signature: string) {
  const res = await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': signature,
    },
    body,
  });
  console.log(`${label.padEnd(28)} -> ${res.status} ${await res.text()}`);
}

async function deliver(label: string, e: object) {
  const payload = JSON.stringify(e);
  await post(
    label,
    payload,
    Stripe.webhooks.generateTestHeaderString({ payload, secret: secret! }),
  );
}

const now = Math.floor(Date.now() / 1000);
const pi = `pi_sim_${n}`;
const pay = event(
  'payment_intent.succeeded',
  { id: pi, amount: 4999, currency: 'usd' },
  now - 60,
);
const refund = event(
  'charge.refunded',
  {
    id: 'ch_sim',
    payment_intent: pi,
    amount: 4999,
    amount_refunded: 4999,
    currency: 'usd',
  },
  now,
);

await deliver('reembolso (llega primero)', refund); // ocurrió después del pago, pero llega antes
await deliver('pago (llega después)', pay);
await deliver('pago repetido', pay); // Stripe reintenta: mismo evento, segunda entrega
await post('firma falsa', JSON.stringify(pay), 't=1,v1=deadbeef');

console.log(
  `\nEl worker los procesa en un par de segundos. El pedido ${pi} debe quedar en "refunded":`,
);
console.log(
  `docker compose exec db psql -U postgres -c "select payment_intent_id, status from orders"`,
);
