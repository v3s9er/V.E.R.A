import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// No production Vite proxy, user browser profile, fixed port, or real PC RPC.
export async function fixtureServer() {
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
    plugins: [react()], server: { host: '127.0.0.1', port: 0, proxy: {}, hmr: false, watch: null } });
  try { await server.listen(); }
  catch (error) { await server.close(); throw error; }
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  return { origin, close: () => server.close(), route: route => {
    const url = new URL(route.request().url());
    return url.origin === origin && !url.pathname.startsWith('/api/') ? route.continue() : route.abort();
  } };
}
