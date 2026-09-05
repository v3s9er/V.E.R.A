import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { MrRobotPlugin } from './loader.js';
import type { PluginContext } from './context.js';

export interface DiscordHost {
  port(): number;
  enabled(): boolean;
  issue(): { token: string; id: string };
  revoke(id: string): void;
  models(): unknown;
}
interface Settings { botDirectory: string; pythonPath: string; autoStart: boolean }
const defaults: Settings = { botDirectory: '', pythonPath: '', autoStart: false };
const PREFIX = '__MR_ROBOT_DISCORD__';
export function validateDiscordSettings(value: unknown): Settings {
  const v = value as Partial<Settings>;
  if (!v || typeof v.botDirectory !== 'string' || typeof v.pythonPath !== 'string'
    || !isAbsolute(v.botDirectory) || !isAbsolute(v.pythonPath)) throw new Error('봇 폴더와 Python 실행 파일의 절대 경로를 입력하세요.');
  if (!existsSync(join(v.botDirectory, 'bot', 'client.py')) || !existsSync(join(v.botDirectory, 'main.py'))
    || !existsSync(v.pythonPath)) throw new Error('기존 봇 소스 또는 Python 실행 파일을 찾을 수 없습니다.');
  return { botDirectory: resolve(v.botDirectory), pythonPath: resolve(v.pythonPath), autoStart: v.autoStart === true };
}

