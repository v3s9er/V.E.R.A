import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { MrRobotPlugin } from './loader.js';
import type { PluginContext } from './context.js';
import type { PermissionMode } from '@mr-robot/shared';
import { chatFileLinks } from '@mr-robot/shared';
import { DiscordSessions } from './discord-sessions.js';
import { DiscordRunConnection } from './discord-run.js';
import { discordAttachmentContext } from './discord-attachments.js';
import { discordAttachmentStore, validateAttachmentSources } from '../server/discord-attachment-store.js';
import { attachmentInstructions, readDiscordAttachment } from '../server/discord-documents.js';
import { configureDiscordSandboxEngine, closeDiscordSandboxes } from '../server/discord-sandbox.js';
import { discordAccess, parseDiscordAccess, DISCORD_ADMIN_ACTIONS } from './discord-access.js';
import { assertDiscordModelAllowed, discordModelAllowed, parseDiscordModelCeiling } from './discord-model-policy.js';

export interface DiscordHost {
  port(): number;
  enabled(): boolean;
  issue(): { token: string; id: string };
  revoke(id: string): void;
  models(providerId?: string): unknown;
  permissionCeiling(): PermissionMode;
  readChatFile?(conversationId: string, path: string, offset: number, limit: number, version?: string, isolated?: boolean): unknown;
}
interface Settings { botDirectory: string; pythonPath: string; autoStart: boolean; mode: 'standalone' | 'legacy'; sandboxWslDistribution?: string }
const defaults: Settings = { botDirectory: '', pythonPath: '', autoStart: false, mode: 'standalone' };
const PREFIX = '__MR_ROBOT_DISCORD__';
export function validateDiscordSettings(value: unknown): Settings {
  const v = value as Partial<Settings>;
  if (!v || typeof v.botDirectory !== 'string' || typeof v.pythonPath !== 'string'
    || !isAbsolute(v.botDirectory) || !isAbsolute(v.pythonPath)) throw new Error('봇 폴더와 Python 실행 파일의 절대 경로를 입력하세요.');
  const mode = v.mode ?? 'standalone';
  if (mode !== 'standalone' && mode !== 'legacy') throw new Error('지원하지 않는 Discord 실행 모드입니다.');
  if (!existsSync(join(v.botDirectory, 'config.json')) || !existsSync(v.pythonPath)) throw new Error('연결정보 config.json 또는 Python 실행 파일을 찾을 수 없습니다.');
  if (mode === 'legacy' && (!existsSync(join(v.botDirectory, 'bot', 'client.py')) || !existsSync(join(v.botDirectory, 'main.py')))) throw new Error('함께 실행 모드에는 기존 시큐리티봇 소스가 필요합니다. 독립 모드는 연결정보만 필요합니다.');
  if (v.sandboxWslDistribution && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.sandboxWslDistribution)) throw new Error('WSL 배포판 이름이 올바르지 않습니다.');
  return { botDirectory: resolve(v.botDirectory), pythonPath: resolve(v.pythonPath), autoStart: v.autoStart === true, mode, ...(v.sandboxWslDistribution ? { sandboxWslDistribution: v.sandboxWslDistribution } : {}) };
}

