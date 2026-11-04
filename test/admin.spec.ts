import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, makeEvent, paymentIntent, startApp } from './helpers.js';

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
  const e = makeEvent('payment_intent.succeeded', paymentIntent(), {
    id: 'dead1',
  });
  await pool.query(
    `INSERT INTO webhook_events (id, type, payload, event_created, status, attempts, last_error)
     VALUES ('dead1', $1, $2, to_timestamp($3), 'dead', 6, 'boom'),
            ('ok1', $1, $2, to_timestamp($3), 'done', 1, NULL)`,
    [e.type, JSON.stringify(e), e.created],
  );
});

const auth = (token = ADMIN) => ({ Authorization: `Bearer ${token}` });

describe('panel de eventos muertos', () => {
  it('sin token responde 401 y con token incorrecto también', async () => {
    expect(
      (await request(app.getHttpServer()).get('/admin/events')).status,
    ).toBe(401);
    expect(
      (
        await request(app.getHttpServer())
          .get('/admin/events')
          .set(auth('otro'))
      ).status,
    ).toBe(401);
  });

  it('con token lista solo los muertos por defecto, sin el payload', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/events')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.map((r: { id: string }) => r.id)).toEqual(['dead1']);
    expect(res.body[0]).toMatchObject({ attempts: 6, last_error: 'boom' });
    expect(res.body[0].payload).toBeUndefined();
  });

  it('un estado que no existe da una lista vacía, no un error de SQL', async () => {
    const res = await request(app.getHttpServer())
      .get("/admin/events?status=x'; DROP TABLE orders;--")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(
      (await pool.query("SELECT to_regclass('orders') AS t")).rows[0].t,
    ).toBe('orders');
  });

  it('retry devuelve un evento muerto a la cola con los intentos en cero', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/events/dead1/retry')
      .set(auth());
    expect(res.status).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT status, attempts, last_error FROM webhook_events WHERE id = 'dead1'",
        )
      ).rows[0],
    ).toEqual({
      status: 'pending',
      attempts: 0,
      last_error: null,
    });
  });

  it('retry sobre un evento que no está muerto da 404 y no lo toca', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .post('/admin/events/ok1/retry')
          .set(auth())
      ).status,
    ).toBe(404);
    expect(
      (await pool.query("SELECT status FROM webhook_events WHERE id = 'ok1'"))
        .rows[0].status,
    ).toBe('done');
  });
});

describe('sin ADMIN_TOKEN', () => {
  it('el panel no existe: 404 aunque se mande un token', async () => {
    const { app: bare } = await startApp({ adminToken: null });
    await bare.listen(0);
    try {
      expect(
        (await request(bare.getHttpServer()).get('/admin/events').set(auth()))
          .status,
      ).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
