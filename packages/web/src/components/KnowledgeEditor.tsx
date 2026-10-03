import { useEffect, useState } from 'react';
import { KNOWLEDGE_RELATIONS, type KnowledgeMetrics, type MemoryItem, type WorkspaceInfo } from '@mr-robot/shared';
import { useMrRobot } from '../state';
import { Button, Field, Input, Select } from './ui';

/** Explicit, inspectable facts. Never extracts private facts from chat automatically. */
export function KnowledgeEditor({ canWrite }: { canWrite: boolean }) {
  const { client } = useMrRobot();
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [subject, setSubject] = useState('');
  const [predicate, setPredicate] = useState('');
  const [object, setObject] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [relationChoice, setRelationChoice] = useState('custom');
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [replacesId, setReplacesId] = useState('');
  const [inspection, setInspection] = useState<{ metrics: KnowledgeMetrics; facts: { subject: string; predicate: string; object: string; rules: string[] }[]; conflicts: { kind: string; subject: string; predicate: string }[] }>();
  useEffect(() => { let alive = true; void client.call('workspaces.list', {}).then(value => { if (alive) setWorkspaces(value as WorkspaceInfo[]); }).catch(() => {}); return () => { alive = false; }; }, [client]);
  useEffect(() => { let alive = true; void client.call('memory.list', {}).then(value => { if (alive) setMemories(value as MemoryItem[]); }).catch(() => {}); const off = client.on('memory.changed', value => setMemories(value as MemoryItem[])); return () => { alive = false; off(); }; }, [client]);
  useEffect(() => { setReplacesId(''); setInspection(undefined); }, [workspaceId,subject,predicate]);
  const inspect = async () => {
    try { setInspection(await client.call('memory.inspect', { query: subject, workspaceId: workspaceId || undefined }) as NonNullable<typeof inspection>); }
    catch { setStatus('지식 검사를 불러오지 못했습니다.'); }
  };
  const save = async () => {
    if (saving || !canWrite) return;
    setSaving(true); setStatus('');
    try {
      await client.call('memory.add', { relation: { subject, predicate, object }, relationMode: 'fact', replacesId: replacesId || undefined, source: source.trim() || 'user-confirmed', workspaceId: workspaceId || undefined });
      setStatus(replacesId ? '선택한 사실을 수정했습니다. 이전 값은 이력에 남습니다.' : '사실을 추가했습니다. 다른 값과 충돌하면 자동 선택하지 않고 확인을 요청합니다.');
      setReplacesId('');
      setObject('');
      await inspect();
    } catch (error) { setStatus(error instanceof Error ? error.message : '기억을 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  };
  return <details className="panel" style={{ marginTop: 12 }}><summary>프로젝트 지식 · 온톨로지와 출처</summary>
    <p className="panel-hint">유형·소속·의존 관계를 연결하고 충돌을 검사합니다. 선택한 프로젝트의 package.json·workspace 패키지 선언은 작업할 때 자동으로 읽습니다. 패키지 이름으로 조회하면 저장한 지식과 함께 확인할 수 있습니다. 문서·비밀 파일은 자동 수집하지 않습니다. 추론은 선언에서 나온 결론일 뿐 실행 검증이나 접근 권한이 아닙니다.</p>
    <div className="form-grid">
      <Field label="사용 범위"><Select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}><option value="">개인 공통</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</Select></Field>
      <Field label="대상"><Input value={subject} maxLength={200} onChange={event => setSubject(event.target.value)} placeholder="프로젝트 A" /></Field>
      <Field label="관계 규칙"><Select value={relationChoice} onChange={event => { setRelationChoice(event.target.value); setPredicate(event.target.value === 'custom' ? '' : event.target.value); }}><option value="custom">사용자 정의</option>{KNOWLEDGE_RELATIONS.map(r => <option key={r.id} value={r.id}>{r.label} · {r.rule}</option>)}</Select></Field>
      {relationChoice === 'custom' && <Field label="속성"><Input value={predicate} maxLength={200} onChange={event => setPredicate(event.target.value)} placeholder="테스트 명령" /></Field>}
      <Field label="값"><Input value={object} maxLength={200} onChange={event => setObject(event.target.value)} placeholder="npm test" /></Field>
      <Field label="출처"><Input value={source} maxLength={500} onChange={event => setSource(event.target.value)} placeholder="직접 확인한 문서·근거" /></Field>
      <Field label="저장 방식"><Select value={replacesId} onChange={event => setReplacesId(event.target.value)}><option value="">별도 사실 추가 (기존 값 보존)</option>{memories.filter(m => !m.supersededBy && !m.conversationId && (m.workspaceId ?? '') === workspaceId && m.relation?.subject === subject.trim() && m.relation.predicate === predicate.trim()).map(m => <option key={m.id} value={m.id}>이 값 수정: {m.relation!.object}</option>)}</Select></Field>
    </div>
    <Button disabled={!canWrite || saving || !subject.trim() || !predicate.trim() || !object.trim()} onClick={() => void save()}>{saving ? '저장 중…' : '관계 저장 / 수정'}</Button>
    <Button disabled={saving || !subject.trim()} onClick={() => void inspect()}>관련 지식 검사</Button>
    {status && <p role="status" className="panel-hint">{status}</p>}
    {inspection && <div aria-live="polite"><p className="panel-hint">관련 사실 {inspection.metrics.asserted} · 추론 {inspection.metrics.inferred} · 미해결 충돌 {inspection.metrics.conflicts}{inspection.metrics.truncated ? ' · 일부만 조회됨' : ''}</p>
      {inspection.conflicts.map((c,i) => <p key={i} role="status">확인 필요: {c.subject} · {c.predicate} ({c.kind === 'single_value' ? '서로 다른 값' : c.kind === 'cycle' ? '순환 관계' : '동시 성립 불가 유형'})</p>)}
      {inspection.facts.slice(0,12).map((f,i) => <p key={i} className="panel-hint">{f.rules.length ? '추론: ' : '저장: '}{f.subject} → {KNOWLEDGE_RELATIONS.find(r => r.id === f.predicate)?.label ?? f.predicate} → {f.object}</p>)}
    </div>}
  </details>;
}
