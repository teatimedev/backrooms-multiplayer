import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../shared/src', import.meta.url)) },
  },
  server: {
    port: 5314,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://localhost:8471', ws: true } },
  },
  build: { chunkSizeWarningLimit: 1200 },
});
