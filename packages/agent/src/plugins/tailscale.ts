import { spawn } from 'node:child_process';
import type { MrRobotPlugin } from './loader.js';

function run(args: string[], timeoutMs = 12_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('tailscale', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: Buffer) => { if (output.length < 256_000) output += chunk.toString(); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, output: error.message }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: output.trim() }); });
  });
}

export function createTailscalePlugin(): MrRobotPlugin {
  return {
    manifest: {
      id: 'tailscale-connect', name: 'Tailscale Connect', version: '0.2.0', kind: 'transport', enabledByDefault: false,
      description: '휴대폰·노트북을 외부망에서도 직접 연결하고 Mr.Robot 파일 전송을 운반합니다.',
      capabilities: ['transport.tailnet', 'files.peer-transfer'],
      permissions: ['network.client'],
      dependencies: [{ id: 'tailscale', name: 'Tailscale', required: true }],
    },
    activate(ctx) {
      ctx.registerCommand('tailscale.status', async () => {
        const result = await run(['status', '--json']);
        if (!result.ok) return { ok: false, installed: !/ENOENT|not found/i.test(result.output), error: result.output };
        try {
          const data = JSON.parse(result.output) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] }; Peer?: Record<string, unknown> };
          return { ok: data.BackendState === 'Running', state: data.BackendState, self: data.Self, peers: Object.keys(data.Peer ?? {}).length };
        } catch { return { ok: true, output: result.output }; }
      }, { destructive: false });
      ctx.registerCommand('tailscale.peers', async () => {
        const result = await run(['status', '--json']);
        if (!result.ok) throw new Error(result.output);
        const data = JSON.parse(result.output) as { Peer?: Record<string, { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean }> };
        return Object.entries(data.Peer ?? {}).map(([id, peer]) => ({ id, name: peer.HostName ?? peer.DNSName ?? id, addresses: peer.TailscaleIPs ?? [], online: peer.Online === true }));
      }, { destructive: false });
    },
  };
}
