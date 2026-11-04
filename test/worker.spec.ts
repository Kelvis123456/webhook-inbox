import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  backoffSeconds,
} from '../src/webhooks/worker.service.js';
import {
  charge,
  freshPool,
  makeEvent,
  makeWorker,
  paymentIntent,
} from './helpers.js';

let pool: Pool;
const T0 = new Date('2026-01-01T00:00:00Z');

beforeAll(async () => {
  pool = await freshPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE webhook_events, orders');
});

async function enqueue(event: ReturnType<typeof makeEvent>) {
  await pool.query(
    `INSERT INTO webhook_events (id, type, payload, event_created, next_attempt_at)
     VALUES ($1, $2, $3, to_timestamp($4), $5)`,
    [event.id, event.type, JSON.stringify(event), event.created, T0],
  );
}
const order = async (id = 'pi_1') =>
  (await pool.query('SELECT * FROM orders WHERE payment_intent_id = $1', [id]))
    .rows[0];
const status = async (id: string) =>
  (await pool.query('SELECT * FROM webhook_events WHERE id = $1', [id]))
    .rows[0];

describe('procesar', () => {
  it('un pago exitoso marca el pedido como pagado y el evento como hecho', async () => {
    await enqueue(
      makeEvent('payment_intent.succeeded', paymentIntent('pi_1', 5000), {
        id: 'e1',
      }),
    );
    const r = await makeWorker(pool, T0).runOnce();
    expect(r).toEqual({ done: 1, failed: 0 });
    expect(await order()).toMatchObject({
      status: 'paid',
      amount: '5000',
      currency: 'usd',
    });
    expect(await status('e1')).toMatchObject({
      status: 'done',
      attempts: 1,
      locked_until: null,
    });
  });

  it('un tipo que el servicio no modela queda como ignorado', async () => {
    await enqueue(makeEvent('customer.created', { id: 'cus_1' }, { id: 'e1' }));
    await makeWorker(pool, T0).runOnce();
    expect((await status('e1')).status).toBe('ignored');
  });

  it('un reembolso parcial se reconoce pero no cambia el pedido', async () => {
    await enqueue(
      makeEvent('payment_intent.succeeded', paymentIntent(), {
        id: 'e1',
        created: 100,
      }),
    );
    await enqueue(
      makeEvent('charge.refunded', charge('pi_1', 5000, 1000), {
        id: 'e2',
        created: 200,
      }),
    );
    await makeWorker(pool, T0).runOnce();
    expect((await order()).status).toBe('paid');
    expect((await status('e2')).status).toBe('ignored');
  });
});

describe('orden de llegada', () => {
  it('el reembolso procesado antes que el pago deja el pedido reembolsado', async () => {
    // El pago ocurrió en t=100 y el reembolso en t=200, pero se procesan al revés.
    await enqueue(
      makeEvent('charge.refunded', charge(), { id: 'refund', created: 200 }),
    );
    await makeWorker(pool, T0).runOnce();
    await enqueue(
      makeEvent('payment_intent.succeeded', paymentIntent(), {
        id: 'pay',
        created: 100,
      }),
    );
    await makeWorker(pool, T0).runOnce();
    expect((await order()).status).toBe('refunded');
    expect((await order()).last_event_id).toBe('refund');
    expect((await status('pay')).status).toBe('done'); // se consumió, solo que no cambió nada
  });

  it('en el orden correcto el resultado es el mismo', async () => {
    await enqueue(
      makeEvent('payment_intent.succeeded', paymentIntent(), {
        id: 'pay',
        created: 100,
      }),
    );
    await enqueue(
      makeEvent('charge.refunded', charge(), { id: 'refund', created: 200 }),
    );
    await makeWorker(pool, T0).runOnce();
    expect((await order()).status).toBe('refunded');
  });

  it('con el mismo segundo gana el estado más avanzado, llegue en el orden que llegue', async () => {
    for (const order_ of [
      ['pay', 'refund'],
      ['refund', 'pay'],
    ]) {
      await pool.query('TRUNCATE webhook_events, orders');
      const events = {
        pay: makeEvent('payment_intent.succeeded', paymentIntent(), {
          id: 'pay',
          created: 300,
        }),
        refund: makeEvent('charge.refunded', charge(), {
          id: 'refund',
          created: 300,
        }),
      };
      for (const name of order_) {
        await enqueue(events[name as 'pay' | 'refund']);
        await makeWorker(pool, T0).runOnce();
      }
      expect((await order()).status).toBe('refunded');
    }
  });

  it('un fallo de pago posterior al pago no lo deshace si es más viejo', async () => {
    await enqueue(
      makeEvent('payment_intent.succeeded', paymentIntent(), {
        id: 'pay',
        created: 200,
      }),
    );
    await makeWorker(pool, T0).runOnce();
    await enqueue(
      makeEvent('payment_intent.payment_failed', paymentIntent(), {
        id: 'old-fail',
        created: 100,
      }),
    );
    await makeWorker(pool, T0).runOnce();
    expect((await order()).status).toBe('paid');
  });
});

