import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionMode, ScheduledJob, ScheduledJobView } from '@mr-robot/shared';
import type { EventBus } from './eventbus.js';
import type { Logger } from './logger.js';
import type { ConfigStore } from './config.js';
import type { Computer } from './computer/index.js';
import type { AgentLoop } from './ai/loop.js';

function parseHm(at: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

export class SchedulerStore {
  private readonly file: string;

  constructor(config: ConfigStore) {
    this.file = join(config.dir, 'schedules.json');
  }

  load(): ScheduledJob[] {
    try {
      if (existsSync(this.file)) {
        const arr = JSON.parse(readFileSync(this.file, 'utf8')) as ScheduledJob[];
        return Array.isArray(arr) ? arr : [];
      }
    } catch {
      /* fresh start */
    }
    return [];
  }

  save(jobs: ScheduledJob[]): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(jobs, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}

/**
 * Persistent one-shot / daily / weekly scheduler. Runs on the PC even when
 * no client is connected. All timers are tracked and cleared on stop()/remove
 * — the same no-leak discipline as the plugin system.
 */
export class Scheduler {
  private jobs: ScheduledJob[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  private active = new Map<string, AbortController>();

  constructor(
    private readonly store: SchedulerStore,
    private readonly bus: EventBus,
    private readonly computer: Computer,
    private readonly loop: AgentLoop,
    private readonly logger: Logger,
    private readonly globalPermission: () => PermissionMode = () => 'read-only',
  ) {
    this.jobs = store.load();
  }

  list(): ScheduledJobView[] {
    return this.jobs.map((j) => ({ ...j, nextRun: this.nextRunAt(j) }));
  }

  nextRunAt(job: ScheduledJob): number | null {
    if (!job.enabled) return null;
    if (job.when.kind === 'once') {
      const t = new Date(job.when.at).getTime();
      return Number.isNaN(t) ? null : t;
    }
    const hm = parseHm(job.when.at);
    if (!hm) return null;
    const days = job.when.days && job.when.days.length > 0 ? job.when.days : [0, 1, 2, 3, 4, 5, 6];
    const now = Date.now();
    const next = new Date();
    next.setHours(hm.h, hm.m, 0, 0);
    let guard = 0;
    while ((next.getTime() <= now || !days.includes(next.getDay())) && guard < 400) {
      next.setDate(next.getDate() + 1);
      guard++;
    }
    return guard >= 400 ? null : next.getTime();
  }

  add(input: Omit<ScheduledJob, 'id' | 'createdAt' | 'enabled'>): ScheduledJobView {
    const job: ScheduledJob = {
      ...input,
      permissionMode: input.permissionMode ?? 'read-only',
      createdByAdmin: input.createdByAdmin === true,
      id: randomUUID(),
      createdAt: Date.now(),
      enabled: true,
    };
    this.jobs.push(job);
    this.store.save(this.jobs);
    this.arm(job);
    this.bus.emit('scheduler.changed', this.list());
    this.logger.info(`scheduled job added: ${job.name}`);
    return { ...job, nextRun: this.nextRunAt(job) };
  }

  remove(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.active.get(id)?.abort();
    this.active.delete(id);
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length !== before) {
      this.store.save(this.jobs);
      this.bus.emit('scheduler.changed', this.list());
      return true;
    }
    return false;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    job.enabled = enabled;
    if (!enabled) {
      this.active.get(id)?.abort();
      this.active.delete(id);
    }
    this.store.save(this.jobs);
    this.arm(job);
    this.bus.emit('scheduler.changed', this.list());
    return true;
  }

  start(): void {
    for (const job of this.jobs) this.arm(job);
    this.logger.info(`scheduler started (${this.jobs.length} jobs)`);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  private arm(job: ScheduledJob): void {
    const existing = this.timers.get(job.id);
    if (existing) clearTimeout(existing);
    this.timers.delete(job.id);
    const at = this.nextRunAt(job);
    if (at === null) return;
    const delay = Math.max(50, at - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      void this.run(job.id);
    }, delay);
    // Keep the process alive only via the server socket, not these timers.
    timer.unref?.();
    this.timers.set(job.id, timer);
  }

  private async run(id: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || !job.enabled) return;
    const previous = this.active.get(id);
    previous?.abort();
    const controller = new AbortController();
    this.active.set(id, controller);
    this.logger.info(`scheduled job starting: ${job.name}`);

    let result = '';
    try {
      if (job.type === 'shell') {
        if (job.createdByAdmin !== true || job.permissionMode !== 'full' || this.globalPermission() !== 'full') {
          throw new Error('차단됨: 이 셸 예약은 관리자 전체 허용 권한으로 생성되지 않았습니다. 다시 검토해 등록하세요.');
        }
        const res = await this.computer.shell(job.command ?? '', {
          shell: job.shellKind ?? 'powershell',
          timeoutMs: 120000,
          maxBytes: 20000,
          signal: controller.signal,
        });
        result = JSON.stringify({ ok: res.ok, exitCode: res.exitCode, stdout: res.stdout.slice(0, 800), stderr: res.stderr.slice(0, 400) });
      } else if (job.type === 'launch') {
        if (job.createdByAdmin !== true || job.permissionMode !== 'full' || this.globalPermission() !== 'full') {
          throw new Error('차단됨: 이 앱 실행 예약은 관리자 전체 허용 권한으로 생성되지 않았습니다. 다시 검토해 등록하세요.');
        }
        const res = await this.computer.app.launch(job.target ?? '', job.args ?? [], controller.signal);
        result = JSON.stringify({ ok: res.ok, exitCode: res.exitCode, stdout: res.stdout.slice(0, 300) });
      } else {
        // chat: run the prompt through the AI. Destructive tools auto-approved
        // only when the job is explicitly marked allowDestructive.
        const run = await this.loop.run([], job.prompt ?? '', {
          confirm: async () => job.createdByAdmin === true && job.permissionMode === 'full' && job.allowDestructive === true,
          onTool: () => undefined,
          signal: controller.signal,
        }, undefined, {
          permissionMode: permissionModes[Math.min(permissionModes.indexOf(job.permissionMode ?? 'read-only'), permissionModes.indexOf(this.globalPermission()))] ?? 'read-only',
        });
        result = run.text.slice(0, 800);
      }
    } catch (err) {
      result = `error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (this.active.get(id) === controller) this.active.delete(id);
    }

    const current = this.jobs.find((candidate) => candidate.id === id);
    if (!current) return;
    current.lastRun = Date.now();
    current.lastResult = result;
    if (current.when.kind === 'once') current.enabled = false;
    this.store.save(this.jobs);
    this.bus.emit('scheduler.ran', this.list());
    this.logger.info(`scheduled job finished: ${current.name}`);
    this.arm(current);
  }
}

const permissionModes: PermissionMode[] = ['read-only', 'ask', 'workspace', 'full'];
