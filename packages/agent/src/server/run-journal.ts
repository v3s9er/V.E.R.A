import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Entry = { runId: string; conversationId: string; ownerLinkId?: string; phase: 'running' | 'uncertain' | 'completed' | 'failed' | 'cancelled'; at: number; toolPending: boolean };
/** Local metadata only. Never replay tools after process loss or persist prompts/credentials. */
export class RunJournal {
  private file: string;
  private entries: Entry[] = [];
  constructor(private directory: string) {
    this.file = join(directory, 'run-journal.json');
    try {
      const raw = readFileSync(this.file, 'utf8');
      if (raw.length > 256_000) return;
      const data: unknown = JSON.parse(raw);
      if (!Array.isArray(data)) return;
      this.entries = data.filter((entry): entry is Entry => !!entry && typeof entry === 'object'
        && typeof entry.runId === 'string' && entry.runId.length <= 128
        && typeof entry.conversationId === 'string' && entry.conversationId.length <= 128
        && (entry.ownerLinkId === undefined || typeof entry.ownerLinkId === 'string' && entry.ownerLinkId.length <= 128)
        && ['running', 'uncertain', 'completed', 'failed', 'cancelled'].includes(entry.phase)
        && Number.isFinite(entry.at) && typeof entry.toolPending === 'boolean')
        .slice(-128).map(entry => ({ runId: entry.runId, conversationId: entry.conversationId, ownerLinkId: entry.ownerLinkId,
          phase: entry.phase === 'running' ? 'uncertain' : entry.phase, at: entry.at, toolPending: entry.toolPending }));
    } catch { /* Missing/corrupt metadata must never trigger tool replay. */ }
  }
  begin(runId: string, conversationId: string, ownerLinkId?: string) {
    this.entries.push({ runId, conversationId, ownerLinkId, phase: 'running', at: Date.now(), toolPending: false });
    this.entries = this.entries.slice(-128); this.save();
  }
  tool(runId: string, pending: boolean) {
    const entry = this.entries.find(entry => entry.runId === runId);
    if (!entry || entry.phase !== 'running' || entry.toolPending === pending) return;
    entry.toolPending = pending; entry.at = Date.now(); this.save();
  }
  finish(runId: string, phase: 'completed' | 'failed' | 'cancelled') {
    const entry = this.entries.find(entry => entry.runId === runId); if (!entry) return;
    // A timeout/cancellation does not prove an in-flight external side effect failed.
    entry.phase = entry.toolPending ? 'uncertain' : phase;
    entry.at = Date.now(); this.save();
  }
  recovery(conversationId: string, ownerLinkId?: string, admin = false) {
    const entry = [...this.entries].reverse().find(entry => entry.conversationId === conversationId);
    if (!entry || entry.phase !== 'uncertain' || !admin && (!ownerLinkId || ownerLinkId !== entry.ownerLinkId)) return null;
    return { runId: entry.runId, at: entry.at, uncertainTool: entry.toolPending,
      message: '이전 실행의 완료 여부를 확인하지 못했습니다. 기존 결과와 실제 상태를 먼저 확인하고, 전송·삭제·결제 같은 작업은 확인 없이 반복하지 마세요.' };
  }
  private save() {
    mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(this.entries), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.file); }
    finally { try { unlinkSync(temporary); } catch { /* only this owned temporary file */ } }
  }
}
