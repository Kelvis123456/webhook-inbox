import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

// Un solo Postgres real para toda la corrida; cada prueba vacía las tablas. Con un mock no se podrían probar
// ON CONFLICT ni FOR UPDATE SKIP LOCKED, que son justo lo que importa aquí.
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  project.provide('dbUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string;
  }
}
