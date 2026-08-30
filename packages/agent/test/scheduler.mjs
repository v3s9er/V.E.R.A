/** Quick scheduler check: add a shell job 2s out, verify it fires. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.MR_ROBOT_HOME = mkdtempSync(join(tmpdir(), 'mr-robot-sched-'));
const { AgentServer } = await import(pathToFileURL('./packages/agent/dist/server/server.js').href);

const server = new AgentServer();
server.config.updateSettings({ safety: { ...server.config.settings.safety, mode: 'full' } });
await server.start({ port: 8798, host: '127.0.0.1' });

const soon = new Date(Date.now() + 2000);
const pad = (n) => String(n).padStart(2, '0');
const at = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}`;

const job = server.scheduler.add({
  name: '테스트 예약',
  type: 'shell',
  command: 'echo scheduled-ok',
  shellKind: 'cmd',
  when: { kind: 'once', at },
  allowDestructive: false,
  permissionMode: 'full',
  createdByAdmin: true,
});
console.log('added, nextRun in', Math.round((job.nextRun - Date.now()) / 1000), 's');

await new Promise((r) => setTimeout(r, 4500));
const after = server.scheduler.list().find((j) => j.id === job.id);
console.log('enabled after run:', after.enabled, '(should be false)');
console.log('lastResult:', after.lastResult);
const ok = after.enabled === false && /scheduled-ok/.test(after.lastResult ?? '');
console.log(ok ? 'SCHEDULER TEST PASSED' : 'SCHEDULER TEST FAILED');
await server.stop();
rmSync(process.env.MR_ROBOT_HOME, { recursive: true, force: true });
process.exitCode = ok ? 0 : 1;