/** Outbound Discord gateway -> private stdio -> host-scoped loopback client. */
export function createDiscordPlugin(host: DiscordHost, runtime = { spawn }): MrRobotPlugin {
  let ctx: PluginContext;
  let threads: DiscordSessions;
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
  let workspace: { state: string; message: string } = { state: 'idle', message: '' };
  let grantToken = '';
  type Run = { conversation: string; isolated: boolean; cancelled?: boolean; attachmentsAbort?: AbortController; connection?: DiscordRunConnection; startedAt: number; lastProgress: number; preview: string; status?: string; heartbeat?: NodeJS.Timeout; approval?: { requestId: string; conversationId: string; summary?: string } };
  const runs = new Map<string, Run>();
  const results = new Map<string, unknown>();
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer?: NodeJS.Timeout }>();
  // Preserve an existing news/KTX installation until the owner selects standalone.
  const config = (): Settings => {
    const saved = ctx.storage.get<Settings>('config');
    return { ...defaults, ...saved, mode: saved ? saved.mode ?? 'legacy' : defaults.mode };
  };
  const status = () => ({ running: !!child, ready, owner, busy, activeCount: runs.size, capacity: 2, error: lastError, workspace, config: config() });
  const send = (data: unknown) => {
    if (child?.stdin.writable && child.stdin.writableLength < 1_000_000) child.stdin.write(JSON.stringify(data) + '\n');
  };
  const rpc = (method: string, params: unknown, timeout = 15_000): Promise<any> => new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) return reject(new Error('PC 에이전트 연결이 끊겼습니다.'));
    const id = ++serial;
    const timer = timeout > 0 ? ctx.setTimeout(() => { pending.delete(id); reject(new Error('PC 응답 시간이 초과되었습니다.')); }, timeout) : undefined;
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
    for (const p of pending.values()) { if (p.timer) ctx.clearTimeout(p.timer); p.reject(new Error('Discord 연결이 종료되었습니다.')); }
    pending.clear(); ready = false; busy = false; grantToken = '';
    for (const run of runs.values()) { run.attachmentsAbort?.abort(); run.connection?.close(); }
    runs.clear();
    if (workspace.state === 'pending') workspace = { state: 'error', message: '연결이 종료되어 티켓 설치를 중단했습니다. 다시 시도하세요.' };
    return status();
  };
  async function command(message: any): Promise<unknown> {
    const guilds = ctx.storage.get<string[]>('allowedGuildIds') ?? [];
    if (!ready) throw new Error('Discord 재연결 중입니다. 연결 복구 후 다시 요청하세요. 관리자 권한 문제는 아닙니다.');
    if (!guilds.includes(String(message.guildId))) throw new Error('등록된 Discord 서버에서만 사용할 수 있습니다. DM은 지원하지 않습니다.');
    if (message.guildAdmin !== true && message.allowAi !== true) throw new Error('allow_ai 역할 또는 서버 관리자 권한이 필요합니다.');
    if (![message.userId, message.channelId].every(id => /^\d{15,22}$/.test(String(id)))) throw new Error('Discord 사용자·티켓 정보가 올바르지 않습니다.');
    const channel = `${message.guildId}:${message.channelId}:${message.userId}`;
    const run = runs.get(channel);
    const activeChannel = run ? channel : '';
    const activeConversation = run?.conversation ?? '';
    const approval = run?.approval;
    const scopedRpc = (method: string, params: unknown) => run?.connection ? run.connection.call(method, params) : rpc(method, params);
    const userScope = `${message.guildId}:${message.userId}`;
    if (DISCORD_ADMIN_ACTIONS.has(message.action) && message.guildAdmin !== true) throw new Error('이 설정은 서버 관리자만 변경할 수 있습니다.');
    const accessPolicies = ctx.storage.get<Record<string, unknown>>('userAccess') ?? {};
    if (!accessPolicies || typeof accessPolicies !== 'object' || Array.isArray(accessPolicies)) throw new Error('사용자 권한 저장소가 손상되었습니다.');
    if (message.action === 'user-access') {
      if (!/^\d{15,22}$/.test(String(message.targetUserId))) throw new Error('대상 서버 사용자를 선택하세요.');
      const target = `${message.guildId}:${message.targetUserId}`;
      if (message.mode === 'show') return { message: `사용자 권한: ${Object.hasOwn(accessPolicies, target) ? parseDiscordAccess(accessPolicies[target]) : '기본값 (관리자: 전체 / 일반: 격리)'}` };
      if ([...runs.keys()].some(key => key.startsWith(`${message.guildId}:`) && key.endsWith(`:${message.targetUserId}`))) throw new Error('대상 사용자의 작업을 먼저 중지하세요.');
      if (message.mode !== 'default') parseDiscordAccess(message.mode);
      if (message.mode === 'full' && message.confirmFull !== true) throw new Error('전체 PC 권한을 위임하려면 confirm_full=True가 필요합니다.');
      if (!Object.hasOwn(accessPolicies, target) && Object.keys(accessPolicies).length >= 256) throw new Error('사용자 권한 저장소가 가득 찼습니다.');
      const next = { ...accessPolicies };
      if (message.mode === 'default') delete next[target]; else next[target] = message.mode;
      ctx.storage.set('userAccess', next);
      results.clear();
      return { message: `대상 사용자 권한을 ${message.mode}으로 저장했습니다. 이 서버의 모든 티켓에 적용됩니다. allow_ai 역할은 별도로 필요합니다.` };
    }
    const access = discordAccess(message.guildAdmin === true, accessPolicies, userScope);
    if (access === 'blocked') throw new Error('관리자가 이 사용자의 AI 이용을 중지했습니다.');
    const isolated = access !== 'full';
    const conversationKey = isolated ? `${channel}:isolated` : channel;
    const resultKey = `${conversationKey}:${access}`;
    const savedLimits = ctx.storage.get<Record<string, string>>('modelLimits');
    const limits = savedLimits === undefined ? {} : savedLimits;
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('모델 정책 저장소가 손상되었습니다. PC에서 복구하세요.');
    if (message.action === 'model-limit') {
      // Independently guarded on the host; slash visibility is not authorization.
      if (message.guildAdmin !== true) throw new Error('모델 제한 변경은 서버 관리자만 할 수 있습니다.');
      if (!/^\d{15,22}$/.test(String(message.targetUserId))) throw new Error('대상 서버 사용자를 선택하세요.');
      const target = `${message.guildId}:${message.targetUserId}`;
      if (message.ceiling === 'show') {
        const ceiling = parseDiscordModelCeiling(Object.hasOwn(limits, target) ? limits[target] : 'unlimited');
        return { modelCeiling: ceiling, message: `대상 사용자 모델 상한: ${ceiling} · 서버 내 모든 티켓에 적용` };
      }
      const ceiling = parseDiscordModelCeiling(message.ceiling);
      if ([...runs.keys()].some(key => key.startsWith(`${message.guildId}:`) && key.endsWith(`:${message.targetUserId}`))) throw new Error('대상 사용자의 실행을 먼저 중지하세요. 실행 도중에는 모델 상한을 변경할 수 없습니다.');
      if (ceiling !== 'unlimited' && Object.keys(limits).length >= 256 && !Object.hasOwn(limits, target)) throw new Error('모델 정책 저장소가 가득 찼습니다. 불필요한 제한을 해제하세요.');
      const next = { ...limits };
      if (ceiling === 'unlimited') delete next[target]; else next[target] = ceiling;
      ctx.storage.set('modelLimits', next);
      return { modelCeiling: ceiling, message: `대상 사용자 모델 상한을 ${ceiling === 'unlimited' ? '제한 없음' : ceiling + ' 이하'}으로 저장했습니다. 이 서버의 기존·새 티켓과 직접 명령에 적용됩니다. 제한 시 미분류 모델은 차단됩니다.` };
    }
    const modelCeiling = parseDiscordModelCeiling(Object.hasOwn(limits, userScope) ? limits[userScope] : 'unlimited');
    threads.assertOwner(message);
    if (message.action === 'thread.unbind' && [...runs.keys()].some(key => key.startsWith(`${message.guildId}:`))) throw new Error('서버에서 실행 중인 작업을 먼저 중지하세요.');
    const threadCommand = threads.command(message, activeChannel);
    if (threadCommand) {
      if (message.action === 'thread.forget') results.delete(resultKey);
      send({ event: 'thread.state', data: threads.state() });
      return threadCommand.result;
    }
    const permissions = ctx.storage.get<Record<string, PermissionMode>>('permissions') ?? {};
    const permission = isolated ? 'workspace' : permissions[channel] ?? 'full';
    if (message.action === 'file.read') {
      if (access === 'search' || (!isolated && permission !== 'full') || host.permissionCeiling() !== 'full') throw new Error('파일 전송 권한이 없습니다. 일반 사용자는 자기 격리 작업에서 만든 결과물만 받을 수 있습니다.');
      const conversationId = ctx.storage.get<Record<string, string>>('conversations')?.[conversationKey];
      if (!conversationId || !host.readChatFile) throw new Error('이 대화에서 먼저 파일을 찾아 달라고 요청하세요.');
      return host.readChatFile(conversationId, String(message.path ?? ''), Number(message.offset), Number(message.limit), typeof message.version === 'string' ? message.version : undefined, isolated);
    }
    const preferences = ctx.storage.get<Record<string, { providerId?: string; model?: string; effort?: string }>>('preferences') ?? {};
    const preference = preferences[channel] ?? {};
    if (message.action === 'settings') {
      if (busy && channel === activeChannel) throw new Error('작업을 중지한 후 설정을 바꾸세요.');
      if (Object.keys(preferences).length >= 64 && !preferences[channel]) throw new Error('설정 저장소가 가득 찼습니다.');
      if (!['auto', 'low', 'medium', 'high'].includes(message.effort)) throw new Error('추론은 auto/low/medium/high 중 선택하세요.');
      if (typeof message.model !== 'string' || message.model.length > 200 || typeof message.providerId !== 'string' || message.providerId.length > 200) throw new Error('모델/공급자 설정이 잘못되었습니다.');
      assertDiscordModelAllowed(modelCeiling, message.model);
      preferences[channel] = { providerId: message.providerId, model: message.model, effort: message.effort };
      ctx.storage.set('preferences', preferences);
      return { message: '이 대화의 모델·추론 설정을 저장했습니다.' };
    }
    if (message.action === 'models') {
      const providerId = typeof message.providerId === 'string' && message.providerId.length <= 200 ? message.providerId : undefined;
      const catalog = await host.models(providerId);
      if (!Array.isArray(catalog)) throw new Error('모델 목록 응답이 올바르지 않습니다.');
      if (providerId) return catalog.filter(model => discordModelAllowed(modelCeiling, model));
      // Keep providers discoverable even when their configured default is above the cap.
      return catalog.map(provider => ({ ...provider, model: discordModelAllowed(modelCeiling, provider.model) ? provider.model : '', modelCeiling }));
    }
    if (message.action === 'result') {
      if (results.has(resultKey)) return results.get(resultKey);
      if (busy && activeChannel === channel) return { message: '아직 작업 중입니다. 완료되면 요청한 메시지에 답변을 표시합니다.' };
      const id = ctx.storage.get<Record<string, string>>('conversations')?.[conversationKey];
      const saved = id ? await rpc('conversations.get', { id }) : null;
      const last = Array.isArray(saved?.messages) ? [...saved.messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) : undefined;
      return { message: last ? `마지막 저장된 답변입니다.\n\n${last.content.slice(0, 150_000)}` : '아직 저장된 답변이 없습니다. 이 채널에 작업을 입력해 주세요.' };
    }
    if (message.action === 'status') return { ready, busy: !!run, activeCount: runs.size, canStart: runs.size < 2 && ![...runs.values()].some(r => !r.isolated) && (isolated || runs.size === 0) && ![...runs.keys()].some(key => key.startsWith(`${message.guildId}:`) && key.endsWith(`:${message.userId}`)), preference, permission, access, modelCeiling, effectivePermission: host.permissionCeiling() === 'read-only' ? 'read-only' : permission, tokenPolicy: 'audit-only', message: `접근: ${isolated ? access === 'search' ? '인터넷 검색만 · PC 접근 불가' : '격리 작업 · 기존 PC 파일 접근 불가' : permission} · 모델: ${preference.model || 'PC 기본 모델'} · 모델 상한: ${modelCeiling} · 추론: ${preference.effort || 'auto'}` };
    if (message.action === 'access') {
      if (message.guildAdmin !== true) throw new Error('PC 접근 권한 변경은 서버 관리자만 할 수 있습니다.');
      if (busy && channel === activeChannel) throw new Error('작업 중에는 권한을 바꿀 수 없습니다. 먼저 /robot stop을 사용하세요.');
      if (!['read-only', 'ask', 'workspace', 'full'].includes(message.mode)) throw new Error('지원하지 않는 권한입니다.');
      if (message.mode === 'full' && message.confirmFull !== true) throw new Error('전체 PC 접근과 확인 없는 변경 실행을 허용하려면 confirm_full을 True로 선택하세요.');
      if (Object.keys(permissions).length >= 64 && !permissions[channel]) throw new Error('권한 저장소가 가득 찼습니다. PC에서 관리하세요.');
      permissions[channel] = message.mode; ctx.storage.set('permissions', permissions);
      return { permission: message.mode, message: `이 서버·채널의 본인 대화 권한을 ${message.mode}으로 저장했습니다. ${host.permissionCeiling() === 'read-only' ? '현재 PC 읽기 전용 잠금은 유지됩니다.' : message.mode === 'full' ? '전체 PC 접근·변경 작업을 별도 확인 없이 허용합니다.' : '다음 명령부터 적용됩니다.'}` };
    }
    if (message.action === 'approval') return channel === activeChannel ? approval ?? { message: '대기 중인 승인이 없습니다.' } : { message: '본인의 승인 요청이 없습니다.' };
    if (message.action === 'stop') {
      if (!busy || channel !== activeChannel) return { ok: false, message: '이 채널에서 실행 중인 작업이 없습니다.' };
      if (run) { run.cancelled = true; run.attachmentsAbort?.abort(); }
      if (!activeConversation) return { ok: true };
      return scopedRpc('chat.cancel', { conversationId: activeConversation });
    }
    if (message.action === 'approve') {
      if (channel !== activeChannel || !approval || approval.requestId !== message.requestId) throw new Error('만료되었거나 다른 작업의 승인 요청입니다.');
      const current = approval; if (run) run.approval = undefined;
      return scopedRpc('chat.confirmResponse', { ...current, approve: message.approve === true });
    }
    if (message.action === 'steer') {
      if (!run?.conversation || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 6000) throw new Error('실행 중인 본인 작업에 추가할 지시를 입력하세요.');
      await scopedRpc('chat.steer', { conversationId: run.conversation, text: message.text });
      return { message: '추가 지시를 전달했습니다. 현재 단계가 끝나는 안전한 지점에서 반영됩니다.' };
    }
    if (run) throw new Error('이 티켓에서 이미 작업 중입니다. 추가 지시 또는 대기열을 사용하세요.');
    const conversations = ctx.storage.get<Record<string, string>>('conversations') ?? {};
    if (message.action === 'new') {
      delete conversations[conversationKey]; ctx.storage.set('conversations', conversations);
      results.delete(resultKey);
      return { message: '다음 명령부터 새 대화를 시작합니다.' };
    }
    if (message.action !== 'ask' || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 6000) throw new Error('명령은 1~6000자로 입력하세요.');
    let attachmentContext = discordAttachmentContext(message.attachments);
    const sources = validateAttachmentSources(message.attachmentSources, String(message.channelId));
    if (runs.size >= 2 || [...runs.values()].some(r => !r.isolated) || (!isolated && runs.size > 0)
      || [...runs.keys()].some(key => key.startsWith(`${message.guildId}:`) && key.endsWith(`:${message.userId}`))) throw new Error('실행 슬롯이 사용 중입니다. 대기열에서 순서대로 실행합니다.');
    const commandGeneration = generation;
    results.delete(resultKey);
    const currentRun: Run = { conversation: '', isolated, startedAt: Date.now(), lastProgress: 0, preview: '' };
    runs.set(channel, currentRun); busy = true;
    const assertLive = () => { if (commandGeneration !== generation || !ready || currentRun.cancelled || runs.get(channel) !== currentRun) throw new Error('연결 변경 또는 작업 중지로 요청이 취소되었습니다.'); };
    currentRun.heartbeat = setInterval(() => {
      if (commandGeneration !== generation || currentRun.cancelled || runs.get(channel) !== currentRun || Date.now() - currentRun.lastProgress < 8000) return;
      currentRun.lastProgress = Date.now();
      send({ event: 'progress', scopeKey: channel, text: currentRun.preview || currentRun.status || '요청 준비 중', elapsed: Math.floor((Date.now() - currentRun.startedAt) / 1000) });
    }, 10_000);
    currentRun.heartbeat.unref();
    try {
      let providerId = message.providerId || preference.providerId;
      let model = message.model || preference.model;
      if (isolated) {
        const catalog = await host.models();
        if (!Array.isArray(catalog)) throw new Error('격리 작업용 모델 목록을 확인할 수 없습니다.');
        const selected = providerId ? catalog.find(p => p.providerId === providerId) : catalog.find(p => p.isDefault) ?? catalog[0];
        if (!selected) throw new Error('PC에 연결된 공급자가 없습니다. PC 앱에서 모델을 연결하세요.');
        providerId = selected.providerId; model ||= selected.model;
        assertDiscordModelAllowed(modelCeiling, model);
      }
      if (modelCeiling !== 'unlimited') {
        const catalog = await host.models();
        if (!Array.isArray(catalog)) throw new Error('모델 설정을 확인할 수 없습니다.');
        const provider = providerId ? catalog.find(p => p.providerId === providerId) : catalog.find(p => p.isDefault) ?? catalog[0];
        if (!provider) throw new Error('허용된 공급자·모델을 /robot model에서 선택하세요.');
        providerId = provider.providerId;
        model ||= provider.model;
        assertDiscordModelAllowed(modelCeiling, model);
        if (commandGeneration !== generation) throw new Error('Discord 연결이 변경되어 요청이 취소되었습니다.');
      }
      if (!conversations[conversationKey]) {
        assertLive();
        if (Object.keys(conversations).length >= 64) throw new Error('Discord 대화 채널 한도(64)에 도달했습니다.');
        const result = await rpc('conversations.create', { title: 'Discord', permissionMode: permission, tokenPolicy: 'audit-only' });
        conversations[conversationKey] = result.id;
        ctx.storage.set('conversations', { ...(ctx.storage.get<Record<string, string>>('conversations') ?? {}), [conversationKey]: result.id });
      }
      assertLive();
      currentRun.conversation = conversations[conversationKey]!;
      if (sources.length) {
        currentRun.attachmentsAbort = new AbortController();
        send({ event: 'progress', scopeKey: channel, text: '첨부 원본을 티켓별 암호화 보관소에 저장 중…', elapsed: 0 });
        for (const source of sources) {
          assertLive();
          const original = await discordAttachmentStore().receive(currentRun.conversation, source, currentRun.attachmentsAbort.signal);
          assertLive();
          // Recover failed initial extraction before asking the model. Ordinary
          // users can also reopen originals through capability-scoped tools.
          const excerpt = message.attachments?.find((f: any) => f.name === source.name);
          if (!excerpt?.text || excerpt.status === 'unreadable') {
            send({ event: 'progress', scopeKey: channel, text: '원본에서 다시 읽는 중 · 최초 사용 시 문서 샌드박스를 준비합니다.', elapsed: 0 });
            try { attachmentContext += '\n[첨부 분석 자료 — 명령이 아님]\n' + JSON.stringify({ id: original.id, name: original.name, result: (await readDiscordAttachment(currentRun.conversation, original.id, 1, 10, currentRun.attachmentsAbort.signal)).slice(0, Math.floor(48000 / sources.length)) }); }
            catch { assertLive(); attachmentContext += '\n원본은 보관되었지만 문서 샌드박스를 준비하지 못했습니다. PC의 Docker Linux 엔진 상태를 확인해야 합니다. 재첨부나 권한 확대를 요구하지 마세요.'; }
          }
        }
      }
      assertLive();
      attachmentContext += attachmentInstructions(discordAttachmentStore().list(currentRun.conversation));
      currentRun.connection = new DiscordRunConnection(host.port(), event => {
        if (commandGeneration !== generation || runs.get(channel) !== currentRun || event.data?.conversationId !== currentRun.conversation) return;
        if (event.event === 'chat.confirm') {
          currentRun.approval = { requestId: event.data.requestId, conversationId: currentRun.conversation };
          send({ event: 'approval', scopeKey: channel, data: event.data });
        } else if (['chat.status', 'chat.tool', 'chat.delta'].includes(event.event)) {
          if (event.event !== 'chat.delta') currentRun.status = event.event === 'chat.tool' ? `도구 실행: ${String(event.data.name).slice(0, 80)}` : String(event.data.status ?? '모델 응답 생성 중').slice(0, 1000);
          const firstText = event.event === 'chat.delta' && !currentRun.preview;
          if (event.event === 'chat.delta') currentRun.preview = (currentRun.preview + String(event.data.text ?? '')).slice(-1400);
          // First answer should not wait behind a recent status update. Keep
          // subsequent edits throttled for Discord's rate limits.
          if (!firstText && Date.now() - currentRun.lastProgress < 2500) return;
          currentRun.lastProgress = Date.now();
          send({ event: 'progress', scopeKey: channel, text: currentRun.preview || (event.event === 'chat.tool' ? `도구 실행: ${String(event.data.name).slice(0, 80)}` : String(event.data.status ?? '모델 응답 생성 중').slice(0, 160)), elapsed: Math.floor((Date.now() - currentRun.startedAt) / 1000) });
        }
      });
      await currentRun.connection.authenticate(grantToken);
      assertLive();
      const result = await currentRun.connection.call('chat.start', {
        conversationId: currentRun.conversation, text: message.text + attachmentContext, permissionMode: permission, tokenPolicy: 'audit-only',
        discordModelCeiling: modelCeiling,
        ...(isolated ? { discordIsolation: access } : {}),
        ...(providerId ? { providerId } : {}),
        ...(model ? { providerModel: model } : {}),
        reasoningEffort: ['auto', 'low', 'medium', 'high'].includes(message.effort) ? message.effort : preference.effort || 'auto',
      }, 0);
      const outcome = { ok: result?.ok !== false, artifactOnly: isolated, text: typeof result?.text === 'string' ? result.text.slice(0, 384_000) + (result.text.length > 384_000 ? '\n\n[전송 안전 한도를 초과했습니다. 나머지 내용을 별도 결과 파일로 요청하세요.]' : '') : '', ...(result?.error ? { error: String(result.error).slice(0, 1500) } : {}) };
      const files = outcome.ok && outcome.text ? chatFileLinks(outcome.text).slice(0, 3) : [];
      if (commandGeneration === generation) {
        results.delete(resultKey); results.set(resultKey, { ...outcome, files });
        if (results.size > 32) results.delete(results.keys().next().value!);
      }
      return { ...outcome, files };
    } catch (error) {
      if (commandGeneration === generation) results.set(resultKey, { ok: false, error: error instanceof Error ? error.message : '작업 전달에 실패했습니다.' });
      if (commandGeneration === generation && currentRun.conversation) await currentRun.connection?.call('chat.cancel', { conversationId: currentRun.conversation, reason: 'discord-transport' }).catch(() => {});
      throw error;
    } finally { clearInterval(currentRun.heartbeat); currentRun.attachmentsAbort?.abort(); currentRun.connection?.close(); if (runs.get(channel) === currentRun) runs.delete(channel); busy = runs.size > 0; }
  }
  async function start() {
    if (child || starting) return status();
    if (!host.enabled()) throw new Error('먼저 Discord 플러그인을 켜세요.');
    const settings = validateDiscordSettings(config());
    await closeDiscordSandboxes();
    configureDiscordSandboxEngine(settings.sandboxWslDistribution);
    if (!host.port()) throw new Error('PC 에이전트가 아직 시작 중입니다.');
    const runner = [
      join(dirname(fileURLToPath(import.meta.url)).replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'integrations', 'discordbot', 'bridge.py'),
      join(dirname(fileURLToPath(import.meta.url)), 'integrations', 'discordbot', 'bridge.py'),
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../..', 'integrations', 'discordbot', 'bridge.py'),
    ].find(existsSync);
    if (!runner) throw new Error('Discord 브리지 파일이 없습니다. 설치를 복구하세요.');
    lastError = ''; lastStart = Date.now(); starting = true; paused = false;
    const current = ++generation;
    let hasBeenReady = false;
    try {
      const grant = host.issue(); linkId = grant.id;
      grantToken = grant.token;
      ctx.storage.set('activeLinkId', grant.id);
      socket = new WebSocket(`ws://127.0.0.1:${host.port()}/ws`, 'mr-robot-rpc-v1', { handshakeTimeout: 10_000, maxPayload: 4_000_000 });
      socket.on('message', (raw) => {
        if (current !== generation) return;
        let message: any; try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.id !== undefined && message.id !== 0) {
          const p = pending.get(message.id); if (!p) return;
          pending.delete(message.id); if (p.timer) ctx.clearTimeout(p.timer);
          if (message.error) p.reject(new Error('PC 작업 실패: ' + String(message.error.message ?? message.error).slice(0, 600)));
          else p.resolve(message.result);
        }
      });
      socket.on('error', () => { lastError = 'PC 연결 오류'; stop(); });
      socket.on('close', () => { if (current === generation) { lastError = 'PC 연결이 종료되었습니다.'; stop(); } });
      await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); socket!.once('close', () => reject(new Error('PC 연결이 종료되었습니다.'))); });
      const auth = await rpc('auth', { secret: grant.token });
      if (!auth?.ok || auth.isAdmin || auth.permissionCap !== 'full' || !auth.canUseAuditOnly) throw new Error('Discord 전용 실행 권한을 확인하지 못했습니다.');
      if (current !== generation) throw new Error('시작이 취소되었습니다.');
      child = runtime.spawn(settings.pythonPath, ['-u', runner], { cwd: dirname(runner), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
      child.stdin.on('error', () => {});
      child.stderr.resume(); // Never persist bot credentials or arbitrary Python exception text.
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (current !== generation) return;
        buffer += chunk;
        if (buffer.length > 400_000) { lastError = 'Discord 브리지 출력 한도 초과'; stop(); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.startsWith(PREFIX)) continue;
          let message: any; try { message = JSON.parse(line.slice(PREFIX.length)); } catch { continue; }
          if (message.event === 'revoked') { const run = runs.get(message.scopeKey); if (run) { run.cancelled = true; run.attachmentsAbort?.abort(); void run.connection?.call('chat.cancel', { conversationId: run.conversation, reason: 'discord-authority' }).catch(() => {}); } continue; }
          if (message.event === 'workspace.ready' && workspace.state === 'pending') {
            if (!(ctx.storage.get<string[]>('allowedGuildIds') ?? []).includes(message.guildId) || ![message.channelId, message.panelId].every(id => typeof id === 'string' && /^\d{15,22}$/.test(id))) continue;
            const state = threads.state();
            if (state.bindings[message.guildId] && state.bindings[message.guildId] !== message.channelId) { workspace = { state: 'error', message: '다른 채널이 먼저 연결되었습니다. 기존 연결을 유지합니다.' }; continue; }
            state.bindings[message.guildId] = message.channelId;
            (state.panels ??= {})[message.channelId] = message.panelId;
            ctx.storage.set('threadState', state);
            send({ event: 'thread.state', data: state });
            workspace = { state: 'ready', message: message.pinned ? '티켓 채널·고정 패널 설치 완료' : '티켓 패널 설치 완료 · 고정 권한 없음' };
            continue;
          }
          if (message.event === 'workspace.error') { workspace = { state: 'error', message: String(message.message || '티켓 채널 설정 실패').slice(0, 500) }; continue; }
          if (message.event === 'ready' && /^\d{15,22}$/.test(String(message.owner))) {
            const guilds = Array.isArray(message.guilds) ? message.guilds.filter((id: unknown) => typeof id === 'string' && /^\d{15,22}$/.test(id)) : [];
            if (!ctx.storage.get<string[]>('allowedGuildIds')?.length && guilds.length === 1) ctx.storage.set('allowedGuildIds', guilds);
            owner = String(message.owner); ready = guilds.some((id: string) => ctx.storage.get<string[]>('allowedGuildIds')?.includes(id)); hasBeenReady ||= ready; continue;
          }
          if (message.event === 'disconnected') { ready = false; for (const run of runs.values()) { run.cancelled = true; run.attachmentsAbort?.abort(); void run.connection?.call('chat.cancel', { conversationId: run.conversation, reason: 'discord-disconnected' }).catch(() => {}); } continue; }
          if (message.event === 'error') {
            const safeErrors: Record<string, string> = { duplicate: '기존 시큐리티봇 또는 Discord 플러그인이 실행 중입니다. 먼저 종료하거나 함께 실행 모드를 사용하세요.', config: 'config.json의 bot_token 연결정보를 읽을 수 없습니다.', mode: 'Discord 실행 모드가 올바르지 않습니다.' };
            lastError = safeErrors[String(message.code)] ?? 'Discord 로그인/명령 등록 실패. 봇 토큰·서버 권한·Python 의존성을 확인하세요.';
            continue;
          }
          if (typeof message.id !== 'string' || message.id.length > 64) continue;
          void command(message).then((result) => { if (current === generation) send({ id: message.id, result }); }, (error) => {
            if (current === generation) send({ id: message.id, error: error instanceof Error ? error.message : '작업 실패' });
          });
        }
      });
      child.once('error', () => { if (current === generation) { lastError = 'Discord Python 실행 실패'; stop(); } });
      child.once('exit', () => { if (current === generation) { lastError ||= 'Discord 봇이 종료되었습니다. 중복 실행 여부를 확인하세요.'; stop(); } });
      send({ botDirectory: settings.botDirectory, mode: settings.mode, threadState: threads.state() });
      ctx.setTimeout(() => { if (current === generation && !hasBeenReady) { lastError = 'Discord 로그인 시간이 초과되었습니다. 봇 토큰과 네트워크를 확인하세요.'; stop(); } }, 45_000);
      return status();
    } catch (error) { stop(); throw error; }
    finally { starting = false; }
  }
  return {
    manifest: { id: 'discord-agent', name: 'Discord Agent', version: '1.7.0', kind: 'integration', enabledByDefault: false,
      description: 'allow_ai 개인 티켓 · 사용자별 격리·모델 제한 · 관리자 권한 관리 · 병렬 대기열·추가 지시·파일 지원.', permissions: ['network.client'] },
    activate(context) {
      ctx = context;
      threads = new DiscordSessions(ctx.storage);
      const stale = ctx.storage.get<string>('activeLinkId'); if (stale) host.revoke(stale);
      const opts = { adminOnly: true, destructive: false, tool: false };
      ctx.registerCommand('discord.status', () => status(), opts);
      ctx.registerCommand('discord.workspace.setup', (value: unknown) => {
        const channelName = String((value as any)?.channelName || 'ai_talk');
        if (!/^[a-z0-9_-]{1,80}$/.test(channelName)) throw new Error('채널 이름은 영문 소문자·숫자·밑줄·하이픈으로 입력하세요.');
        const guilds = ctx.storage.get<string[]>('allowedGuildIds') ?? [];
        const guildId = String((value as any)?.guildId ?? (guilds.length === 1 ? guilds[0] : ''));
        if (!ready || !guilds.includes(guildId)) throw new Error('연결된 등록 서버를 선택한 뒤 실행하세요.');
        if (workspace.state === 'pending') return status();
        workspace = { state: 'pending', message: '티켓 채널·패널 설치 중' };
        const request = workspace;
        ctx.setTimeout(() => { if (workspace === request) workspace = { state: 'error', message: '티켓 설치 응답 지연. 상태를 확인하고 다시 시도하세요.' }; }, 60_000);
        send({ event: 'workspace.setup', guildId, channelName });
        return status();
      }, { ...opts, destructive: true });
      ctx.registerCommand('discord.config.get', () => config(), opts);
      ctx.registerCommand('discord.config.set', (value) => { const settings = validateDiscordSettings(value); if (busy) throw new Error('작업을 중지한 뒤 연결 설정을 변경하세요.'); stop(); ctx.storage.set('config', settings); return settings; }, opts);
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
