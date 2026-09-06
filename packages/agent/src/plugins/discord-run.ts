import { WebSocket } from 'ws';

/** A distinct RPC session per job: cancellation/approval cannot overwrite a peer. */
export class DiscordRunConnection {
  private socket: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer?: NodeJS.Timeout }>();
  private opened: Promise<void>;
  constructor(port: number, private event: (message: any) => void) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, 'mr-robot-rpc-v1');
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('PC 작업 연결 시간이 초과되었습니다.')); this.close(); }, 8000);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', () => { clearTimeout(timer); reject(new Error('PC 작업 연결 실패')); });
      this.socket.once('close', () => { clearTimeout(timer); reject(new Error('PC 작업 연결 종료')); });
    });
    this.socket.on('message', raw => {
      let message: any; try { message = JSON.parse(raw.toString()); } catch { return; }
      const item = this.pending.get(message.id);
      if (item) {
        this.pending.delete(message.id); if (item.timer) clearTimeout(item.timer);
        if (message.error) item.reject(new Error(String(message.error.message ?? 'PC 작업 실패').slice(0, 1500)));
        else item.resolve(message.result);
      } else if (message.event) this.event(message);
    });
    this.socket.on('error', () => this.rejectAll());
    this.socket.on('close', () => this.rejectAll());
  }
  async authenticate(token: string) {
    await this.opened;
    const result = await this.call('auth', { secret: token });
    if (!result?.ok || result.isAdmin || result.permissionCap !== 'full' || !result.canUseAuditOnly) throw new Error('Discord 작업 권한 확인 실패');
  }
  call(method: string, params: unknown, timeout = 15000): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('PC 작업 연결이 끊겼습니다.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error('PC 응답 시간이 초과되었습니다.')); }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  private rejectAll() {
    for (const p of this.pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(new Error('PC 작업 연결이 종료되었습니다.')); }
    this.pending.clear();
  }
  close() { this.rejectAll(); this.socket.terminate(); }
}
