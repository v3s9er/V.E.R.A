import { useEffect, useRef, useState } from 'react';
import type { ModelTuningCapabilities, ProviderInfo, ProviderTuningSettings } from '@mr-robot/shared';
import type { MrRobotClient } from '../rpc';
import { displayLatency, profileFromDraft, replaceTuningProfile, tuningDraft, type TuningDraft } from '../model-tuning-form';
import { Badge, Button, Card, Field, Input, Modal, Select } from './ui';
import { LocalTrainingSettings } from './LocalTrainingSettings';
import './ModelTuningSettings.css';

interface Distribution { samples: number; p50: number | null; p95: number | null }
export interface TuningPerformance {
  window: number; successes: number; cancelled: number; completionMs: Distribution; firstTextMs: Distribution;
  byModel: Array<{ model: string; samples: number; successes: number; completionMs: Distribution; firstTextMs: Distribution; averageTokens: number }>;
}
interface TuningResponse { settings: ProviderTuningSettings; capabilities: ModelTuningCapabilities; warning?: string }
const EFFORT_LABEL: Record<string, string> = { auto: '자동', none: '없음', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.';

export function ModelTuningSettings({ client, providers, nativeDesktopAdmin }: { client: MrRobotClient; providers: ProviderInfo[]; nativeDesktopAdmin: boolean }) {
  const [providerId, setProviderId] = useState('');
  const [data, setData] = useState<TuningResponse | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<TuningDraft | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [performance, setPerformance] = useState<TuningPerformance | null>(null);
  const [statsBusy, setStatsBusy] = useState(false), [statsError, setStatsError] = useState('');
  const epoch = useRef(0), statsEpoch = useRef(0), saveLock = useRef(false);
  const provider = providers.find(item => item.id === providerId);
  const original = data?.settings.profiles.find(item => item.id === selectedId);
  const dirty = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(tuningDraft(original, selectedId)));
  const creating = Boolean(draft && !original);
  const active = data?.settings.activeProfileId === selectedId;
  const blocked = busy || loading || !data;

  useEffect(() => {
    if (providers.some(item => item.id === providerId)) return;
    epoch.current += 1;
    setProviderId(providers.find(item => item.isDefault)?.id ?? providers[0]?.id ?? '');
  }, [providers, providerId]);

  const adopt = (next: TuningResponse, desired?: string) => {
    setData(next);
    const id = next.settings.profiles.some(item => item.id === desired) ? desired! : next.settings.activeProfileId ?? next.settings.profiles[0]?.id ?? '';
    setSelectedId(id); setDraft(id ? tuningDraft(next.settings.profiles.find(item => item.id === id)) : null);
  };

  const load = async () => {
    const generation = ++epoch.current;
    setLoading(true); setData(null); setDraft(null); setSelectedId(''); setBusy(false); saveLock.current = false;
    setError(''); setNotice(''); setDeleting(false);
    if (!providerId || !client.isAdmin) { setLoading(false); return; }
    try {
      const next = await client.call('providers.tuning.get', { id: providerId }) as TuningResponse;
      if (generation !== epoch.current) return;
      adopt(next);
    } catch (cause) { if (generation === epoch.current) setError(messageOf(cause)); }
    finally { if (generation === epoch.current) setLoading(false); }
  };

  useEffect(() => {
    void load();
    return () => { epoch.current += 1; };
  }, [client, providerId, provider?.model]);
  useEffect(() => () => { statsEpoch.current += 1; }, []);

  const refreshStats = async () => {
    if (!client.isAdmin) return;
    const generation = ++statsEpoch.current; setStatsBusy(true); setStatsError('');
    try {
      const summary = await client.call('telemetry.summary', {}) as { performance?: TuningPerformance };
      if (generation === statsEpoch.current) setPerformance(summary.performance ?? null);
    } catch (cause) { if (generation === statsEpoch.current) setStatsError(messageOf(cause)); }
    finally { if (generation === statsEpoch.current) setStatsBusy(false); }
  };
  useEffect(() => {
    setPerformance(null); setStatsError('');
    void refreshStats();
    return () => { statsEpoch.current += 1; };
  }, [client]);

  const persist = async (settings: ProviderTuningSettings, desired: string, message: string) => {
    if (!client.isAdmin || saveLock.current || blocked || !data) return;
    saveLock.current = true; setBusy(true); setError(''); setNotice('');
    const generation = epoch.current;
    try {
      const saved = await client.call('providers.tuning.set', { id: providerId, settings }) as ProviderTuningSettings;
      if (generation !== epoch.current) return;
      adopt({ ...data, settings: saved, warning: undefined }, desired); setNotice(message); setDeleting(false);
    } catch (cause) { if (generation === epoch.current) setError(messageOf(cause)); }
    finally { if (generation === epoch.current) { saveLock.current = false; setBusy(false); } }
  };
  const save = (activate: boolean) => {
    if (!draft || !data) return;
    try { void persist(replaceTuningProfile(data.settings, profileFromDraft(draft, data.capabilities), activate), draft.id, activate ? '저장하고 적용했습니다. 다음 단일 모델 요청부터 사용합니다.' : '프로필을 저장했습니다.'); }
    catch (cause) { setError(messageOf(cause)); }
  };
  const edit = (key: keyof TuningDraft, value: string) => { setDraft(current => current ? { ...current, [key]: value } : null); setNotice(''); setError(''); };
  const create = () => { const id = `tuning-${crypto.randomUUID()}`; setSelectedId(id); setDraft(tuningDraft(undefined, id)); setNotice('새 프로필입니다. 저장하기 전까지 적용되지 않습니다.'); setError(''); };

  if (!client.isAdmin) return null;
  return <div className="tuning-settings stack">
    <Card className="panel tuning-panel">
      <div className="panel-head"><div><h3>모델 튜닝</h3><p className="panel-hint">모델을 바꾸지 않고 추론·답변·보조 작업 방식을 조절합니다.</p></div><Badge tone={data?.settings.activeProfileId ? 'accent' : 'default'}>{data?.settings.activeProfileId ? '프로필 사용 중' : '기본값'}</Badge></div>
      <div className="tuning-top-grid"><Field label="공급자"><Select aria-label="튜닝 공급자" value={providerId} disabled={busy || dirty || creating} onChange={event => { epoch.current += 1; setProviderId(event.target.value); }}>
        {!providers.length && <option value="">먼저 모델을 연결하세요</option>}{providers.map(item => <option key={item.id} value={item.id}>{item.label} · {item.model}</option>)}
      </Select></Field><div className="tuning-profile-select"><Field label="프로필"><Select aria-label="튜닝 프로필" value={selectedId} disabled={blocked || dirty || creating} onChange={event => { setSelectedId(event.target.value); setDraft(tuningDraft(data?.settings.profiles.find(item => item.id === event.target.value))); setError(''); setNotice(''); }}>
        {!data?.settings.profiles.length && !creating && <option value="">저장된 프로필 없음</option>}{data?.settings.profiles.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === data.settings.activeProfileId ? ' · 적용 중' : ''}</option>)}{creating && <option value={selectedId}>새 프로필 · 저장 전</option>}
      </Select></Field><Button variant="ghost" onClick={create} disabled={blocked || dirty || creating || (data?.settings.profiles.length ?? 0) >= 16}>새 프로필</Button></div></div>
      {loading && <p className="tuning-hint" role="status">튜닝 설정을 불러오는 중…</p>}
      {error && <div className="tuning-message tuning-error" role="alert">{error}{!data && providerId && <Button variant="ghost" onClick={() => void load()} disabled={loading}>다시 불러오기</Button>}</div>}
      {notice && <div className="tuning-message" role="status">{notice}</div>}
      {data?.warning && <div className="tuning-message tuning-warning">{data.warning} 프로필을 수정하거나 기본값으로 돌아가세요.</div>}
      {data && draft && <fieldset className="tuning-form" disabled={busy}>
        <Field label="프로필 이름"><Input value={draft.name} maxLength={80} onChange={event => edit('name', event.target.value)} placeholder="예: 빠른 조사, 꼼꼼한 검증" /></Field>
        <div className="tuning-grid"><Field label="추론 단계"><Select value={draft.reasoningEffort} onChange={event => edit('reasoningEffort', event.target.value)}><option value="">기본값 유지</option>{data.capabilities.reasoningEfforts.map(value => <option key={value} value={value}>{EFFORT_LABEL[value] ?? value}</option>)}{draft.reasoningEffort && !data.capabilities.reasoningEfforts.includes(draft.reasoningEffort as any) && <option value={draft.reasoningEffort} disabled>{draft.reasoningEffort} · 지원 안 됨</option>}</Select></Field>
          <Field label="답변 길이"><Select value={draft.responseStyle} onChange={event => edit('responseStyle', event.target.value)}><option value="">기본값 유지</option><option value="default">기본</option><option value="concise">간결하게</option><option value="detailed">상세하게</option></Select></Field>
          <Field label="보조 작업"><Select value={draft.helperMode} onChange={event => edit('helperMode', event.target.value)}><option value="">기본값 유지</option><option value="auto">필요할 때 사용</option><option value="off">사용 안 함</option></Select></Field>
          <Field label="동시 보조 작업"><Select value={draft.maxParallelHelpers} onChange={event => edit('maxParallelHelpers', event.target.value)}><option value="">기본값 유지</option><option value="1">1개</option><option value="2">2개</option></Select></Field>
        </div>
        <details className="tuning-advanced"><summary>출력·문맥 고급 설정</summary><div className="tuning-grid">
          <Field label="최대 출력 토큰"><Input type="number" min={256} max={131072} step={1} disabled={!data.capabilities.maxOutputTokens} value={draft.maxOutputTokens} placeholder="기본값 유지" onChange={event => edit('maxOutputTokens', event.target.value)} />{!data.capabilities.maxOutputTokens && <small>구독 CLI에서는 강제할 수 없습니다.</small>}{draft.maxOutputTokens && <button type="button" className="tuning-clear" onClick={() => edit('maxOutputTokens', '')}>설정 지우기</button>}</Field>
          <Field label="Temperature"><Input type="number" min={data.capabilities.temperature.min} max={data.capabilities.temperature.max} step="0.1" disabled={!data.capabilities.temperature.supported || Boolean(data.capabilities.temperature.requiresReasoningNone && draft.reasoningEffort !== 'none')} value={draft.temperature} placeholder="기본값 유지" onChange={event => edit('temperature', event.target.value)} /><small>{!data.capabilities.temperature.supported ? '이 모델에서 지원이 확인되지 않았습니다.' : data.capabilities.temperature.requiresReasoningNone ? '추론 none을 선택한 경우에만 설정할 수 있습니다.' : '낮은 값일수록 출력 변화가 작아집니다.'}</small>{draft.temperature && <button type="button" className="tuning-clear" onClick={() => edit('temperature', '')}>설정 지우기</button>}</Field>
          <Field label="보조 문맥 한도"><Input type="number" min={2048} max={262144} step={1} value={draft.contextTokenLimit} placeholder="기본값 유지" onChange={event => edit('contextTokenLimit', event.target.value)} /><small>보조 문맥만 제한합니다. 원문 대화는 유지하고, 토큰 예산을 넘지 않도록 UTF-8 바이트로 보수 계산합니다.</small></Field>
        </div><p className="tuning-hint">빈 값은 기존 설정을 유지합니다. 출력·문맥 한도는 앱의 안전 한도나 질문 예산을 늘리지 않습니다.</p></details>
        <div className="tuning-actions"><div className="tuning-actions-main"><Button variant="accent" disabled={blocked || !draft.name.trim() || (!dirty && !creating && active)} onClick={() => save(true)}>저장하고 적용</Button><Button variant="ghost" disabled={blocked || !draft.name.trim() || (!dirty && !creating)} onClick={() => save(false)}>저장만</Button>{(dirty || creating) && <Button variant="ghost" onClick={() => { adopt(data, creating ? undefined : selectedId); setNotice('편집을 취소했습니다.'); setError(''); }}>편집 취소</Button>}</div><div className="tuning-actions-secondary">{active && <Badge tone="accent">현재 적용 중</Badge>}{original && <Button variant="danger" disabled={busy || dirty} onClick={() => setDeleting(true)}>프로필 삭제</Button>}</div></div>
      </fieldset>}
      {data && <div className="tuning-footnote"><p>단일 모델 실행에만 적용됩니다. 대화에서 직접 선택한 추론 단계가 우선하며, 시나리오·권한·질문 예산은 바뀌지 않습니다.</p>{data.settings.activeProfileId && <Button variant="ghost" disabled={blocked || dirty || creating} onClick={() => void persist({ profiles: data.settings.profiles }, selectedId, '프로필 적용을 해제하고 기본값으로 돌아갔습니다.')}>기본값 사용</Button>}</div>}
    </Card>

    <Card className="panel tuning-performance"><div className="panel-head"><div><h3>실제 실행 성능</h3><p className="panel-hint">측정한 실행만 표시합니다. 아래 값은 속도 향상을 보장하지 않습니다.</p></div><Button variant="ghost" disabled={statsBusy} onClick={() => void refreshStats()}>{statsBusy ? '불러오는 중…' : '측정값 새로고침'}</Button></div>
      {statsError && <p className="tuning-message tuning-error" role="alert">{statsError}</p>}
      {performance ? <><p className="tuning-hint">최근 {performance.window.toLocaleString()}회 · 성공 {performance.successes.toLocaleString()}회 · 취소 {performance.cancelled.toLocaleString()}회</p><div className="tuning-metrics"><div><span>첫 응답 · 중앙값</span><b>{displayLatency(performance.firstTextMs.p50)}</b><small>{performance.firstTextMs.samples}개 측정 · P95 {displayLatency(performance.firstTextMs.p95)}</small></div><div><span>완료 시간 · 중앙값</span><b>{displayLatency(performance.completionMs.p50)}</b><small>{performance.completionMs.samples}개 측정 · P95 {displayLatency(performance.completionMs.p95)}</small></div></div><details className="tuning-advanced"><summary>모델별 측정 보기 ({performance.byModel.length})</summary><div className="tuning-model-stats">{performance.byModel.map(row => <div key={row.model}><b>{row.model}</b><span>성공 {row.successes}/{row.samples}회 · 평균 {Math.round(row.averageTokens).toLocaleString()} 토큰</span><span>첫 응답 {displayLatency(row.firstTextMs.p50)} ({row.firstTextMs.samples}개) · 완료 {displayLatency(row.completionMs.p50)} ({row.completionMs.samples}개)</span></div>)}</div></details><p className="tuning-hint">시간 통계는 성공한 실행 기준입니다. 과거 기록에 첫 응답 측정이 없으면 제외합니다. 서로 다른 질문·모델·추론 수준의 결과를 직접적인 성능 비교로 해석하지 마세요.</p></> : !statsBusy && <p className="tuning-hint">아직 측정값이 없습니다. 작업 실행 후 새로고침하세요.</p>}
    </Card>
    {nativeDesktopAdmin && <LocalTrainingSettings client={client} />}
    <Modal open={deleting} title="튜닝 프로필 삭제" onClose={() => { if (!busy) setDeleting(false); }}><p>‘{original?.name}’ 프로필을 삭제할까요?{active ? ' 현재 적용 중인 프로필이므로 기본값으로 돌아갑니다.' : ''} 대화와 파일은 삭제하지 않습니다.</p><div className="tuning-actions"><Button variant="ghost" disabled={busy} onClick={() => setDeleting(false)}>취소</Button><Button variant="danger" disabled={busy} onClick={() => { if (!data) return; const next: ProviderTuningSettings = { profiles: data.settings.profiles.filter(item => item.id !== selectedId), ...(!active && data.settings.activeProfileId ? { activeProfileId: data.settings.activeProfileId } : {}) }; void persist(next, '', '프로필을 삭제했습니다.'); }}>삭제</Button></div></Modal>
  </div>;
}
