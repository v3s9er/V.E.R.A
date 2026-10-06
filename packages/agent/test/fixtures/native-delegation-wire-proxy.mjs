// Opt-in synthetic-fixture diagnostics only. Never records payloads or IDs.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const safe = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_./-]{0,100}$/.test(value) ? value : undefined;
const child = spawn(process.env.VERA_WIRE_COMMAND, [...JSON.parse(process.env.VERA_WIRE_PREFIX), ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
process.stdin.pipe(child.stdin); child.stdin.on('error', () => {});
child.stderr.on('data', data => process.stderr.write(data));
createInterface({ input: child.stdout }).on('line', line => {
  const m = JSON.parse(line);
  const item = m.params?.item, legacy = m.params?.msg;
  appendFileSync(process.env.VERA_WIRE_TRACE, JSON.stringify({ method: safe(m.method), itemType: safe(item?.type), tool: safe(item?.tool),
    rawName: safe(item?.name), legacyType: safe(legacy?.type), rpcError: Boolean(m.error), serverRequest: m.id !== undefined && Boolean(m.method) }) + '\n');
  process.stdout.write(line + '\n');
});
child.on('error', () => process.exit(1));
child.on('close', code => process.exit(code ?? 1));
