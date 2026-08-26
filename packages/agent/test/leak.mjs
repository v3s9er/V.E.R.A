/**
 * Memory-leak measurement. Run with:
 *   node --expose-gc packages/agent/test/leak.mjs
 *
 * A TRUE leak grows linearly across equal-sized batches. Warmup/GC noise
 * plateaus: batch2 grows much less than batch1. We test plugin load/unload,
 * WS connect/auth/disconnect and screen-stream cycles this way, plus verify
 * every tracked resource (listeners, clients, plugins) returns to baseline.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(here, '..', 'dist');
const helloPath = resolve(here, '..', '..', '..', 'examples', 'plugins', 'hello', 'index.js');
const monitorPath = resolve(here, '..', '..', '..', 'examples', 'plugins', 'monitor', 'index.js');

process.env.MR_ROBOT_HOME = mkdtempSync(join(tmpdir(), 'mr-robot-leak-'));

const { AgentServer } = await import(pathToFileURL(join(dist, 'server', 'server.js')).href);
const server = new AgentServer();
await server.start({ port: 8797, host: '127.0.0.1' });

const gcNow = () => {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
  }
};

const measure = (label) => {
  gcNow();
  const m = process.memoryUsage();
  const kb = (v) => Math.round(v / 1024);
  console.log(
    `${label.padEnd(26)} heap=${String(kb(m.heapUsed)).padStart(6)} KB  listeners(log)=${server.bus.listenerCount('log')}  clients=${server.hub?.clients.size ?? '?'}  plugins=${server.plugins.list().length}`,
  );
  return m.heapUsed;
};

const open = (s) => new Promise((r) => s.once('open', r));
const rpc = (s, method, params) =>
  new Promise((resolveRpc) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        s.off('message', onMsg);
        resolveRpc(msg);
      }
    };
    s.on('message', onMsg);
    s.send(JSON.stringify({ id, method, params }));
  });

// ---------------------------------------------------------------- 1. plugins
const pluginCycle = async (n) => {
  for (let i = 0; i < n; i++) {
    await server.plugins.load(monitorPath);
    await server.plugins.unload('monitor');
  }
};

const base = measure('baseline');
await pluginCycle(300);
const pluginB1 = measure('after plugin batch1 (300)');
await pluginCycle(300);
const pluginB2 = measure('after plugin batch2 (600)');

// ------------------------------------------------------------------ 2. ws
const wsCycle = async (n) => {
  for (let i = 0; i < n; i++) {
    const ws = new WebSocket('ws://127.0.0.1:8797/ws');
    await open(ws);
    await rpc(ws, 'auth', { secret: server.secret });
    await rpc(ws, 'status', {});
    ws.close();
  }
  await new Promise((r) => setTimeout(r, 300));
};

await wsCycle(40);
const wsB1 = measure('after ws batch1 (40)');
await wsCycle(40);
const wsB2 = measure('after ws batch2 (80)');

// --------------------------------------------------------------- 3. stream
{
  const ws = new WebSocket('ws://127.0.0.1:8797/ws');
  await open(ws);
  await rpc(ws, 'auth', { secret: server.secret });
  for (let i = 0; i < 20; i++) {
    await rpc(ws, 'computer.stream.start', { fps: 5, quality: 40 });
    await new Promise((r) => setTimeout(r, 250));
    await rpc(ws, 'computer.stream.stop', {});
  }
  ws.close();
  await new Promise((r) => setTimeout(r, 300));
}
const streamEnd = measure('after 20 stream start/stop');

// ---------------------------------------------------------------- verdict
gcNow();
const finalHeap = process.memoryUsage().heapUsed;
const kb = (b) => Math.round(b / 1024);
const growths = [
  ['plugin batch1', pluginB1 - base],
  ['plugin batch2', pluginB2 - pluginB1],
  ['ws batch1', wsB1 - pluginB2],
  ['ws batch2', wsB2 - wsB1],
];
console.log('');
for (const [label, bytes] of growths) console.log(`  ${label.padEnd(14)} ${String(kb(bytes)).padStart(5)} KB`);
console.log(`  total drift  ${kb(finalHeap - base)} KB`);

const pluginPlateau = pluginB2 - pluginB1 < Math.max(1024, (pluginB1 - base) / 2);
const wsPlateau = wsB2 - wsB1 < Math.max(1024, (wsB1 - pluginB2) / 2);
const clean =
  server.bus.listenerCount('log') === 1 &&
  server.hub?.clients.size === 0 &&
  server.plugins.list().length === 0;
const ok = pluginPlateau && wsPlateau && clean && finalHeap - base < 16 * 1024 * 1024;
console.log(ok ? 'NO LEAK DETECTED' : 'POSSIBLE LEAK — investigate');

await server.stop();
rmSync(process.env.MR_ROBOT_HOME, { recursive: true, force: true });
process.exitCode = ok ? 0 : 1;
