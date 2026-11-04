import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import Stripe from 'stripe';
import { inject } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { migrate } from '../src/db/schema.js';
import { PG_POOL } from '../src/db/db.module.js';
import {
  CLOCK,
  RANDOM,
  WorkerService,
} from '../src/webhooks/worker.service.js';

export const SECRET = 'whsec_test_secret';
export const ADMIN = 'token-de-prueba';

export async function freshPool(): Promise<Pool> {
  const pool = new Pool({ connectionString: inject('dbUrl'), max: 20 });
  await migrate(pool);
  await pool.query('TRUNCATE webhook_events, orders');
  return pool;
}

let counter = 0;

/** Un evento de Stripe con la forma mínima que usan los handlers. */
export function makeEvent(
  type: string,
  object: Record<string, unknown>,
  opts: { id?: string; created?: number } = {},
) {
  return {
    id: opts.id ?? `evt_${++counter}`,
    object: 'event',
    type,
    created: opts.created ?? 1_700_000_000,
    data: { object },
  };
}

export const paymentIntent = (id = 'pi_1', amount = 5000) => ({
  id,
  object: 'payment_intent',
  amount,
  currency: 'usd',
});
export const charge = (
  paymentIntentId = 'pi_1',
  amount = 5000,
  refunded = 5000,
) => ({
  id: 'ch_1',
  object: 'charge',
  payment_intent: paymentIntentId,
  amount,
  amount_refunded: refunded,
  currency: 'usd',
});

/** El cuerpo exacto y la cabecera firmada, como los manda Stripe. */
export function sign(
  event: unknown,
  opts: { secret?: string; timestamp?: number } = {},
) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: opts.secret ?? SECRET,
    timestamp: opts.timestamp,
  });
  return { payload, signature };
}

export async function startApp(
  opts: { adminToken?: string | null } = {},
): Promise<{
  app: INestApplication;
  pool: Pool;
}> {
  process.env.DATABASE_URL = inject('dbUrl');
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  if (opts.adminToken === null) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = opts.adminToken ?? ADMIN;
  process.env.WORKER_INTERVAL_MS = '0'; // en las pruebas el worker se corre a mano
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  const pool = app.get<Pool>(PG_POOL);
  await pool.query('TRUNCATE webhook_events, orders');
  return { app, pool };
}

export function makeWorker(
  pool: Pool,
  now: Date,
  random = () => 1,
): WorkerService {
  return new WorkerService(pool, (() => now) as never, random);
}

export { CLOCK, RANDOM };
