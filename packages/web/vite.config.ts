import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { clientBuildIdentity } from './build-identity.mjs';

const clientIdentity = clientBuildIdentity();

// Dev server proxies /api + /ws to the local agent (http://127.0.0.1:8787).
// In production the agent itself serves packages/web/dist on the same origin.
export default defineConfig({
  plugins: [react()],
  define: {
    __VERA_CLIENT_VERSION__: JSON.stringify(clientIdentity.version),
    __VERA_CLIENT_BUILD__: JSON.stringify(clientIdentity.build),
  },
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
