import { useCallback, useEffect, useState } from 'react';
import type { CalendarEvent, ScheduledJobView, ScheduleJobType } from '@mr-robot/shared';
import { useMrRobot } from '../state';
import { Badge, Button, Card, Field, Input, Select, Toggle } from '../components/ui';

const TYPE_LABEL: Record<ScheduleJobType, string> = { chat: 'AI 작업', shell: '셸 명령', launch: '앱 실행' };
const TYPE_BADGE: Record<ScheduleJobType, 'accent' | 'default' | 'ok'> = { chat: 'accent', shell: 'default', launch: 'ok' };
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

function fmtWhen(job: ScheduledJobView): string {
  if (job.when.kind === 'once') {
    const d = new Date(job.when.at);
    if (Number.isNaN(d.getTime())) return '시간 형식 오류';
    return `일회성 · ${d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
  const days = job.when.days && job.when.days.length > 0 ? job.when.days : [0, 1, 2, 3, 4, 5, 6];
  const dayLabel = days.length === 7 ? '매일' : days.map((d) => DAY_NAMES[d]).join('·') + '요일';
  return `반복 · ${dayLabel} ${job.when.at}`;
}

function fmtNext(ts: number | null): string {
  if (ts === null) return '—';
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const rel =
    abs < 60_000
      ? diff >= 0
        ? '곧 실행'
        : '방금 전'
      : `${Math.round(abs / 3_600_000 * 10) / 10}시간 ${diff >= 0 ? '후' : '전'}`;
  return `${rel} (${new Date(ts).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })})`;
}

export function SchedulesView() {
  const { client } = useMrRobot();
  const [jobs, setJobs] = useState<ScheduledJobView[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [openResult, setOpenResult] = useState<string | null>(null);

  // form state
  const [type, setType] = useState<ScheduleJobType>('chat');
  const [name, setName] = useState('');
  const [whenKind, setWhenKind] = useState<'once' | 'daily'>('once');
  const [onceAt, setOnceAt] = useState('');
  const [dailyAt, setDailyAt] = useState('09:00');
  const [days, setDays] = useState<number[]>([]);
  const [prompt, setPrompt] = useState('');
  const [command, setCommand] = useState('');
  const [shellKind, setShellKind] = useState<'powershell' | 'cmd'>('powershell');
  const [target, setTarget] = useState('');
  const [args, setArgs] = useState('');
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarTitle, setCalendarTitle] = useState('');
  const [calendarStart, setCalendarStart] = useState('');
  const [calendarEnd, setCalendarEnd] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setJobs((await client.call('scheduler.list', {})) as ScheduledJobView[]);
      setCalendarEvents(await client.call('plugins.call', { name: 'calendar.events.list', params: {} }) as CalendarEvent[]);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [client]);

  const addCalendarEvent = async (): Promise<void> => {
    if (!calendarTitle.trim() || !calendarStart) return;
    setBusy(true); setError('');
    try {
      if (calendarEnd && new Date(calendarEnd).getTime() < new Date(calendarStart).getTime()) throw new Error('종료 시각은 시작 시각보다 빠를 수 없습니다.');
      await client.call('plugins.call', { name: 'calendar.events.add', params: { title: calendarTitle.trim(), startAt: calendarStart, endAt: calendarEnd || calendarStart, allDay: false } });
      setCalendarTitle(''); setCalendarStart(''); setCalendarEnd(''); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const removeCalendarEvent = async (id: string): Promise<void> => {
    try { await client.call('plugins.call', { name: 'calendar.events.remove', params: { id } }); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  useEffect(() => {
    void refresh();
    const off1 = client.on('scheduler.changed', (d) => setJobs(d as ScheduledJobView[]));
    const off2 = client.on('scheduler.ran', (d) => setJobs(d as ScheduledJobView[]));
    const tick = setInterval(() => setJobs((j) => [...j]), 30000); // refresh relative times
    return () => {
      off1();
      off2();
      clearInterval(tick);
    };
  }, [client, refresh]);

  const add = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const when =
        whenKind === 'once' ? { kind: 'once', at: onceAt } : { kind: 'daily', at: dailyAt, days };
      await client.call('scheduler.add', {
        name: name.trim() || TYPE_LABEL[type],
        type,
        prompt: type === 'chat' ? prompt.trim() : undefined,
        command: type === 'shell' ? command : undefined,
        shellKind,
        target: type === 'launch' ? target.trim() : undefined,
        args: type === 'launch' && args.trim() ? args.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        whenKind: when.kind,
        at: when.at,
        days,
        allowDestructive,
      });
      setShowAdd(false);
      setName('');
      setPrompt('');
      setCommand('');
      setTarget('');
      setArgs('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await client.call('scheduler.remove', { id });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    try {
      await client.call('scheduler.setEnabled', { id, enabled });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const toggleDay = (d: number): void => {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
  };

  const validJobPayload = type === 'chat' ? Boolean(prompt.trim()) : type === 'shell' ? Boolean(command.trim()) : Boolean(target.trim());
  const enabledJobs = jobs.filter((job) => job.enabled).length;
  const nextJob = jobs.filter((job) => job.nextRun !== null).sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity))[0];

  return (
    <div className="stack">
      <section className="automation-hero panel"><div><span className="eyebrow">LOCAL AUTOMATION</span><h2>일정과 에이전트 작업을 한곳에서</h2><p>로컬 캘린더는 토큰 없이 저장되고, 예약 작업은 정해진 시각에 선택한 PC에서 실행됩니다.</p></div><div className="automation-metrics"><span><b>{calendarEvents.length}</b> 일정</span><span><b>{enabledJobs}</b> 활성 작업</span><span><b>{nextJob ? fmtNext(nextJob.nextRun).split(' (')[0] : '없음'}</b> 다음 실행</span></div></section>
      {error && <div className="page-error"><span>!</span><div><b>작업을 완료하지 못했습니다.</b><small>{error}</small></div><button type="button" onClick={() => setError('')} aria-label="오류 닫기">×</button></div>}
      <Card className="panel calendar-panel">
        <div className="panel-head"><div><span className="eyebrow">CALENDAR PLUGIN</span><h3>일정</h3></div><Badge tone="ok">로컬 우선 · AI 토큰 0</Badge></div>
        <p className="panel-hint">일정은 PC에 저장되며 AI에게 “내일 오후 3시 약속 추가해줘”라고 말해도 같은 캘린더 플러그인을 사용합니다. Google OAuth는 별도 공급자로 연결할 수 있습니다.</p>
        <div className="form-grid calendar-add"><Field label="일정 이름"><Input value={calendarTitle} onChange={(event) => setCalendarTitle(event.target.value)} placeholder="예: 프로젝트 회의" /></Field><Field label="시작"><Input type="datetime-local" value={calendarStart} onChange={(event) => setCalendarStart(event.target.value)} /></Field><Field label="종료"><Input type="datetime-local" value={calendarEnd} onChange={(event) => setCalendarEnd(event.target.value)} /></Field><Button onClick={() => void addCalendarEvent()} disabled={busy || !calendarTitle.trim() || !calendarStart}>일정 추가</Button></div>
        <div className="calendar-list">{calendarEvents.length === 0 && <div className="muted">등록된 일정이 없습니다.</div>}{calendarEvents.map((event) => <article key={event.id} className="calendar-event"><div className="calendar-date"><b>{new Date(event.startAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}</b><span>{new Date(event.startAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span></div><div><b>{event.title}</b><small>{new Date(event.startAt).toLocaleString('ko-KR')} – {new Date(event.endAt).toLocaleString('ko-KR')}</small></div><Button variant="danger" onClick={() => void removeCalendarEvent(event.id)}>삭제</Button></article>)}</div>
      </Card>
      <Card className="panel">
        <div className="panel-head">
          <h3>예약 작업</h3>
          <Button variant="accent" onClick={() => setShowAdd((s) => !s)}>
            {showAdd ? '닫기' : '＋ 예약 추가'}
          </Button>
        </div>
        <p className="panel-hint">
          정해진 시간에 PC에서 자동 실행됩니다 (PC가 켜져 있으면 됩니다). AI 작업은 대화처럼 AI에게 시킬 일을 예약하는
          기능이에요.
        </p>

        {showAdd && (
          <div className="schedule-add">
            <div className="form-grid">
              <Field label="작업 종류">
                <Select value={type} onChange={(e) => setType(e.target.value as ScheduleJobType)}>
                  <option value="chat">AI 작업 (대화 보내기)</option>
                  <option value="shell">셸 명령</option>
                  <option value="launch">앱 실행</option>
                </Select>
              </Field>
              <Field label="이름">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 아침 브리핑" />
              </Field>
              <Field label="반복">
                <Select value={whenKind} onChange={(e) => setWhenKind(e.target.value as 'once' | 'daily')}>
                  <option value="once">일회성</option>
                  <option value="daily">반복 (매일/요일)</option>
                </Select>
              </Field>
              {whenKind === 'once' ? (
                <Field label="실행 시각">
                  <Input type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} />
                </Field>
              ) : (
                <Field label="실행 시각 (매일)">
                  <Input type="time" value={dailyAt} onChange={(e) => setDailyAt(e.target.value)} />
                </Field>
              )}
            </div>

            {whenKind === 'daily' && (
              <div className="day-picker">
                {DAY_NAMES.map((label, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`day-chip ${days.includes(i) ? 'on' : ''}`}
                    onClick={() => toggleDay(i)}
                  >
                    {label}
                  </button>
                ))}
                <span className="panel-hint">{days.length === 0 ? '아무것도 선택하지 않으면 매일 실행' : '선택한 요일에만 실행'}</span>
              </div>
            )}

            {type === 'chat' && (
              <Field label="AI에게 시킬 일" hint="예: '시스템 상태 요약해서 저장해줘' — 위험한 작업은 실행 전 승인이 필요해요">
                <textarea
                  className="chat-input"
                  rows={3}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="오전 9시 뉴스 헤드라인을 요약해 바탕화면에 저장해줘"
                />
              </Field>
            )}
            {type === 'shell' && (
              <div className="form-grid">
                <Field label="명령어">
                  <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Get-Process | Select-Object -First 10" />
                </Field>
                <Field label="셸">
                  <Select value={shellKind} onChange={(e) => setShellKind(e.target.value as 'powershell' | 'cmd')}>
                    <option value="powershell">PowerShell</option>
                    <option value="cmd">CMD</option>
                  </Select>
                </Field>
              </div>
            )}
            {type === 'launch' && (
              <div className="form-grid">
                <Field label="대상 (앱/파일/URL)">
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="notepad 또는 https://…" />
                </Field>
                <Field label="인자 (쉼표 구분, 선택)">
                  <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="C:\메모.txt" />
                </Field>
              </div>
            )}

            {type === 'chat' && (
              <Toggle
                checked={allowDestructive}
                onChange={setAllowDestructive}
                label="위험한 작업도 자동 승인 (예약 실행 시)"
              />
            )}

            <div className="chat-actions">
              <Button onClick={() => void add()} disabled={busy || !validJobPayload || (whenKind === 'once' && !onceAt)}>
                {busy ? '추가 중…' : '예약 추가'}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {jobs.length === 0 && (
        <Card className="panel empty">
          <p>예약된 작업이 없습니다.</p>
        </Card>
      )}

      {jobs.map((job) => (
        <Card key={job.id} className={`panel schedule-card ${!job.enabled ? 'off' : ''}`}>
          <div className="schedule-row">
            <div className="schedule-main">
              <div className="schedule-title">
                <Badge tone={TYPE_BADGE[job.type]}>{TYPE_LABEL[job.type]}</Badge>
                <span className="schedule-name">{job.name}</span>
                {!job.enabled && <Badge tone="warn">꺼짐</Badge>}
              </div>
              <div className="schedule-when">{fmtWhen(job)}</div>
              <div className="schedule-next">
                다음 실행: <b>{fmtNext(job.nextRun)}</b>
              </div>
              {job.lastRun && (
                <button className="schedule-lastrun" onClick={() => setOpenResult(openResult === job.id ? null : job.id)}>
                  마지막 실행 {new Date(job.lastRun).toLocaleString('ko-KR')} {openResult === job.id ? '▲' : '▼'}
                </button>
              )}
            </div>
            <div className="schedule-actions">
              <Toggle checked={job.enabled} onChange={(v) => void setEnabled(job.id, v)} />
              <Button variant="danger" onClick={() => void remove(job.id)}>
                삭제
              </Button>
            </div>
          </div>
          {openResult === job.id && <pre className="shell-out">{job.lastResult ?? '(결과 없음)'}</pre>}
        </Card>
      ))}
    </div>
  );
}
