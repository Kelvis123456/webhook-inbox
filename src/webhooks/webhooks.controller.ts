import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { InboxService, InvalidSignatureError } from './inbox.service.js';

@Controller('webhooks')
export class WebhooksController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService) {}

  @Post('stripe')
  @HttpCode(200)
  async stripe(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true; duplicate: boolean }> {
    if (!req.rawBody) throw new BadRequestException('sin cuerpo');
    try {
      const { duplicate } = await this.inbox.receive(req.rawBody, signature);
      return { received: true, duplicate };
    } catch (e) {
      // Se responde 400 sin el detalle: quien manda una firma mala no necesita saber qué comprobación falló.
      if (e instanceof InvalidSignatureError)
        throw new BadRequestException('firma inválida');
      throw e;
    }
  }
}
