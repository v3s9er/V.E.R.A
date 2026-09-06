interface Storage { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }
export interface DiscordSession { guildId: string; parentId: string; ownerId: string; name: string; archived: boolean }
export interface DiscordThreadState { bindings: Record<string, string>; sessions: Record<string, DiscordSession>; panels?: Record<string, string> }
const snowflake = (v: unknown): v is string => typeof v === 'string' && /^\d{15,22}$/.test(v);

/** Private host state only. Discord-visible names/IDs are never source configuration. */
export class DiscordSessions {
  constructor(private storage: Storage) {}
  state(): DiscordThreadState { return this.storage.get<DiscordThreadState>('threadState') ?? { bindings: {}, sessions: {} }; }
  scope(m: any) { return `${m.guildId}:${m.channelId}:${m.userId}`; }
  assertOwner(m: any) {
    const s = this.state().sessions[m.channelId];
    if ((s || m.isThread === true) && (!s || s.ownerId !== m.userId || s.guildId !== m.guildId)) throw new Error('본인이 만든 개인 스레드에서만 사용할 수 있습니다.');
    if (s && ['ask', 'settings', 'access', 'new'].includes(m.action) && (s.archived || this.state().bindings[s.guildId] !== s.parentId)) throw new Error('보관되었거나 연결 해제된 스레드입니다. 내 대화 목록에서 다시 열어주세요.');
  }
  command(m: any, busyScope: string): { result: unknown } | undefined {
    if (!String(m.action).startsWith('thread.')) return undefined;
    const state = this.state();
    const scope = this.scope(m);
    const result = (value: unknown) => ({ result: value });
    const save = () => this.storage.set('threadState', state);
    if (m.action === 'thread.list') return result(Object.entries(state.sessions).filter(([, s]) => s.ownerId === m.userId && s.guildId === m.guildId).map(([id, s]) => ({ id, ...s })));
    if (m.action === 'thread.bind') {
      if (m.isThread === true) throw new Error('일반 텍스트 채널에서 연결하세요.');
      if (state.bindings[m.guildId] && state.bindings[m.guildId] !== m.channelId) throw new Error('이미 다른 채널이 연결되어 있습니다. 기존 채널에서 /robot unbind 후 연결하세요.');
      state.bindings[m.guildId] = m.channelId; save(); return result({ message: '이 채널에 개인 스레드 패널을 연결했습니다.' });
    }
    if (m.action === 'thread.unbind') {
      if (state.bindings[m.guildId] !== m.channelId) throw new Error('연결된 부모 채널에서 해제하세요.');
      if (busyScope.startsWith(`${m.guildId}:`)) throw new Error('실행 중인 작업을 먼저 중지하세요.');
      delete state.bindings[m.guildId]; save(); return result({ message: '연결을 해제했습니다. 기존 대화는 삭제하지 않았습니다.' });
    }
    if (m.action === 'thread.register') {
      if (m.allowAi !== true) throw new Error('티켓 발급에는 allow_ai 역할 확인이 필요합니다.');
      if (state.bindings[m.guildId] !== m.channelId || !snowflake(m.threadId) || m.threadId === m.channelId) throw new Error('연결된 채널의 새 스레드만 등록할 수 있습니다.');
      if (state.sessions[m.threadId]) throw new Error('이미 등록된 스레드입니다.');
      if (Object.keys(state.sessions).length >= 64 || Object.values(state.sessions).filter(s => s.ownerId === m.userId && s.guildId === m.guildId).length >= 20) throw new Error('대화 목록이 가득 찼습니다. 불필요한 스레드를 삭제하세요.');
      state.sessions[m.threadId] = { guildId: m.guildId, parentId: m.channelId, ownerId: m.userId, name: String(m.name || 'Mr.Robot').slice(0, 100), archived: false };
      save(); return result({ ok: true });
    }
    if (m.action === 'thread.panel') {
      if (state.bindings[m.guildId] !== m.channelId || !snowflake(m.panelId)) throw new Error('연결된 부모 채널의 패널만 저장할 수 있습니다.');
      (state.panels ??= {})[m.channelId] = m.panelId; save(); return result({ ok: true });
    }
    const s = state.sessions[m.channelId];
    if (!s || s.guildId !== m.guildId || s.ownerId !== m.userId) throw new Error('본인 스레드만 관리할 수 있습니다.');
    if (m.action === 'thread.get') {
      if (m.requireIdle && scope === busyScope) throw new Error('실행 중인 작업을 먼저 중지하세요.');
      return result(s);
    }
    if (scope === busyScope) throw new Error('실행 중인 작업을 먼저 중지하세요.');
    if (m.action === 'thread.archive') s.archived = true;
    else if (m.action === 'thread.reopen') {
      if (state.bindings[s.guildId] !== s.parentId) throw new Error('먼저 원래 부모 채널을 다시 연결하세요.');
      s.archived = false;
    } else if (m.action === 'thread.forget') {
      delete state.sessions[m.channelId];
      for (const key of ['conversations', 'permissions', 'preferences']) {
        const entries = this.storage.get<Record<string, unknown>>(key) ?? {};
        delete entries[scope]; this.storage.set(key, entries);
      }
    } else throw new Error('지원하지 않는 스레드 명령입니다.');
    save(); return result({ ok: true });
  }
}
