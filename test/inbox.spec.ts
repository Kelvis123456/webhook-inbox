import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeEvent, paymentIntent, sign, startApp } from './helpers.js';

let app: INestApplication;
let pool: Pool;

beforeAll(async () => {
  ({ app, pool } = await startApp());
  await app.listen(0);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await pool.query('TRUNCATE webhook_events, orders');
});

const post = (payload: string, signature?: string) => {
  const req = request(app.getHttpServer())
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json');
  if (signature) req.set('Stripe-Signature', signature);
  return req.send(payload);
};
const count = async () =>
  Number(
    (await pool.query('SELECT count(*) FROM webhook_events')).rows[0].count,
  );

describe('firma', () => {
  it('guarda un evento firmado y responde 200 sin procesarlo', async () => {
    const { payload, signature } = sign(
      makeEvent('payment_intent.succeeded', paymentIntent()),
    );
    const res = await post(payload, signature);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: false });
    const row = (
      await pool.query('SELECT status, attempts FROM webhook_events')
    ).rows[0];
    expect(row).toEqual({ status: 'pending', attempts: 0 });
    expect((await pool.query('SELECT 1 FROM orders')).rowCount).toBe(0);
  });

  it('rechaza con 400 una petición sin cabecera de firma', async () => {
    const { payload } = sign(
      makeEvent('payment_intent.succeeded', paymentIntent()),
    );
    expect((await post(payload)).status).toBe(400);
    expect(await count()).toBe(0);
  });

  it('rechaza una firma hecha con otro secreto', async () => {
    const { payload, signature } = sign(
      makeEvent('payment_intent.succeeded', paymentIntent()),
      { secret: 'whsec_otro' },
    );
    expect((await post(payload, signature)).status).toBe(400);
    expect(await count()).toBe(0);
  });

  it('rechaza un cuerpo alterado después de firmar', async () => {
    const event = makeEvent(
      'payment_intent.succeeded',
      paymentIntent('pi_1', 5000),
    );
    const { signature } = sign(event);
    const tampered = JSON.stringify({
      ...event,
      data: { object: paymentIntent('pi_1', 1) },
    });
    expect((await post(tampered, signature)).status).toBe(400);
    expect(await count()).toBe(0);
  });

  it('rechaza el mismo JSON reserializado: la firma es sobre los bytes exactos', async () => {
    const event = makeEvent('payment_intent.succeeded', paymentIntent());
    const { signature } = sign(event);
    const pretty = JSON.stringify(event, null, 2);
    expect((await post(pretty, signature)).status).toBe(400);
  });

  it('rechaza una firma vieja, aunque sea auténtica (repetición)', async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const { payload, signature } = sign(
      makeEvent('payment_intent.succeeded', paymentIntent()),
      { timestamp: old },
    );
    expect((await post(payload, signature)).status).toBe(400);
    expect(await count()).toBe(0);
  });

  it('no filtra el motivo del rechazo en la respuesta', async () => {
    const { payload } = sign(
      makeEvent('payment_intent.succeeded', paymentIntent()),
    );
    const res = await post(payload, 't=1,v1=00');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/signature|secret|whsec/i);
  });
});

describe('idempotencia', () => {
  it('una segunda entrega del mismo evento responde 200 y no duplica la fila', async () => {
    const { payload, signature } = sign(
      makeEvent('payment_intent.succeeded', paymentIntent(), { id: 'evt_dup' }),
    );
    expect((await post(payload, signature)).body.duplicate).toBe(false);
    expect((await post(payload, signature)).body.duplicate).toBe(true);
    expect(await count()).toBe(1);
  });

  it('20 entregas simultáneas del mismo evento dejan una sola fila y una sola respuesta "nueva"', async () => {
    const { payload, signature } = sign(
      makeEvent('payment_intent.succeeded', paymentIntent(), {
        id: 'evt_race',
      }),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => post(payload, signature)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(await count()).toBe(1);
  });
});
