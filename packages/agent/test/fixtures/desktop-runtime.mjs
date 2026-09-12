import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.command === 'hang') return;
  if (m.command === 'exit') { process.exit(1); return; }
  const reply = () => process.stdout.write(JSON.stringify({ id: m.command === 'wrong-id' ? m.id + 1 : m.id,
    ok: true, result: { pid: process.pid, owner: m.owner, value: m.input.value ?? '한글 ✓', image: null } }) + '\n');
  if (m.command === 'slow') setTimeout(reply, 120); else reply();
});
