// Explicit integration test: requires Docker Linux engine; may pull the fixed image.
import assert from 'node:assert/strict';
import { DiscordSandboxPool } from '../src/server/discord-sandbox.js';
const pool = new DiscordSandboxPool();
const key = 'synthetic-sandbox-' + Date.now();
try {
  const start = performance.now();
  assert.equal((await pool.execute(key, 'from pathlib import Path\nPath("fixture.txt").write_text("fixture")\nprint("ready")')).trim(), 'ready');
  const coldMs = Math.round(performance.now() - start), warm = performance.now();
  assert.equal((await pool.execute(key, 'from pathlib import Path\nprint(Path("fixture.txt").read_text())')).trim(), 'fixture');
  const warmMs = Math.round(performance.now() - warm);
  assert.equal((await pool.execute(key + '-other', 'from pathlib import Path\nprint(Path("fixture.txt").exists())')).trim(), 'False');
  const checks = await pool.execute(key, 'import os,socket\nassert os.getuid()==65534\nassert not os.access("/proc/1/environ", os.R_OK)\nassert not os.path.exists("/var/run/docker.sock")\ns=socket.socket();s.settimeout(1)\ntry:\n s.connect(("1.1.1.1",443))\n raise AssertionError("network permitted")\nexcept OSError: pass\nprint("isolated")');
  assert.equal(checks.trim(), 'isolated');
  console.log(JSON.stringify({ passed: true, coldMs, warmMs, checks: 'cross-ticket files, non-root, no daemon socket, no external network' }));
} finally { await pool.close(); }
