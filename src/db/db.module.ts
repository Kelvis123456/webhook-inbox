import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Pool } from 'pg';
import { migrate } from './schema.js';

export const PG_POOL = 'PG_POOL';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: async () => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('Falta DATABASE_URL.');
        const pool = new Pool({ connectionString: url, max: 10 });
        await migrate(pool);
        return pool;
      },
    },
  ],
  exports: [PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