describe('fallos y reintentos', () => {
  // Sin "amount" el INSERT en orders viola NOT NULL: un fallo real de base de datos, no uno simulado.
  const broken = (id: string) =>
    makeEvent(
      'payment_intent.succeeded',
      { id: 'pi_x', currency: 'usd' },
      { id },
    );

  it('un fallo reprograma el evento con backoff y no se vuelve a tomar antes de tiempo', async () => {
    await enqueue(broken('bad'));
    const r = await makeWorker(pool, T0, () => 1).runOnce();
    expect(r).toEqual({ done: 0, failed: 1 });
    const row = await status('bad');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/amount|null/i);
    expect(new Date(row.next_attempt_at).getTime()).toBe(T0.getTime() + 5_000); // 5 * 2^0 s con random = 1

    // Un segundo antes del vencimiento no se toca; después, sí.
    expect(
      await makeWorker(pool, new Date(T0.getTime() + 4_000)).runOnce(),
    ).toEqual({ done: 0, failed: 0 });
    expect((await status('bad')).attempts).toBe(1);
    expect(
      await makeWorker(pool, new Date(T0.getTime() + 5_001), () => 1).runOnce(),
    ).toEqual({ done: 0, failed: 1 });
    expect((await status('bad')).attempts).toBe(2);
  });

  it('el retraso crece de forma exponencial y tiene tope', () => {
    expect([1, 2, 3, 4].map((a) => backoffSeconds(a, () => 1))).toEqual([
      5, 10, 20, 40,
    ]);
    expect(backoffSeconds(20, () => 1)).toBe(3600);
    expect(backoffSeconds(3, () => 0)).toBe(0); // el jitter completo puede reintentar de inmediato
  });

  it(`tras ${MAX_ATTEMPTS} intentos pasa a dead y deja de reintentarse`, async () => {
    await enqueue(broken('bad'));
    let now = T0;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await makeWorker(pool, now, () => 1).runOnce();
      now = new Date(now.getTime() + 2 * 3600_000); // más que cualquier espera
    }
    const row = await status('bad');
    expect(row).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS });
    expect(
      await makeWorker(pool, new Date(now.getTime() + 86_400_000)).runOnce(),
    ).toEqual({ done: 0, failed: 0 });
    expect((await status('bad')).attempts).toBe(MAX_ATTEMPTS);
  });

  it('un evento que falla no impide procesar los demás', async () => {
    await enqueue(broken('bad'));
    await enqueue(
      makeEvent('payment_intent.succeeded', paymentIntent('pi_ok'), {
        id: 'good',
      }),
    );
    const r = await makeWorker(pool, T0).runOnce();
    expect(r).toEqual({ done: 1, failed: 1 });
    expect((await order('pi_ok')).status).toBe('paid');
  });
});

describe('concurrencia y recuperación', () => {
  it('dos workers a la vez procesan cada evento exactamente una vez', async () => {
    const n = 40;
    for (let i = 0; i < n; i++)
      await enqueue(
        makeEvent('payment_intent.succeeded', paymentIntent(`pi_${i}`), {
          id: `e${i}`,
        }),
      );
    const runs = await Promise.all([
      makeWorker(pool, T0).runOnce(n),
      makeWorker(pool, T0).runOnce(n),
      makeWorker(pool, T0).runOnce(n),
    ]);
    expect(runs.reduce((s, r) => s + r.done, 0)).toBe(n);
    const { rows } = await pool.query(
      'SELECT attempts, status FROM webhook_events',
    );
    expect(rows).toHaveLength(n);
    expect(rows.every((r) => r.attempts === 1 && r.status === 'done')).toBe(
      true,
    );
    expect(
      Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count),
    ).toBe(n);
  });

  it('una fila bloqueada por otra transacción no frena al worker: sigue con las demás', async () => {
    await enqueue(
      makeEvent('payment_intent.succeeded', paymentIntent('pi_locked'), {
        id: 'locked',
      }),
    );
    await enqueue(
      makeEvent('payment_intent.succeeded', paymentIntent('pi_free'), {
        id: 'free',
      }),
    );
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT 1 FROM webhook_events WHERE id = 'locked' FOR UPDATE",
      );
      // Sin SKIP LOCKED esto se queda esperando a que el holder suelte la fila; con él termina enseguida.
      const timeout = new Promise<'colgado'>((resolve) =>
        setTimeout(() => resolve('colgado'), 5000),
      );
      const result = await Promise.race([
        makeWorker(pool, T0).runOnce(),
        timeout,
      ]);
      expect(result).toEqual({ done: 1, failed: 0 });
      expect((await order('pi_free')).status).toBe('paid');
      expect((await order('pi_locked')) ?? null).toBeNull();
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('un evento que quedó en processing con el candado vencido lo reclama otro worker', async () => {
    await enqueue(
      makeEvent('payment_intent.succeeded', paymentIntent(), { id: 'stuck' }),
    );
    // Un worker lo tomó y murió: processing, 1 intento, candado vencido.
    await pool.query(
      `UPDATE webhook_events SET status = 'processing', attempts = 1, locked_until = $1`,
      [new Date(T0.getTime() - 1000)],
    );
    expect(await makeWorker(pool, T0).runOnce()).toEqual({
      done: 1,
      failed: 0,
    });
    expect(await status('stuck')).toMatchObject({
      status: 'done',
      attempts: 2,
    });
  });

  it('un evento en processing con el candado vigente no se toca', async () => {
    await enqueue(
      makeEvent('payment_intent.succeeded', paymentIntent(), { id: 'busy' }),
    );
    await pool.query(
      `UPDATE webhook_events SET status = 'processing', attempts = 1, locked_until = $1`,
      [new Date(T0.getTime() + 30_000)],
    );
    expect(await makeWorker(pool, T0).runOnce()).toEqual({
      done: 0,
      failed: 0,
    });
    expect((await status('busy')).status).toBe('processing');
  });

  it('procesar dos veces el mismo evento no cambia el resultado (idempotencia del efecto)', async () => {
    const ev = makeEvent('payment_intent.succeeded', paymentIntent(), {
      id: 'e1',
    });
    await enqueue(ev);
    await makeWorker(pool, T0).runOnce();
    await pool.query(
      `UPDATE webhook_events SET status = 'pending', next_attempt_at = $1`,
      [T0],
    );
    await makeWorker(pool, T0).runOnce();
    expect((await order()).status).toBe('paid');
    expect(
      Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count),
    ).toBe(1);
  });
});
