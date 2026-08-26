import { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { MrRobotClient } from '../rpc';
import type { CalendarEvent, ScheduledJobView } from '../types';
import { colors, radius } from '../theme';

const TYPE_LABEL: Record<string, string> = { chat: 'AI 작업', shell: '셸 명령', launch: '앱 실행' };
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

function fmtWhen(job: ScheduledJobView): string {
  if (job.when.kind === 'once') {
    return `일회성 · ${job.when.at}`;
  }
  const days = job.when.days && job.when.days.length > 0 ? job.when.days : [0, 1, 2, 3, 4, 5, 6];
  return `반복 · ${days.length === 7 ? '매일' : days.map((d) => DAY_NAMES[d]).join('·') + '요일'} ${job.when.at}`;
}

function fmtNext(ts: number | null): string {
  if (ts === null) return '—';
  const diff = ts - Date.now();
  const hours = Math.round((diff / 3_600_000) * 10) / 10;
  return `${hours >= 0 ? '' : '-'}${Math.abs(hours)}시간 ${diff >= 0 ? '후' : '전'}`;
}

export function SchedulesScreen({ client }: { client: MrRobotClient }) {
  const [jobs, setJobs] = useState<ScheduledJobView[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [openResult, setOpenResult] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [showCalendarAdd, setShowCalendarAdd] = useState(false);
  const [calendarTitle, setCalendarTitle] = useState('');
  const [calendarStart, setCalendarStart] = useState('');
  const [calendarEnd, setCalendarEnd] = useState('');

  // form
  const [type, setType] = useState<'chat' | 'shell' | 'launch'>('chat');
  const [name, setName] = useState('');
  const [whenKind, setWhenKind] = useState<'once' | 'daily'>('once');
  const [onceAt, setOnceAt] = useState('');
  const [dailyAt, setDailyAt] = useState('09:00');
  const [days, setDays] = useState<number[]>([]);
  const [prompt, setPrompt] = useState('');
  const [command, setCommand] = useState('');
  const [target, setTarget] = useState('');
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setJobs((await client.call('scheduler.list', {})) as ScheduledJobView[]);
      setCalendarEvents(await client.call('plugins.call', { name: 'calendar.events.list', params: {} }) as CalendarEvent[]);
    } catch {
      /* ignore */
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const off1 = client.on('scheduler.changed', (d) => setJobs(d as ScheduledJobView[]));
    const off2 = client.on('scheduler.ran', (d) => setJobs(d as ScheduledJobView[]));
    return () => {
      off1();
      off2();
    };
  }, [client, refresh]);

  const add = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await client.call('scheduler.add', {
        name: name.trim() || TYPE_LABEL[type],
        type,
        prompt: type === 'chat' ? prompt.trim() : undefined,
        command: type === 'shell' ? command : undefined,
        target: type === 'launch' ? target.trim() : undefined,
        whenKind,
        at: whenKind === 'once' ? onceAt : dailyAt,
        days,
        allowDestructive,
      });
      setShowAdd(false);
      setName('');
      setPrompt('');
      setCommand('');
      setTarget('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await client.call('scheduler.remove', { id });
    } catch {
      /* ignore */
    }
  };

  const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    try {
      await client.call('scheduler.setEnabled', { id, enabled });
    } catch {
      /* ignore */
    }
  };

  const toggleDay = (d: number): void => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));

  const addCalendar = async (): Promise<void> => {
    if (!calendarTitle.trim() || !calendarStart.trim()) return;
    setBusy(true); setError('');
    try {
      await client.call('plugins.call', { name: 'calendar.events.add', params: { title: calendarTitle.trim(), startAt: calendarStart.trim(), endAt: calendarEnd.trim() || calendarStart.trim(), allDay: false } });
      setShowCalendarAdd(false); setCalendarTitle(''); setCalendarStart(''); setCalendarEnd(''); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.calendarCard}><View style={styles.calendarHead}><View><Text style={styles.calendarEyebrow}>CALENDAR PLUGIN</Text><Text style={styles.calendarTitle}>일정</Text></View><TouchableOpacity style={styles.calendarAddBtn} onPress={() => setShowCalendarAdd(true)}><Text style={styles.calendarAddText}>＋ 일정</Text></TouchableOpacity></View><Text style={styles.subtle}>PC에 로컬 저장 · AI 토큰 0</Text>{calendarEvents.length === 0 ? <Text style={styles.subtle}>등록된 일정이 없습니다.</Text> : calendarEvents.slice(0, 8).map((event) => <View key={event.id} style={styles.calendarRow}><View style={{ flex: 1 }}><Text style={styles.jobName}>{event.title}</Text><Text style={styles.jobWhen}>{new Date(event.startAt).toLocaleString('ko-KR')}</Text></View><TouchableOpacity onPress={() => void client.call('plugins.call', { name: 'calendar.events.remove', params: { id: event.id } }).then(refresh)}><Text style={styles.deleteText}>삭제</Text></TouchableOpacity></View>)}</View>
        <TouchableOpacity style={styles.addBtn} onPress={() => setShowAdd(true)}>
          <Text style={styles.addText}>＋ 예약 추가</Text>
        </TouchableOpacity>

        {jobs.length === 0 && <Text style={styles.empty}>예약된 작업이 없습니다.</Text>}

        {jobs.map((job) => (
          <View key={job.id} style={[styles.card, !job.enabled && styles.cardOff]}>
            <View style={styles.cardHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.jobName}>
                  {TYPE_LABEL[job.type]} · {job.name}
                </Text>
                <Text style={styles.jobWhen}>{fmtWhen(job)}</Text>
                <Text style={styles.jobNext}>다음 실행: {fmtNext(job.nextRun)}</Text>
              </View>
              <Switch
                value={job.enabled}
                onValueChange={(v) => void setEnabled(job.id, v)}
                trackColor={{ true: colors.accent, false: colors.border }}
                thumbColor="#fff"
              />
            </View>
            {job.lastRun && (
              <TouchableOpacity onPress={() => setOpenResult(openResult === job.id ? null : job.id)}>
                <Text style={styles.lastRun}>
                  마지막 실행 {new Date(job.lastRun).toLocaleString('ko-KR')} {openResult === job.id ? '▲' : '▼'}
                </Text>
              </TouchableOpacity>
            )}
            {openResult === job.id && <Text style={styles.result}>{job.lastResult ?? '(결과 없음)'}</Text>}
            <TouchableOpacity style={styles.deleteBtn} onPress={() => void remove(job.id)}>
              <Text style={styles.deleteText}>삭제</Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>

      <Modal visible={showCalendarAdd} animationType="slide" transparent onRequestClose={() => setShowCalendarAdd(false)}><View style={styles.modalBackdrop}><View style={styles.modal}><Text style={styles.modalTitle}>일정 추가</Text><Text style={styles.label}>이름</Text><TextInput style={styles.input} value={calendarTitle} onChangeText={setCalendarTitle} placeholder="예: 프로젝트 회의" placeholderTextColor={colors.faint} /><Text style={styles.label}>시작 (YYYY-MM-DD HH:MM)</Text><TextInput style={styles.input} value={calendarStart} onChangeText={setCalendarStart} placeholder="2026-08-24 15:00" placeholderTextColor={colors.faint} /><Text style={styles.label}>종료</Text><TextInput style={styles.input} value={calendarEnd} onChangeText={setCalendarEnd} placeholder="2026-08-24 16:00" placeholderTextColor={colors.faint} />{error ? <Text style={styles.errorText}>{error}</Text> : null}<View style={styles.modalActions}><TouchableOpacity style={[styles.addBtn, { flex: 1, backgroundColor: colors.inputBg }]} onPress={() => setShowCalendarAdd(false)}><Text style={styles.addText}>취소</Text></TouchableOpacity><TouchableOpacity style={[styles.addBtn, { flex: 1 }]} onPress={() => void addCalendar()}><Text style={styles.addText}>추가</Text></TouchableOpacity></View></View></View></Modal>

      <Modal visible={showAdd} animationType="slide" transparent onRequestClose={() => setShowAdd(false)}>
        <View style={styles.modalBackdrop}>
          <ScrollView style={styles.modal} contentContainerStyle={{ gap: 8 }}>
            <Text style={styles.modalTitle}>예약 추가</Text>

            <View style={styles.chipRow}>
              {(['chat', 'shell', 'launch'] as const).map((t) => (
                <TouchableOpacity key={t} style={[styles.chip, type === t && styles.chipOn]} onPress={() => setType(t)}>
                  <Text style={[styles.chipText, type === t && styles.chipTextOn]}>{TYPE_LABEL[t]}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>이름</Text>
            <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="예: 아침 브리핑" placeholderTextColor={colors.faint} />

            <View style={styles.chipRow}>
              {(['once', 'daily'] as const).map((k) => (
                <TouchableOpacity key={k} style={[styles.chip, whenKind === k && styles.chipOn]} onPress={() => setWhenKind(k)}>
                  <Text style={[styles.chipText, whenKind === k && styles.chipTextOn]}>{k === 'once' ? '일회성' : '반복'}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {whenKind === 'once' ? (
              <>
                <Text style={styles.label}>실행 시각 (YYYY-MM-DD HH:MM)</Text>
                <TextInput style={styles.input} value={onceAt} onChangeText={setOnceAt} placeholder="2025-06-01 09:00" placeholderTextColor={colors.faint} />
              </>
            ) : (
              <>
                <Text style={styles.label}>실행 시각 (HH:MM)</Text>
                <TextInput style={styles.input} value={dailyAt} onChangeText={setDailyAt} placeholder="09:00" placeholderTextColor={colors.faint} />
                <View style={styles.chipRow}>
                  {DAY_NAMES.map((label, i) => (
                    <TouchableOpacity key={i} style={[styles.dayChip, days.includes(i) && styles.chipOn]} onPress={() => toggleDay(i)}>
                      <Text style={[styles.chipText, days.includes(i) && styles.chipTextOn]}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.hint}>요일을 선택하지 않으면 매일 실행</Text>
              </>
            )}

            {type === 'chat' && (
              <>
                <Text style={styles.label}>AI에게 시킬 일</Text>
                <TextInput
                  style={[styles.input, { minHeight: 70 }]}
                  value={prompt}
                  onChangeText={setPrompt}
                  placeholder="오전 9시 뉴스 요약해서 바탕화면에 저장해줘"
                  placeholderTextColor={colors.faint}
                  multiline
                />
                <View style={styles.switchRow}>
                  <Text style={styles.label}>위험한 작업 자동 승인</Text>
                  <Switch
                    value={allowDestructive}
                    onValueChange={setAllowDestructive}
                    trackColor={{ true: colors.accent, false: colors.border }}
                    thumbColor="#fff"
                  />
                </View>
              </>
            )}
            {type === 'shell' && (
              <>
                <Text style={styles.label}>명령어</Text>
                <TextInput style={styles.input} value={command} onChangeText={setCommand} placeholder="Get-Process | Select-Object -First 10" placeholderTextColor={colors.faint} autoCapitalize="none" />
              </>
            )}
            {type === 'launch' && (
              <>
                <Text style={styles.label}>앱/파일/URL</Text>
                <TextInput style={styles.input} value={target} onChangeText={setTarget} placeholder="notepad 또는 https://…" placeholderTextColor={colors.faint} autoCapitalize="none" />
              </>
            )}

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.addBtn, { flex: 1, backgroundColor: colors.inputBg }]} onPress={() => setShowAdd(false)}>
                <Text style={styles.addText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.addBtn, { flex: 1 }, (busy || (whenKind === 'once' && !onceAt.trim())) && { opacity: 0.5 }]}
                onPress={() => void add()}
                disabled={busy || (whenKind === 'once' && !onceAt.trim())}
              >
                <Text style={styles.addText}>{busy ? '추가 중…' : '예약 추가'}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 14, gap: 12, paddingBottom: 30 },
  calendarCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: 'rgba(124,92,255,.45)', borderRadius: radius.md, padding: 14, gap: 8 },
  calendarHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  calendarEyebrow: { color: colors.accent2, fontSize: 9.5, fontWeight: '800', letterSpacing: 1.2 },
  calendarTitle: { color: colors.text, fontSize: 19, fontWeight: '800', marginTop: 2 },
  calendarAddBtn: { backgroundColor: 'rgba(124,92,255,.22)', borderWidth: 1, borderColor: colors.accent, borderRadius: radius.sm, paddingHorizontal: 11, paddingVertical: 7 },
  calendarAddText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  calendarRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border },
  subtle: { color: colors.faint, fontSize: 11.5 },
  addBtn: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center' },
  addText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  empty: { color: colors.faint, textAlign: 'center', marginTop: 30 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, gap: 8 },
  cardOff: { opacity: 0.6 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  jobName: { color: colors.text, fontWeight: '700', fontSize: 14.5 },
  jobWhen: { color: colors.dim, fontSize: 12.5, marginTop: 2 },
  jobNext: { color: colors.faint, fontSize: 12, marginTop: 2 },
  lastRun: { color: colors.faint, fontSize: 12 },
  result: { color: '#b9e8b0', fontSize: 11.5, lineHeight: 17, backgroundColor: colors.inputBg, borderRadius: radius.sm, padding: 8 },
  deleteBtn: { alignSelf: 'flex-start', backgroundColor: 'rgba(248,113,113,0.15)', borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 7 },
  deleteText: { color: colors.err, fontWeight: '700', fontSize: 12.5 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(4,6,12,0.7)', justifyContent: 'flex-end' },
  modal: { backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 20, maxHeight: '92%' },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 6 },
  label: { color: colors.dim, fontSize: 13, fontWeight: '600', marginTop: 6 },
  hint: { color: colors.faint, fontSize: 11.5 },
  input: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: 13,
    paddingVertical: 10,
    fontSize: 14,
  },
  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.inputBg },
  chipOn: { backgroundColor: 'rgba(124,92,255,0.3)', borderColor: colors.accent },
  chipText: { color: colors.dim, fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: '#fff' },
  dayChip: { width: 40, height: 38, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inputBg, alignItems: 'center', justifyContent: 'center' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  errorText: { color: colors.err, fontSize: 13 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
});
