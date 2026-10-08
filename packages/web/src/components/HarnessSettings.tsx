import { useEffect, useRef, useState } from 'react';
import type { MrRobotClient } from '../rpc';
import { Badge, Button, Card, Field, Input, Modal, Select } from './ui';
import './HarnessSettings.css';

type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
export interface HarnessSchema { type: JsonType; properties?: Record<string, HarnessSchema>; required?: string[]; additionalProperties?: boolean; items?: HarnessSchema; [key: string]: unknown }
export type HarnessVerifierProfile = { id: string; name: string; kind: 'json-artifact'; path: string; schema: HarnessSchema }
  | { id: string; name: string; kind: 'command'; command: { executable: string; args: string[] }; sourcePaths: string[]; timeoutMs?: number; allowFullHostExecution: boolean };
export interface HarnessConfig { documents: string[]; verifiers: HarnessVerifierProfile[]; permissionMode: string; capabilities: { workspaceCommand: boolean; fullHostCommand: boolean }; limits?: Record<string, unknown> }
export interface HarnessCandidate { id: string; claim: { subject: string; predicate: string; object: string }; evidence: Array<{ path: string; sha256: string; quote: string }>; status: 'candidate' | 'verified' | 'promoted' | 'retracted'; stale: boolean; conflictIds: string[]; retraction?: { reason: string } }
interface SearchResult { matches: Array<{ path: string; lineStart: number; lineEnd: number; snippet: string; sha256: string }>; issues: Array<{ path: string; code: string }>; partial: boolean; metrics: { read: number; cacheHits: number } }
interface Receipt { id: string; status: string; failure?: string; exitCode: number | null; execution: string; durationMs: number; stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean; sourceRevision?: string; artifactHash?: string }
interface Draft { id: string; name: string; kind: 'command' | 'json-artifact'; executable: string; args: string; sources: string; timeoutSec: number; allowFull: boolean; path: string; rootType: JsonType; itemType: JsonType; fields: Array<{ name: string; type: JsonType; required: boolean }>; preservedSchema?: HarnessSchema; editing?: boolean }
const TYPES: JsonType[] = ['string', 'number', 'integer', 'boolean', 'null'];
const LABEL: Record<string, string> = { passed: '통과', failed: '실패', rejected: '실행 거부', cancelled: '취소', 'timed-out': '시간 초과', candidate: '승인 대기', verified: '검증됨', promoted: '재사용 중', retracted: '철회됨' };
const lines = (value: string) => value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
const newDraft = (): Draft => ({ id: '', name: '', kind: 'json-artifact', executable: '', args: '', sources: '', timeoutSec: 30, allowFull: false, path: '', rootType: 'object', itemType: 'string', fields: [] });
function editDraft(profile: HarnessVerifierProfile): Draft {
  return profile.kind === 'command' ? { ...newDraft(), editing: true, id: profile.id, name: profile.name, kind: 'command', executable: profile.command.executable, args: profile.command.args.join('\n'), sources: profile.sourcePaths.join('\n'), timeoutSec: (profile.timeoutMs ?? 30_000) / 1000, allowFull: profile.allowFullHostExecution }
    : { ...newDraft(), editing: true, id: profile.id, name: profile.name, path: profile.path, rootType: profile.schema.type, preservedSchema: profile.schema };
}
export function harnessProfile(draft: Draft): HarnessVerifierProfile {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(draft.id)) throw new Error('검증 ID는 영문으로 시작하는 1~48자의 영문·숫자·_·-만 사용할 수 있습니다.');
  if (!draft.name.trim()) throw new Error('검증 이름을 입력하세요.');
  if (draft.kind === 'command') {
    if (!draft.executable.trim() || !lines(draft.sources).length) throw new Error('실행 파일과 검증 대상 소스 경로를 입력하세요.');
    if (!Number.isInteger(draft.timeoutSec) || draft.timeoutSec < 1 || draft.timeoutSec > 120) throw new Error('실행 제한은 1~120초입니다.');
    return { id: draft.id, name: draft.name.trim(), kind: 'command', command: { executable: draft.executable.trim(), args: draft.args === '' ? [] : draft.args.split(/\r?\n/) }, sourcePaths: lines(draft.sources), timeoutMs: draft.timeoutSec * 1000, allowFullHostExecution: draft.allowFull };
  }
  if (!draft.path.trim()) throw new Error('JSON 산출물의 상대 경로를 입력하세요.');
  let schema = draft.preservedSchema;
  if (!schema) {
    schema = { type: draft.rootType };
    if (draft.rootType === 'array') schema.items = { type: draft.itemType };
    if (draft.rootType === 'object') {
      const names = draft.fields.map(field => field.name.trim());
      if (names.some(name => !name) || new Set(names).size !== names.length) throw new Error('JSON 필드 이름은 비어 있거나 중복될 수 없습니다.');
      schema.properties = Object.fromEntries(draft.fields.map((field, i) => [names[i], { type: field.type }]));
      schema.required = draft.fields.filter(field => field.required).map(field => field.name.trim()); schema.additionalProperties = false;
    }
  }
  return { id: draft.id, name: draft.name.trim(), kind: 'json-artifact', path: draft.path.trim(), schema };
}
export function canRunHarnessProfile(profile: HarnessVerifierProfile, config: HarnessConfig): boolean {
  return profile.kind === 'json-artifact' || (config.permissionMode === 'full' && config.capabilities.fullHostCommand && profile.allowFullHostExecution)
    || (config.permissionMode === 'workspace' && config.capabilities.workspaceCommand);
}

