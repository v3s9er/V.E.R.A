import { randomUUID } from 'node:crypto';
import type { CalendarEvent } from '@mr-robot/shared';
import type { MrRobotPlugin } from './loader.js';
import type { PluginContext } from './context.js';

function events(ctx: PluginContext): CalendarEvent[] {
  return ctx.storage.get<CalendarEvent[]>('events') ?? [];
}

function validDate(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!text || Number.isNaN(new Date(text).getTime())) throw new Error(`${label} 시간이 올바르지 않습니다.`);
  return text;
}

export function createCalendarPlugin(): MrRobotPlugin {
  return {
    manifest: {
      id: 'calendar', name: '캘린더', version: '0.2.0', kind: 'integration', enabledByDefault: true,
      description: '로컬 우선 일정 관리와 Google Calendar 연결 지점을 제공합니다.',
      capabilities: ['calendar.events.local', 'calendar.ics.export', 'calendar.google.oauth-ready'],
      permissions: ['calendar.read', 'calendar.write', 'network.client'],
      dependencies: [],
    },
    activate(ctx) {
      ctx.registerCommand('calendar.status', () => ({
        ok: true, provider: 'local', events: events(ctx).length,
        google: { configured: false, note: 'Google OAuth 클라이언트를 등록하면 교체 가능한 공급자로 연결됩니다.' },
      }), { destructive: false });
      ctx.registerCommand('calendar.events.list', (raw) => {
        const body = (raw ?? {}) as { from?: string; to?: string };
        const from = body.from ? new Date(body.from).getTime() : -Infinity;
        const to = body.to ? new Date(body.to).getTime() : Infinity;
        return events(ctx)
          .filter((item) => new Date(item.endAt).getTime() >= from && new Date(item.startAt).getTime() <= to)
          .sort((a, b) => a.startAt.localeCompare(b.startAt));
      }, {
        destructive: false, tool: true, description: '등록된 일정과 약속을 조회합니다.',
        toolWhen: (message) => /일정|약속|캘린더|스케줄|calendar|schedule|appointment/i.test(message),
        parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
      });
      ctx.registerCommand('calendar.events.add', (raw) => {
        const body = (raw ?? {}) as Partial<CalendarEvent>;
        const startAt = validDate(body.startAt, '시작');
        const endAt = validDate(body.endAt ?? body.startAt, '종료');
        if (new Date(endAt).getTime() < new Date(startAt).getTime()) throw new Error('종료 시간은 시작 시간보다 빠를 수 없습니다.');
        const now = Date.now();
        const item: CalendarEvent = {
          id: randomUUID(), title: String(body.title ?? '').trim().slice(0, 160) || '새 일정',
          description: body.description?.trim().slice(0, 4000), startAt, endAt,
          allDay: body.allDay === true, location: body.location?.trim().slice(0, 500), source: 'local', createdAt: now, updatedAt: now,
        };
        const next = [...events(ctx), item];
        ctx.storage.set('events', next);
        ctx.emit('calendar.changed', next);
        return item;
      }, {
        tool: true, destructive: true, description: '새 일정을 캘린더에 추가합니다.',
        toolWhen: (message) => /일정|약속|캘린더|스케줄|calendar|schedule|appointment/i.test(message),
        parameters: { type: 'object', properties: {
          title: { type: 'string' }, startAt: { type: 'string' }, endAt: { type: 'string' },
          allDay: { type: 'boolean' }, description: { type: 'string' }, location: { type: 'string' },
        }, required: ['title', 'startAt', 'endAt'] },
      });
      ctx.registerCommand('calendar.events.remove', (raw) => {
        const id = String((raw as { id?: string } | undefined)?.id ?? '');
        const current = events(ctx);
        const next = current.filter((item) => item.id !== id);
        if (next.length === current.length) throw new Error('일정을 찾을 수 없습니다.');
        ctx.storage.set('events', next);
        ctx.emit('calendar.changed', next);
        return { ok: true };
      }, {
        tool: true, destructive: true, description: '일정을 삭제합니다.',
        toolWhen: (message) => /일정|약속|캘린더|스케줄|calendar|schedule/i.test(message),
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      });
      ctx.registerCommand('calendar.ics.export', () => {
        const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mr.Robot//Calendar//KO'];
        for (const item of events(ctx)) {
          const format = (value: string) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
          lines.push('BEGIN:VEVENT', `UID:${item.id}@mr-robot.local`, `DTSTART:${format(item.startAt)}`, `DTEND:${format(item.endAt)}`, `SUMMARY:${item.title.replace(/[;,]/g, '\\$&')}`, 'END:VEVENT');
        }
        lines.push('END:VCALENDAR');
        return { filename: 'mr-robot-calendar.ics', content: lines.join('\r\n') };
      }, { destructive: false });
    },
  };
}
