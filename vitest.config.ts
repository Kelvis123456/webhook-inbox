import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Los archivos comparten un solo Postgres y cada prueba vacía las tablas: no pueden correr a la vez.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
