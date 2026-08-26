import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api + /ws to the local agent (http://127.0.0.1:8787).
// In production the agent itself serves packages/web/dist on the same origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
