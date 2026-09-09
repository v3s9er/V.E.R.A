import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mrRobotHome } from '../config.js';
import type { PluginContext } from './context.js';
import type { MrRobotPlugin } from './loader.js';

export function lidDisplayHelperPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'integrations/lid-display/bridge.ps1'), resolve(here, '../../../../integrations/lid-display/bridge.ps1')];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('덮개 화면 플러그인 파일이 없습니다. 설치를 복구하세요.');
  return found;
}

export function createLidDisplayPlugin(enabled: () => boolean, runtime = { spawn, platform: process.platform, helper: lidDisplayHelperPath }): MrRobotPlugin {
  let ctx: PluginContext;
  let child: ChildProcessWithoutNullStreams | undefined;
  let state = 'off', error = '', paused = false;
  let stopping: Promise<void> | undefined;
  const status = () => ({ enabled: enabled(), running: !!child, supported: runtime.platform === 'win32', state, error });
  const notify = () => ctx.emit('lid-display.changed', status());
  const stop = () => {
    if (stopping) return stopping;
    const current = child;
    if (!current) { state = 'off'; notify(); return Promise.resolve(); }
    state = 'restoring'; notify();
    stopping = new Promise<void>(resolveStop => {
      const timer = ctx.setTimeout(() => {
        error = '화면 복구 응답이 지연됐습니다. 재시도하거나 Win+P로 화면을 복구하세요. 저장된 구성은 유지됩니다.';
        current.kill(); finish();
      }, 2500); // Plugin manager bounds teardown at 3s; never orphan a helper.
      const finish = () => { ctx.clearTimeout(timer); current.removeListener('close', finish); resolveStop(); };
      current.once('close', finish);
      current.stdin.end('stop\n'); // Helper restores before exit; EOF is also a stop.
    }).finally(() => { stopping = undefined; });
    return stopping;
  };
  const start = async () => {
    if (stopping) await stopping;
    if (child || !enabled()) return status();
    if (runtime.platform !== 'win32') throw new Error('Windows 노트북에서만 사용할 수 있습니다.');
    const helper = runtime.helper();
    state = 'starting'; error = ''; notify();
    const current = runtime.spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Sta', '-File', helper, '-ParentPid', String(process.pid), '-StatePath', join(mrRobotHome(), 'plugins/lid-display-recovery.json')],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = current;
    current.stdin.on('error', () => {});
    let buffer = '';
    const readyTimeout = ctx.setTimeout(() => {
      if (child !== current || state !== 'starting') return;
      error = '덮개 감지를 시작하지 못했습니다. Windows PowerShell 실행 정책과 노트북 지원 여부를 확인하세요.';
      paused = true; void stop();
    }, 20_000);
    current.stdout.setEncoding('utf8');
    current.stdout.on('data', (chunk: string) => {
      if (child !== current) return;
      buffer += chunk;
      if (buffer.length > 8192) { error = '덮개 감지 응답 오류'; paused = true; void stop(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (!['ready', 'open', 'closed', 'disconnected', 'restored', 'stopped', 'error'].includes(message.state)) continue;
          state = message.state; ctx.clearTimeout(readyTimeout);
          if (state === 'error') error = message.detail === 'No internal laptop display detected' ? '내장 화면을 확인할 수 없습니다. Windows 노트북의 로컬 세션에서 실행하세요.' : `화면 전환을 완료하지 못했습니다 (${String(message.detail).slice(0, 150)}). Win+P로도 복구할 수 있습니다.`;
          else error = '';
          notify();
        } catch { /* Ignore non-protocol startup output; never persist it. */ }
      }
    });
    current.stderr.resume();
    const exited = () => {
      ctx.clearTimeout(readyTimeout);
      if (child !== current) return;
      child = undefined;
      if (enabled() && !stopping) { paused = true; error ||= '덮개 감지 프로그램이 종료됐습니다. 다시 시작을 누르세요.'; }
      state = error ? 'error' : 'off'; notify();
    };
    current.once('error', () => { error = 'Windows 덮개 감지 프로그램을 시작하지 못했습니다.'; exited(); });
    current.once('close', exited);
    return status();
  };
  return {
    manifest: { id: 'lid-display', name: '덮개 · 외부 화면', version: '1.0.0', category: 'system', kind: 'workflow', enabledByDefault: false,
      description: '닫으면 외부 화면 출력만 해제하고, 열면 기존 화면 배치를 복구합니다. Windows 노트북 전용 · 덮개 전원 설정은 변경하지 않습니다.', permissions: ['process.execute'] },
    activate(context) {
      ctx = context;
      const opts = { adminOnly: true, tool: false, destructive: false };
      ctx.registerCommand('lid-display.status', status, opts);
      ctx.registerCommand('lid-display.retry', () => { paused = false; return start(); }, opts);
      ctx.registerCommand('lid-display.restore', () => {
        if (!child) throw new Error('플러그인을 켠 뒤 다시 시도하세요. 긴급 복구는 Win+P를 사용하세요.');
        child.stdin.write('restore\n'); return status();
      }, opts);
      ctx.on('plugins.changed', () => {
        if (!enabled()) { paused = false; void stop(); }
        else if (!paused) void start().catch(e => { paused = true; state = 'error'; error = e.message; notify(); });
      });
    },
    async deactivate() { paused = true; await stop(); },
  };
}
