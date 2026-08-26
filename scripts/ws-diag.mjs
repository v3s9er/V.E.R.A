/** Diagnose periodic WS drops: hold a connection 25s and watch for close + agent uptime. */
import WebSocket from 'ws';

const base = 'http://127.0.0.1:8787';
const pairing = await (await fetch(`${base}/api/pairing`)).json();
const paired = await (
  await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: pairing.pin }),
  })
).json();

const status = async () => {
  try {
    const r = await (await fetch(`${base}/api/status`, { headers: { 'x-mr-robot-token': paired.secret } })).json();
    console.log(`agent uptime=${r.uptimeSec}s`);
  } catch (e) {
    console.log('status fetch failed:', e.message);
  }
};
await status();

const ws = new WebSocket('ws://127.0.0.1:8787/ws');
const t0 = Date.now();
let closes = 0;
let errors = 0;
ws.on('open', () => console.log(`[${(Date.now() - t0) / 1000}s] open`));
ws.on('error', (e) => {
  errors++;
  console.log(`[${(Date.now() - t0) / 1000}s] error: ${e.message}`);
});
ws.on('close', (code, reason) => {
  closes++;
  console.log(`[${(Date.now() - t0) / 1000}s] CLOSE code=${code} reason=${reason}`);
});

// auth then hold
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id === 1) {
    console.log(`[${(Date.now() - t0) / 1000}s] auth ok=${m.result?.ok}`);
    // keep socket open, just wait
  }
});
await new Promise((r) => {
  ws.once('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'auth', params: { secret: paired.secret } }));
    r();
  });
});

await new Promise((r) => setTimeout(r, 25000));
console.log(`after 25s: closes=${closes} errors=${errors} readyState=${ws.readyState}`);
await status();
ws.close();
await new Promise((r) => setTimeout(r, 500));
