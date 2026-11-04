import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module.js';

const STATUSES = ['pending', 'processing', 'done', 'ignored', 'dead'];

function sameToken(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Controller('admin/events')
export class AdminController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject('ADMIN_TOKEN') private readonly token: string | undefined,
  ) {}

  // Sin ADMIN_TOKEN configurado el panel no existe, no queda abierto.
  private authorize(header: string | undefined): void {
    if (!this.token) throw new NotFoundException();
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!sameToken(bearer, this.token)) throw new UnauthorizedException();
  }

  @Get()
  async list(
    @Headers('authorization') auth: string | undefined,
    @Query('status') status = 'dead',
  ) {
    this.authorize(auth);
    if (!STATUSES.includes(status)) return [];
    const { rows } = await this.pool.query(
      `SELECT id, type, status, attempts, next_attempt_at, last_error, received_at
         FROM webhook_events WHERE status = $1 ORDER BY received_at DESC LIMIT 100`,
      [status],
    );
    return rows;
  }

  /** Devuelve un evento muerto a la cola con los intentos en cero. */
  @Post(':id/retry')
  @HttpCode(200)
  async retry(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
  ) {
    this.authorize(auth);
    const res = await this.pool.query(
      `UPDATE webhook_events
          SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
        WHERE id = $1 AND status = 'dead'`,
      [id],
    );
    if (res.rowCount === 0)
      throw new NotFoundException('no hay un evento muerto con ese id');
    return { requeued: true };
  }
}
