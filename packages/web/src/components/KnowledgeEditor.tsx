import { useEffect, useState } from 'react';
import type { WorkspaceInfo } from '@mr-robot/shared';
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
  useEffect(() => { let alive = true; void client.call('workspaces.list', {}).then(value => { if (alive) setWorkspaces(value as WorkspaceInfo[]); }).catch(() => {}); return () => { alive = false; }; }, [client]);
  const save = async () => {
    if (saving || !canWrite) return;
    setSaving(true); setStatus('');
    try {
      await client.call('memory.add', { relation: { subject, predicate, object }, source: source.trim() || 'user-confirmed', workspaceId: workspaceId || undefined });
      setStatus('저장했습니다. 같은 범위의 대상·속성에 있던 이전 값은 대체 처리됩니다.');
      setObject('');
    } catch (error) { setStatus(error instanceof Error ? error.message : '기억을 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  };
  return <details className="panel" style={{ marginTop: 12 }}><summary>프로젝트 지식 · 관계와 출처 저장</summary>
    <p className="panel-hint">확인한 사실만 저장하세요. 예: 프로젝트 A → 테스트 명령 → npm test. 접근 권한을 부여하거나 외부 지시를 실행하는 기능이 아닙니다.</p>
    <div className="form-grid">
      <Field label="사용 범위"><Select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}><option value="">개인 공통</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</Select></Field>
      <Field label="대상"><Input value={subject} maxLength={200} onChange={event => setSubject(event.target.value)} placeholder="프로젝트 A" /></Field>
      <Field label="속성"><Input value={predicate} maxLength={200} onChange={event => setPredicate(event.target.value)} placeholder="테스트 명령" /></Field>
      <Field label="값"><Input value={object} maxLength={200} onChange={event => setObject(event.target.value)} placeholder="npm test" /></Field>
      <Field label="출처"><Input value={source} maxLength={500} onChange={event => setSource(event.target.value)} placeholder="직접 확인한 문서·근거" /></Field>
    </div>
    <Button disabled={!canWrite || saving || !subject.trim() || !predicate.trim() || !object.trim()} onClick={() => void save()}>{saving ? '저장 중…' : '관계 저장 / 수정'}</Button>
    {status && <p role="status" className="panel-hint">{status}</p>}
  </details>;
}
