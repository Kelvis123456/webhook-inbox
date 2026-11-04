import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import Stripe from 'stripe';
import { PG_POOL } from '../db/db.module.js';

export type ReceiveResult = { event: Stripe.Event; duplicate: boolean };

export class InvalidSignatureError extends Error {}

@Injectable()
export class InboxService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject('STRIPE_WEBHOOK_SECRET') private readonly secret: string,
  ) {}

  /**
   * Verifica la firma sobre el cuerpo EXACTO que llegó (un JSON reserializado ya no firma igual), guarda el evento
   * y devuelve. No procesa nada: Stripe espera una respuesta rápida y reintenta si tarda, así que el trabajo se
   * hace después, en el worker.
   */
  async receive(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<ReceiveResult> {
    if (!signature)
      throw new InvalidSignatureError('falta el header Stripe-Signature');
    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(rawBody, signature, this.secret);
    } catch (e) {
      throw new InvalidSignatureError(
        e instanceof Error ? e.message : 'firma inválida',
      );
    }

    // ON CONFLICT DO NOTHING: Stripe puede entregar el mismo evento varias veces, y dos entregas a la vez
    // no pueden insertar dos filas porque la clave primaria es el id del evento.
    const res = await this.pool.query(
      `INSERT INTO webhook_events (id, type, payload, event_created)
       VALUES ($1, $2, $3, to_timestamp($4))
       ON CONFLICT (id) DO NOTHING`,
      [event.id, event.type, JSON.stringify(event), event.created],
    );
    return { event, duplicate: res.rowCount === 0 };
  }
}
