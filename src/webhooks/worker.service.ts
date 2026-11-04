import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import { PG_POOL } from '../db/db.module.js';
import { HANDLERS } from './handlers.js';

export const CLOCK = 'CLOCK';
export const RANDOM = 'RANDOM';
export type Clock = () => Date;

export const MAX_ATTEMPTS = 6;
const LOCK_SECONDS = 60; // si un worker muere con un evento tomado, a los 60 s otro lo reclama
const BASE_DELAY_S = 5;
const CAP_DELAY_S = 3600;

type Row = { id: string; payload: Stripe.Event; attempts: number };

/** Backoff exponencial con jitter completo: entre 0 y min(tope, base * 2^(intento-1)) segundos. */
export function backoffSeconds(attempt: number, random: () => number): number {
  return random() * Math.min(CAP_DELAY_S, BASE_DELAY_S * 2 ** (attempt - 1));
}

@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RANDOM) private readonly random: () => number,
  ) {}

  onModuleInit(): void {
    const every = Number(process.env.WORKER_INTERVAL_MS ?? 1000);
    if (every > 0) {
      this.timer = setInterval(() => void this.tick(), every);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // no se solapan dos pasadas del mismo proceso
    this.running = true;
    try {
      await this.runOnce();
    } catch (e) {
      this.log.error(e instanceof Error ? e.message : String(e));
    } finally {
      this.running = false;
    }
  }

  /** Toma hasta `limit` eventos listos y los procesa. Devuelve cuántos terminaron bien y cuántos fallaron. */
  async runOnce(limit = 10): Promise<{ done: number; failed: number }> {
    const now = this.clock();
    // Que dos workers no tomen el mismo evento lo garantiza el UPDATE: tras esperar el bloqueo, Postgres vuelve a
    // evaluar el WHERE y el evento ya está en 'processing'. SKIP LOCKED añade que el segundo worker no espera a
    // que el primero termine y sigue con otras filas (hay una prueba de eso). También se reclaman los que quedaron
    // en 'processing' con el candado vencido, es decir, los de un worker que murió a la mitad.
    const { rows } = await this.pool.query<Row>(
      `UPDATE webhook_events
          SET status = 'processing', attempts = attempts + 1,
              locked_until = $1::timestamptz + make_interval(secs => $2)
        WHERE id IN (
          SELECT id FROM webhook_events
           WHERE (status = 'pending' AND next_attempt_at <= $1)
              OR (status = 'processing' AND locked_until < $1)
           ORDER BY next_attempt_at
           LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING id, payload, attempts`,
      [now, LOCK_SECONDS, limit],
    );

    let done = 0;
    let failed = 0;
    for (const row of rows) {
      if (await this.process(row)) done++;
      else failed++;
    }
    return { done, failed };
  }

  private async process(row: Row): Promise<boolean> {
    const handler = HANDLERS[row.payload.type];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // El efecto sobre el pedido y la marca 'done' van en la misma transacción: o pasan las dos o ninguna,
      // así un fallo a medias no deja el pedido cambiado con el evento todavía pendiente.
      const outcome = handler ? await handler(client, row.payload) : 'ignored';
      await client.query(
        `UPDATE webhook_events
            SET status = $2, processed_at = $3, locked_until = NULL, last_error = NULL
          WHERE id = $1 AND status = 'processing'`,
        [row.id, outcome === 'ignored' ? 'ignored' : 'done', this.clock()],
      );
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await this.markFailed(row, e);
      return false;
    } finally {
      client.release();
    }
  }

  private async markFailed(row: Row, error: unknown): Promise<void> {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 500);
    const dead = row.attempts >= MAX_ATTEMPTS;
    const next = new Date(
      this.clock().getTime() + backoffSeconds(row.attempts, this.random) * 1000,
    );
    await this.pool.query(
      `UPDATE webhook_events
          SET status = $2, next_attempt_at = $3, locked_until = NULL, last_error = $4
        WHERE id = $1`,
      [row.id, dead ? 'dead' : 'pending', next, message],
    );
    this.log.warn(
      `evento ${row.id} falló (intento ${row.attempts}): ${message}${dead ? ' -> dead' : ''}`,
    );
  }
}
