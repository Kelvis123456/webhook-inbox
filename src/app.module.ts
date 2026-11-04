import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module.js';
import { AdminController } from './webhooks/admin.controller.js';
import { InboxService } from './webhooks/inbox.service.js';
import { WebhooksController } from './webhooks/webhooks.controller.js';
import { CLOCK, RANDOM, WorkerService } from './webhooks/worker.service.js';

@Module({
  imports: [DbModule],
  controllers: [WebhooksController, AdminController],
  providers: [
    InboxService,
    WorkerService,
    { provide: CLOCK, useValue: () => new Date() },
    { provide: RANDOM, useValue: Math.random },
    {
      provide: 'STRIPE_WEBHOOK_SECRET',
      useFactory: () => {
        const secret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!secret) throw new Error('Falta STRIPE_WEBHOOK_SECRET.');
        return secret;
      },
    },
    { provide: 'ADMIN_TOKEN', useFactory: () => process.env.ADMIN_TOKEN },
  ],
})
export class AppModule {}
