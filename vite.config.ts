import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: {
    // fejlesztés közben a játékszerver külön fut (npm run server): a /ws kéréseket oda továbbítjuk
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
  worker: {
    format: 'es',
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // a valódi pályán futó tesztek terhelt gépen (pl. futó szerver mellett) lassabbak
    testTimeout: 20000,
  },
});