export function SingleHarnessIndicator({ archivedName }: { archivedName?: string }) {
  return <div className="single-harness-indicator" data-testid="single-harness-runtime"><Badge tone="accent">단일 에이전트 하네스</Badge><span>선택한 모델이 문맥 조회 → 실행 → 검증까지 담당합니다. 다른 모델·보조 에이전트를 자동 호출하지 않습니다.</span>{archivedName && <small>이전 프리셋 ‘{archivedName}’은 보관만 하며 실행하지 않습니다.</small>}</div>;
}

export function HarnessSettings({ client }: { client: Pick<MrRobotClient, 'call' | 'isAdmin'> }) {
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]), [workspaceId, setWorkspaceId] = useState('');
  const [config, setConfig] = useState<HarnessConfig | null>(null), [documents, setDocuments] = useState(''), [candidates, setCandidates] = useState<HarnessCandidate[]>([]);
  const [query, setQuery] = useState(''), [search, setSearch] = useState<SearchResult | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<{ title: string; text: string; action: () => Promise<void> } | null>(null);
  const [retracting, setRetracting] = useState<HarnessCandidate | null>(null), [retractReason, setRetractReason] = useState('user-correction');
  const generation = useRef(0), locked = useRef(false);
  const disabled = busy || loading || !config;
  useEffect(() => {
    let current = true;
    if (!client.isAdmin) return;
    void client.call('projects.list', {}).then(value => { if (!current) return; const rows = value as Array<{ id: string; name: string }>; setWorkspaces(rows); setWorkspaceId(rows[0]?.id ?? ''); }).catch(cause => { if (current) setError(errorMessage(cause)); });
    return () => { current = false; };
  }, [client]);
  useEffect(() => {
    const epoch = ++generation.current; setConfig(null); setCandidates([]); setSearch(null); setReceipt(null); setDraft(null); setError(''); setNotice(''); setConfirmation(null); setRetracting(null);
    if (!workspaceId || !client.isAdmin) { setLoading(false); return; }
    setLoading(true);
    void Promise.all([client.call('harness.get', { workspaceId }), client.call('harness.candidates', { workspaceId })]).then(([data, items]) => {
      if (epoch !== generation.current) return; const next = data as HarnessConfig; setConfig(next); setDocuments(next.documents.join('\n')); setCandidates(items as HarnessCandidate[]);
    }).catch(cause => { if (epoch === generation.current) setError(errorMessage(cause)); }).finally(() => { if (epoch === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [client, workspaceId]);
  const perform = async (work: () => Promise<void>) => {
    if (locked.current || !client.isAdmin) return; const epoch = generation.current; locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (cause) { if (epoch === generation.current) setError(errorMessage(cause)); }
    finally { locked.current = false; if (epoch === generation.current) { setBusy(false); setConfirmation(null); setRetracting(null); } }
  };
  const save = async (patch: Partial<Pick<HarnessConfig, 'documents' | 'verifiers'>>) => {
    const next = await client.call('harness.update', { workspaceId, ...patch }) as HarnessConfig;
    setConfig(next); if (patch.documents) setDocuments(next.documents.join('\n')); setNotice('하네스 설정을 저장했습니다.');
  };
  const saveProfile = () => {
    if (!draft || !config) return;
    try {
      const profile = harnessProfile(draft);
      if (!draft.editing && config.verifiers.some(item => item.id === profile.id)) throw new Error('같은 검증 ID가 있습니다. 다른 ID를 사용하거나 기존 프로필의 수정을 선택하세요.');
      const action = async () => { await save({ verifiers: [...config.verifiers.filter(item => item.id !== profile.id), profile] }); setDraft(null); };
      if (profile.kind === 'command') setConfirmation({ title: '실행 가능한 검증을 등록할까요?', text: '이 프로필은 표시용 설명이 아니라 실제 명령입니다. 등록 후 에이전트와 이 화면에서 이름으로 호출할 수 있습니다. 전체 PC 실행을 허용하면 전체 권한 대화에서 매번 확인 없이 실행될 수 있습니다. 실행 파일·인수·소스 범위를 직접 확인하세요.', action });
      else void perform(action);
    } catch (cause) { setError(errorMessage(cause)); }
  };
  const refreshCandidates = async () => setCandidates(await client.call('harness.candidates', { workspaceId }) as HarnessCandidate[]);
  if (!client.isAdmin) return <Card className="panel"><p>프로젝트 하네스 설정과 지식 승인은 관리자 연결에서만 사용할 수 있습니다.</p></Card>;
  return <section className="harness-settings" aria-label="프로젝트 하네스 설정">
    <Card className="panel"><div className="panel-head"><div><h3>프로젝트 하네스</h3><p className="panel-hint">문서와 승인한 지식은 필요한 부분만 읽고, 완료 여부는 실제 검사 결과로 확인합니다.</p></div></div>
      <Field label="하네스 작업영역"><Select value={workspaceId} disabled={busy || !workspaces.length} onChange={event => setWorkspaceId(event.target.value)}><option value="">프로젝트 선택</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</Select></Field>
      {!workspaces.length && <p className="panel-hint">프로젝트를 먼저 등록하면 문서와 검증을 연결할 수 있습니다.</p>}
      {loading && <p role="status">작업영역 설정을 불러오는 중…</p>}{error && <p className="gate-error" role="alert">{error}</p>}{notice && <p role="status" className="harness-notice">{notice}</p>}
    </Card>
    {config && <>
      <Card className="panel"><div className="panel-head"><h3>명시적으로 선택한 문서</h3><Badge>{config.documents.length}개</Badge></div>
        <Field label="문서 상대 경로" hint="한 줄에 하나. 예: docs/architecture.md. txt·md·markdown·json만 지원하며 비밀·인증 파일은 등록하지 마세요."><textarea className="input harness-lines" rows={4} value={documents} disabled={disabled} onChange={event => setDocuments(event.target.value)} placeholder={'README.md\ndocs/architecture.md'} /></Field>
        <Button disabled={disabled} onClick={() => void perform(async () => { await save({ documents: lines(documents) }); setSearch(null); await refreshCandidates(); })}>문서 목록 저장</Button>
        <form className="harness-search" onSubmit={event => { event.preventDefault(); void perform(async () => { setSearch(await client.call('harness.search', { workspaceId, query }) as SearchResult); }); }}><Field label="등록 문서에서 검색"><Input value={query} maxLength={2000} disabled={disabled} onChange={event => setQuery(event.target.value)} placeholder="확인할 규칙·용어" /></Field><Button disabled={disabled || !query.trim()}>검색</Button></form>
        {search && <div className="harness-results" aria-live="polite"><p className="panel-hint">문서 {search.metrics.read}개 확인 · 캐시 {search.metrics.cacheHits}개{search.partial ? ' · 일부 결과만 표시' : ''}</p>{search.matches.length === 0 && <p>일치하는 근거가 없습니다. 없는 사실은 모름으로 유지합니다.</p>}{search.matches.map((match, i) => <article key={i}><b>{match.path}:{match.lineStart}–{match.lineEnd}</b><p>{match.snippet}</p><small>문서 근거 · 독립적으로 검증된 사실은 아님</small></article>)}{search.issues.map((issue, i) => <p key={i} className="gate-error">{issue.path}: {issue.code}</p>)}</div>}
      </Card>
      <Card className="panel"><div className="panel-head"><div><h3>근거를 확인하고 지식 승인</h3><p className="panel-hint">모델 제안은 자동으로 사실이 되지 않습니다. 출처와 내용을 확인한 뒤 재사용을 승인하거나 철회하세요.</p></div><Button variant="ghost" disabled={disabled} onClick={() => void perform(refreshCandidates)}>새로고침</Button></div>
        {!candidates.length && <p className="panel-hint">아직 제안된 지식이 없습니다.</p>}
        <div className="harness-candidates">{candidates.map(candidate => <article key={candidate.id} className="harness-candidate"><div className="harness-item-head"><b>{candidate.claim.subject} · {candidate.claim.predicate}</b><Badge tone={candidate.stale || candidate.conflictIds.length ? 'warn' : candidate.status === 'promoted' ? 'ok' : undefined}>{LABEL[candidate.status]}</Badge></div><p>{candidate.claim.object}</p>
          {candidate.stale && <p className="gate-error">출처가 변경되었거나 확인할 수 없어 승인할 수 없습니다. 새 근거가 필요합니다.</p>}{candidate.conflictIds.length > 0 && <p className="gate-error">다른 지식 {candidate.conflictIds.length}건과 충돌합니다. 최신이라는 이유만으로 고르지 마세요.</p>}
          <details><summary>출처와 인용 {candidate.evidence.length}개</summary>{candidate.evidence.map((evidence, i) => <div key={i} className="harness-evidence"><b>{evidence.path}</b><blockquote>{evidence.quote}</blockquote><small>SHA-256 {evidence.sha256.slice(0, 16)}…</small></div>)}</details>
          <div className="harness-actions">{(candidate.status === 'candidate' || candidate.status === 'verified') && <Button disabled={disabled || candidate.stale} onClick={() => setConfirmation({ title: '지식 재사용을 승인할까요?', text: '출처에 이 주장을 뒷받침하는 내용이 있는지 직접 확인했나요? 승인은 이 프로젝트에서만 적용하며 명령 실행 권한을 주지 않습니다.', action: async () => { await client.call('harness.approve', { workspaceId, candidateId: candidate.id, confirmation: 'user-confirmed' }); await refreshCandidates(); setNotice('지식 재사용을 승인했습니다.'); } })}>근거 확인 후 승인</Button>}{candidate.status !== 'retracted' && <Button variant="ghost" disabled={disabled} onClick={() => { setRetractReason('user-correction'); setRetracting(candidate); }}>철회</Button>}{candidate.retraction && <small>철회 사유: {candidate.retraction.reason}</small>}</div>
        </article>)}</div>
      </Card>
      <Card className="panel"><div className="panel-head"><div><h3>객관적 검증 프로필</h3><p className="panel-hint">파일 계약 또는 등록한 명령의 실제 결과를 기록합니다. 통과는 해당 검사만 의미하며 전체 작업의 정확성을 보증하지 않습니다.</p></div><Button disabled={disabled} onClick={() => setDraft(newDraft())}>검증 추가</Button></div>
        {!config.capabilities.workspaceCommand && <p className="harness-warning">작업영역 명령 샌드박스가 준비되지 않았습니다. 작업영역 권한에서는 명령을 실행하지 않습니다. JSON 파일 검사는 사용할 수 있습니다.</p>}
        <div className="harness-profiles">{config.verifiers.map(profile => <article key={profile.id}><div className="harness-item-head"><b>{profile.name}</b><Badge>{profile.kind === 'command' ? '명령 검증' : 'JSON 계약'}</Badge></div><p className="harness-path">{profile.kind === 'command' ? profile.command.executable : profile.path}</p>{profile.kind === 'command' && <small>{profile.sourcePaths.length}개 소스 · {(profile.timeoutMs ?? 30000) / 1000}초 · {profile.allowFullHostExecution ? '전체 권한 실행 승인됨' : '샌드박스 전용'}</small>}
          <div className="harness-actions"><Button variant="ghost" disabled={disabled} onClick={() => setDraft(editDraft(profile))}>수정</Button><Button disabled={disabled || !canRunHarnessProfile(profile, config)} onClick={() => setConfirmation({ title: profile.kind === 'command' ? '검증 명령을 실행할까요?' : '파일 계약을 검사할까요?', text: profile.kind === 'command' ? '등록한 실행 파일과 인수가 실제로 실행됩니다. 현재 PC 권한이 적용되고 파일이 변경될 수 있습니다.' : '선택한 프로젝트의 JSON 파일을 읽어 등록한 계약과 비교합니다. 모델 호출은 없습니다.', action: async () => { setReceipt(await client.call('harness.verify', { workspaceId, verifierId: profile.id }, 135_000) as Receipt); } })}>검증 실행</Button><Button variant="ghost" disabled={disabled} onClick={() => setConfirmation({ title: '검증 프로필을 삭제할까요?', text: '등록된 프로필만 제거합니다. 프로젝트 파일은 삭제하지 않습니다.', action: () => save({ verifiers: config.verifiers.filter(item => item.id !== profile.id) }) })}>삭제</Button></div>
          {!canRunHarnessProfile(profile, config) && <p className="panel-hint">현재 권한·샌드박스·명시적 승인 조건에서 실행할 수 없습니다.</p>}
        </article>)}</div>
        {receipt && <section className="harness-receipt" aria-label="최근 검증 결과" aria-live="polite"><div className="harness-item-head"><b>{receipt.id}</b><Badge tone={receipt.status === 'passed' ? 'ok' : 'warn'}>{LABEL[receipt.status] ?? receipt.status}</Badge></div><p>종료 코드 {receipt.exitCode ?? '없음'} · {(receipt.durationMs / 1000).toFixed(2)}초{receipt.failure ? ' · ' + receipt.failure : ''}</p><small>{receipt.execution === 'local-full-not-isolated' ? '전체 PC 실행 · OS 격리 아님' : receipt.execution === 'workspace-sandbox' ? '작업영역 샌드박스' : '파일만 검사'}</small>{(receipt.stdout || receipt.stderr) && <details><summary>제한된 검사 출력{receipt.stdoutTruncated || receipt.stderrTruncated ? ' · 일부 생략' : ''}</summary>{receipt.stdout && <pre>{receipt.stdout}</pre>}{receipt.stderr && <pre>{receipt.stderr}</pre>}</details>}</section>}
      </Card>
    </>}
    <Modal open={!!draft && !confirmation} onClose={() => { if (!busy) setDraft(null); }} title="검증 프로필" size="wide">{draft && <div className="harness-profile-form"><div className="form-grid"><Field label="검증 ID"><Input value={draft.id} disabled={busy || draft.editing} onChange={e => setDraft({ ...draft, id: e.target.value })} placeholder="unit_tests" /></Field><Field label="검증 이름"><Input value={draft.name} maxLength={120} disabled={busy} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="검증 방식"><Select value={draft.kind} disabled={busy} onChange={e => setDraft({ ...draft, kind: e.target.value as Draft['kind'] })}><option value="json-artifact">JSON 산출물 계약</option><option value="command">명시적인 테스트 명령</option></Select></Field></div>
      {draft.kind === 'command' ? <><p className="harness-warning">실제 명령을 실행하는 기능입니다. 패키지 스크립트를 자동 선택하지 않습니다. 실행 파일과 인수를 직접 검토하세요.</p><Field label="실행 파일 절대 경로"><Input value={draft.executable} disabled={busy} onChange={e => setDraft({ ...draft, executable: e.target.value })} placeholder="C:\\Program Files\\nodejs\\node.exe" /></Field><Field label="인수 · 한 줄에 하나" hint="따옴표로 감싸거나 쉘 명령 문자열을 넣지 마세요. 각 줄이 그대로 인수 하나입니다."><textarea className="input harness-lines" value={draft.args} disabled={busy} rows={3} onChange={e => setDraft({ ...draft, args: e.target.value })} placeholder={'--test\ntest/unit.test.mjs'} /></Field><Field label="검증 대상 소스 상대 경로" hint="한 줄에 하나. 실행 전후 이 파일들의 버전이 같아야 통과합니다."><textarea className="input harness-lines" value={draft.sources} disabled={busy} rows={3} onChange={e => setDraft({ ...draft, sources: e.target.value })} placeholder={'src/main.ts\ntest/unit.test.mjs'} /></Field><Field label="명령 제한 시간 (초)"><Input type="number" min={1} max={120} value={draft.timeoutSec} disabled={busy} onChange={e => setDraft({ ...draft, timeoutSec: Number(e.target.value) })} /></Field><label className="harness-check"><input type="checkbox" checked={draft.allowFull} disabled={busy} onChange={e => setDraft({ ...draft, allowFull: e.target.checked })} />전체 PC 권한 실행을 명시적으로 승인합니다 (샌드박스 격리 아님)</label></>
      : <><Field label="JSON 산출물 상대 경로"><Input value={draft.path} disabled={busy} onChange={e => setDraft({ ...draft, path: e.target.value })} placeholder="output/result.json" /></Field>{draft.preservedSchema ? <p className="panel-hint">저장된 {draft.preservedSchema.type} 계약의 조건을 그대로 보존합니다. 다른 계약은 새 프로필로 등록하세요.</p> : <><Field label="JSON 최상위 형식"><Select value={draft.rootType} disabled={busy} onChange={e => setDraft({ ...draft, rootType: e.target.value as JsonType })}>{['object', 'array', ...TYPES].map(type => <option key={type} value={type}>{type}</option>)}</Select></Field>{draft.rootType === 'array' && <Field label="배열 항목 형식"><Select value={draft.itemType} onChange={e => setDraft({ ...draft, itemType: e.target.value as JsonType })}>{TYPES.map(type => <option key={type}>{type}</option>)}</Select></Field>}{draft.rootType === 'object' && <div className="harness-fields"><p className="panel-hint">등록한 필드만 허용합니다. 객체 내부 값의 형식과 필수 여부를 선택하세요.</p>{draft.fields.map((field, i) => <div className="harness-field-row" key={i}><Input aria-label={'필드 이름 ' + (i + 1)} value={field.name} onChange={e => setDraft({ ...draft, fields: draft.fields.map((f, j) => j === i ? { ...f, name: e.target.value } : f) })} /><Select aria-label={'필드 형식 ' + (i + 1)} value={field.type} onChange={e => setDraft({ ...draft, fields: draft.fields.map((f, j) => j === i ? { ...f, type: e.target.value as JsonType } : f) })}>{TYPES.map(type => <option key={type}>{type}</option>)}</Select><label className="harness-check"><input type="checkbox" checked={field.required} onChange={e => setDraft({ ...draft, fields: draft.fields.map((f, j) => j === i ? { ...f, required: e.target.checked } : f) })} />필수</label><Button variant="ghost" aria-label={'필드 삭제 ' + (i + 1)} onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}>삭제</Button></div>)}<Button variant="ghost" disabled={draft.fields.length >= 32} onClick={() => setDraft({ ...draft, fields: [...draft.fields, { name: '', type: 'string', required: true }] })}>필드 추가</Button></div>}</>}</>}
      {error && <p role="alert" className="gate-error">{error}</p>}<div className="modal-actions"><Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>취소</Button><Button disabled={busy} onClick={saveProfile}>검증 프로필 저장</Button></div></div>}</Modal>
    <Modal open={!!confirmation} onClose={() => { if (!busy) setConfirmation(null); }} title={confirmation?.title}>{confirmation && <><p>{confirmation.text}</p><div className="modal-actions"><Button variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>취소</Button><Button disabled={busy} onClick={() => void perform(confirmation.action)}>{busy ? '처리 중…' : '확인하고 진행'}</Button></div></>}</Modal>
    <Modal open={!!retracting} onClose={() => { if (!busy) setRetracting(null); }} title="지식 재사용 철회"><Field label="철회 사유"><Select value={retractReason} disabled={busy} onChange={e => setRetractReason(e.target.value)}><option value="user-correction">사용자 정정</option><option value="failed-check">검증 실패</option><option value="stale-source">오래되거나 변경된 출처</option><option value="superseded">다른 지식으로 대체</option></Select></Field><div className="modal-actions"><Button variant="ghost" disabled={busy} onClick={() => setRetracting(null)}>취소</Button><Button variant="danger" disabled={busy || !retracting} onClick={() => void perform(async () => { await client.call('harness.retract', { workspaceId, candidateId: retracting!.id, reason: retractReason }); await refreshCandidates(); setNotice('지식 재사용을 철회했습니다.'); })}>재사용 철회</Button></div></Modal>
  </section>;
}