/** Outbound Discord gateway -> private stdio -> ordinary ask-capped loopback client. */
export function createDiscordPlugin(host: DiscordHost, runtime = { spawn }): MrRobotPlugin {
  let ctx: PluginContext;
  let child: ChildProcessWithoutNullStreams | undefined;
  let socket: WebSocket | undefined;
  let linkId: string | undefined;
  let serial = 0;
  let generation = 0;
  let busy = false;
  let starting = false;
  let paused = false;
  let ready = false;
  let owner = '';
  let lastError = '';
  let lastStart = 0;
  let activeChannel = '';
  let activeConversation = '';
  let approval: { requestId: string; conversationId: string } | undefined;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  const config = () => ({ ...defaults, ...ctx.storage.get<Settings>('config') });
  const status = () => ({ running: !!child, ready, owner, busy, error: lastError, config: config() });
  const send = (data: unknown) => {
    if (child?.stdin.writable && child.stdin.writableLength < 1_000_000) child.stdin.write(JSON.stringify(data) + '\n');
  };
  const rpc = (method: string, params: unknown, timeout = 15_000): Promise<any> => new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) return reject(new Error('PC 에이전트 연결이 끊겼습니다.'));
    const id = ++serial;
    const timer = ctx.setTimeout(() => { pending.delete(id); reject(new Error('PC 응답 시간이 초과되었습니다.')); }, timeout);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const stop = () => {
    generation++;
    const oldChild = child; child = undefined;
    const oldSocket = socket; socket = undefined;
    if (linkId) {
      const revokedId = linkId; linkId = undefined;
      try { host.revoke(revokedId); } catch { lastError = '연결은 종료했지만 권한 회수 저장에 실패했습니다. PC 설정 저장소를 확인하세요.'; }
    }
    oldSocket?.terminate();
    // Windows Python launcher shims may own the real interpreter as a child.
    // Kill only this plugin-owned PID tree so a GUI/gateway cannot outlive stop.
    if (oldChild?.pid && process.platform === 'win32') {
      try { execFileSync('taskkill.exe', ['/PID', String(oldChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 2500 }); }
      catch { oldChild.kill(); }
    } else oldChild?.kill();
    for (const p of pending.values()) { ctx.clearTimeout(p.timer); p.reject(new Error('Discord 연결이 종료되었습니다.')); }
    pending.clear(); ready = false; busy = false; approval = undefined;
    activeChannel = ''; activeConversation = '';
    return status();
  };
  async function command(message: any): Promise<unknown> {
    if (!ready || String(message.userId) !== owner || !/^\d{15,22}$/.test(String(message.channelId))) throw new Error('봇 소유자 인증이 필요합니다.');
    const channel = String(message.channelId);
    if (message.action === 'models') return host.models();
    if (message.action === 'status') return { ready, busy, permission: 'ask', tokenPolicy: 'adaptive' };
    if (message.action === 'stop') {
      if (!busy || channel !== activeChannel) return { ok: false, message: '이 채널에서 실행 중인 작업이 없습니다.' };
      return rpc('chat.cancel', { conversationId: activeConversation });
    }
    if (message.action === 'approve') {
      if (channel !== activeChannel || !approval || approval.requestId !== message.requestId) throw new Error('만료되었거나 다른 작업의 승인 요청입니다.');
      const current = approval; approval = undefined;
      return rpc('chat.confirmResponse', { ...current, approve: message.approve === true });
    }
    if (busy) throw new Error('다른 작업을 처리하고 있습니다. /robot stop으로 중지한 뒤 다시 요청하세요.');
    const conversations = ctx.storage.get<Record<string, string>>('conversations') ?? {};
    if (message.action === 'new') {
      delete conversations[channel]; ctx.storage.set('conversations', conversations);
      return { message: '다음 명령부터 새 대화를 시작합니다.' };
    }
    if (message.action !== 'ask' || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 6000) throw new Error('명령은 1~6000자로 입력하세요.');
    const commandGeneration = generation;
    busy = true; activeChannel = channel;
    try {
      if (!conversations[channel]) {
        if (Object.keys(conversations).length >= 64) throw new Error('Discord 대화 채널 한도(64)에 도달했습니다.');
        const result = await rpc('conversations.create', { title: 'Discord', permissionMode: 'ask', tokenPolicy: 'adaptive' });
        conversations[channel] = result.id;
        ctx.storage.set('conversations', conversations);
      }
      activeConversation = conversations[channel]!;
      return await rpc('chat.start', {
        conversationId: activeConversation, text: message.text, permissionMode: 'ask', tokenPolicy: 'adaptive',
        ...(typeof message.providerId === 'string' && message.providerId ? { providerId: message.providerId } : {}),
        ...(typeof message.model === 'string' && message.model ? { providerModel: message.model } : {}),
        reasoningEffort: ['auto', 'low', 'medium', 'high'].includes(message.effort) ? message.effort : 'auto',
      }, 600_000);
    } catch (error) {
      if (commandGeneration === generation && activeConversation) await rpc('chat.cancel', { conversationId: activeConversation }).catch(() => {});
      throw error;
    } finally { if (commandGeneration === generation) { busy = false; approval = undefined; activeChannel = ''; activeConversation = ''; } }
  }
  async function start() {
    if (child || starting) return status();
    if (!host.enabled()) throw new Error('먼저 Discord 플러그인을 켜세요.');
    const settings = validateDiscordSettings(config());
    if (!host.port()) throw new Error('PC 에이전트가 아직 시작 중입니다.');
    const runner = [
      join(dirname(fileURLToPath(import.meta.url)).replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'integrations', 'discordbot', 'bridge.py'),
      join(dirname(fileURLToPath(import.meta.url)), 'integrations', 'discordbot', 'bridge.py'),
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../..', 'integrations', 'discordbot', 'bridge.py'),
    ].find(existsSync);
    if (!runner) throw new Error('Discord 브리지 파일이 없습니다. 설치를 복구하세요.');
    lastError = ''; lastStart = Date.now(); starting = true; paused = false;
    const current = ++generation;
    try {
      const grant = host.issue(); linkId = grant.id;
      ctx.storage.set('activeLinkId', grant.id);
      socket = new WebSocket(`ws://127.0.0.1:${host.port()}/ws`, 'mr-robot-rpc-v1', { handshakeTimeout: 10_000, maxPayload: 4_000_000 });
      socket.on('message', (raw) => {
        if (current !== generation) return;
        let message: any; try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.id !== undefined && message.id !== 0) {
          const p = pending.get(message.id); if (!p) return;
          pending.delete(message.id); ctx.clearTimeout(p.timer);
          if (message.error) p.reject(new Error('PC 작업 실패: ' + String(message.error.message ?? message.error).slice(0, 600)));
          else p.resolve(message.result);
        } else if (message.event === 'chat.confirm' && busy && message.data?.conversationId === activeConversation) {
          approval = { requestId: message.data.requestId, conversationId: activeConversation };
          send({ event: 'approval', channelId: activeChannel, data: message.data });
        }
      });
      socket.on('error', () => { lastError = 'PC 연결 오류'; stop(); });
      socket.on('close', () => { if (current === generation) { lastError = 'PC 연결이 종료되었습니다.'; stop(); } });
      await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); socket!.once('close', () => reject(new Error('PC 연결이 종료되었습니다.'))); });
      const auth = await rpc('auth', { secret: grant.token });
      if (!auth?.ok || auth.isAdmin || auth.permissionCap !== 'ask') throw new Error('Discord 제한 권한을 확인하지 못했습니다.');
      if (current !== generation) throw new Error('시작이 취소되었습니다.');
      child = runtime.spawn(settings.pythonPath, ['-u', runner], { cwd: settings.botDirectory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      child.stdin.on('error', () => {});
      child.stderr.resume(); // Never persist bot credentials or arbitrary Python exception text.
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (current !== generation) return;
        buffer += chunk;
        if (buffer.length > 128_000) { lastError = 'Discord 브리지 출력 한도 초과'; stop(); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.startsWith(PREFIX)) continue;
          let message: any; try { message = JSON.parse(line.slice(PREFIX.length)); } catch { continue; }
          if (message.event === 'ready' && /^\d{15,22}$/.test(String(message.owner))) { owner = String(message.owner); ready = true; continue; }
          if (message.event === 'disconnected') { ready = false; if (busy) void rpc('chat.cancel', { conversationId: activeConversation }).catch(() => {}); continue; }
          if (message.event === 'error') { lastError = 'Discord 로그인/명령 등록 실패. 봇 토큰·서버 권한·Python 의존성을 확인하세요.'; continue; }
          if (typeof message.id !== 'string' || message.id.length > 64) continue;
          void command(message).then((result) => { if (current === generation) send({ id: message.id, result }); }, (error) => {
            if (current === generation) send({ id: message.id, error: error instanceof Error ? error.message : '작업 실패' });
          });
        }
      });
      child.once('error', () => { if (current === generation) { lastError = 'Discord Python 실행 실패'; stop(); } });
      child.once('exit', () => { if (current === generation) { lastError = 'Discord 봇이 종료되었습니다. 중복 실행 여부를 확인하세요.'; stop(); } });
      send({ botDirectory: settings.botDirectory });
      ctx.setTimeout(() => { if (current === generation && !ready) { lastError = 'Discord 로그인 시간이 초과되었습니다. 봇 토큰과 네트워크를 확인하세요.'; stop(); } }, 45_000);
      return status();
    } catch (error) { stop(); throw error; }
    finally { starting = false; }
  }
  return {
    manifest: { id: 'discord-agent', name: 'Discord Agent', version: '1.0.0', kind: 'integration', enabledByDefault: false,
      description: '기존 Discord 봇에서 /robot 명령으로 PC 에이전트 호출. 소유자 전용, 작업 승인·중지 지원.', permissions: ['network.client'] },
    activate(context) {
      ctx = context;
      const stale = ctx.storage.get<string>('activeLinkId'); if (stale) host.revoke(stale);
      const opts = { adminOnly: true, destructive: false, tool: false };
      ctx.registerCommand('discord.status', () => status(), opts);
      ctx.registerCommand('discord.config.get', () => config(), opts);
      ctx.registerCommand('discord.config.set', (value) => { stop(); const settings = validateDiscordSettings(value); ctx.storage.set('config', settings); return settings; }, opts);
      ctx.registerCommand('discord.start', start, { ...opts, destructive: true });
      ctx.registerCommand('discord.stop', () => { paused = true; return stop(); }, opts);
      ctx.on('plugins.changed', () => { if (!host.enabled()) stop(); });
      ctx.setInterval(() => {
        if (!child && !paused && host.enabled() && config().autoStart && host.port() && Date.now() - lastStart > 60_000) {
          lastStart = Date.now(); void start().catch(() => { lastError = '자동 연결 실패. 설정과 기존 봇 실행 여부를 확인하세요.'; });
        }
      }, 5000);
    },
    deactivate() { stop(); },
  };
}
