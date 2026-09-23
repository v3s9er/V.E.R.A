import { useEffect, useRef, useState } from 'react';
import type { MrRobotClient } from '../rpc';
import { Button, Card, Field, Input } from './ui';
import './LocalTrainingSettings.css';

interface Validation {
  valid: boolean; inputRows: number; uniqueRows: number; duplicateRows: number; trainRows: number; evalRows: number;
  credentialRisks: number; piiRisks: number; issues: Array<{ row?: number; severity: string; code: string; message: string }>;
}
interface Dataset { id: string; name: string; createdAt: number; counts: { trainRows: number; evalRows: number; uniqueRows: number } }
interface Exported { directory: string; manifestPath: string }
/** Local-only import is explicit. Existing conversations are never collected. */
export function LocalTrainingSettings({ client }: { client: MrRobotClient }) {
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [filename, setFilename] = useState('');
  const [validation, setValidation] = useState<Validation | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [rights, setRights] = useState(false);
  const [pii, setPii] = useState(false);
  const [exported, setExported] = useState<Exported | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    const current = ++epoch.current;
    setSource(''); setName(''); setFilename(''); setValidation(null); setDatasets([]);
    setRights(false); setPii(false); setExported(null); setBusy(false); setMessage('');
    void client.call('tuning.datasets.list', {}).then(value => { if (epoch.current === current) setDatasets(value as Dataset[]); })
      .catch(error => { if (epoch.current === current) setMessage(error instanceof Error ? error.message : '목록을 불러오지 못했습니다.'); });
    return () => { epoch.current++; };
  }, [client]);
  const selectFile = async (file?: File) => {
    const current = ++epoch.current;
    setSource(''); setValidation(null); setRights(false); setPii(false); setExported(null); setMessage('');
    setFilename(file?.name ?? ''); setName(file?.name.replace(/\.jsonl$/i, '').slice(0, 80) ?? '');
    if (!file) return;
    // JSON escaping must remain below the existing 2 MiB WS envelope.
    if (file.size > 256 * 1024) { setMessage('화면 가져오기는 256KB 이하 JSONL 파일을 선택하세요. 큰 자료는 독립된 주제별로 나눠 가져오세요.'); return; }
    setBusy(true);
    try {
      const text = await file.text();
      if (epoch.current !== current) return;
      const result = await client.call('tuning.datasets.validate', { jsonl: text }) as Validation;
      if (epoch.current !== current) return;
      setValidation(result); setSource(text);
      setMessage(result.valid ? '검증 완료. 학습 자료와 별도 평가 자료로 나눠 저장할 수 있습니다.' : '검증 항목을 수정한 뒤 파일을 다시 선택하세요.');
    } catch (error) { if (epoch.current === current) setMessage(error instanceof Error ? error.message : '파일 검증에 실패했습니다.'); }
    finally { if (epoch.current === current) setBusy(false); }
  };
  const save = async () => {
    if (busy || !validation?.valid || !rights || (validation.piiRisks > 0 && !pii)) return;
    const current = epoch.current; setBusy(true); setMessage('로컬 비공개 저장소에 저장 중…');
    try {
      const dataset = await client.call('tuning.datasets.import', { name, jsonl: source, acknowledgePii: pii }) as Dataset;
      if (current !== epoch.current) return;
      setDatasets(rows => [dataset, ...rows]); setSource(''); setValidation(null); setRights(false); setPii(false);
      setMessage('이 PC에만 저장했습니다. 외부 업로드나 학습은 시작하지 않았습니다.');
    } catch (error) { if (current === epoch.current) setMessage(error instanceof Error ? error.message : '저장 실패'); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const prepare = async (id: string) => {
    if (busy) return;
    const current = epoch.current; setBusy(true); setExported(null);
    try {
      const result = await client.call('tuning.datasets.export', { id }) as Exported;
      if (current === epoch.current) { setExported(result); setMessage('학습용·평가용 파일과 검증 정보를 준비했습니다. 실제 학습은 별도 실행입니다.'); }
    } catch (error) { if (current === epoch.current) setMessage(error instanceof Error ? error.message : '준비 실패'); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  return <Card className="local-training-settings">
    <details><summary>로컬 파인튜닝 · 학습 자료 준비</summary>
      <p className="panel-hint">구독 Codex·Claude의 가중치는 변경하지 않습니다. 별도 오픈모델의 LoRA 학습을 위한 자료를 이 PC에만 준비합니다. 기존 대화 자동 수집·외부 전송·자동 설치는 하지 않습니다.</p>
      <Field label="검토한 학습 파일" hint="JSONL · 한 줄에 messages 배열 · user/assistant 예시 · 최대 256KB">
        <Input aria-label="학습 JSONL 파일" type="file" accept=".jsonl,application/jsonl" disabled={busy} onChange={event => { void selectFile(event.target.files?.[0]); event.target.value = ''; }} />
      </Field>
      {filename && <span className="training-filename">{filename}</span>}
      {validation && <>
        <div className="training-counts"><span>고유 예시 <b>{validation.uniqueRows}</b></span><span>중복 제외 <b>{validation.duplicateRows}</b></span><span>학습 <b>{validation.trainRows}</b></span><span>별도 평가 <b>{validation.evalRows}</b></span></div>
        {validation.issues.length > 0 && <ul className="training-issues">{validation.issues.slice(0, 20).map((issue, index) => <li key={index}>{issue.row ? `${issue.row}행 · ` : ''}{issue.message}</li>)}</ul>}
        <Field label="자료 이름"><Input aria-label="학습 자료 이름" value={name} disabled={busy} maxLength={80} onChange={e => setName(e.target.value)} /></Field>
        <label className="training-check"><input type="checkbox" checked={rights} disabled={busy} onChange={e => setRights(e.target.checked)} />이 자료의 학습 이용 권한이 있고 내용을 직접 검토했습니다.</label>
        {validation.piiRisks > 0 && <label className="training-check"><input type="checkbox" checked={pii} disabled={busy} onChange={e => setPii(e.target.checked)} />개인정보 의심 항목을 검토했고 이 PC에서 보관하는 데 동의합니다.</label>}
        <Button disabled={busy || !validation.valid || !name.trim() || !rights || (validation.piiRisks > 0 && !pii)} onClick={() => void save()}>검토한 자료 저장</Button>
      </>}
      <p className="panel-hint">자동 민감정보 검사는 완전하지 않습니다. 비밀키가 탐지된 자료는 저장할 수 없습니다. 학습·평가에 같은 요청이 겹치지 않도록 분리합니다.</p>
      {datasets.length > 0 && <ul className="training-datasets">{datasets.map(dataset => <li key={dataset.id}><div><b>{dataset.name}</b><span>학습 {dataset.counts.trainRows} · 평가 {dataset.counts.evalRows}</span></div><Button variant="ghost" disabled={busy} onClick={() => void prepare(dataset.id)}>학습 파일 준비</Button></li>)}</ul>}
      {exported && <div className="training-export"><b>준비된 로컬 폴더</b><code>{exported.directory}</code><p>설치 폴더의 resources/app.asar.unpacked/integrations/local-training에 학습 스크립트와 안내서가 있습니다. 스크립트의 --dataset-dir에 이 폴더를 지정해 먼저 dry-run으로 환경을 확인하세요. 실제 학습은 별도 명시적 실행이 필요합니다.</p></div>}
      <p role="status" aria-live="polite" className="panel-hint">{message}</p>
    </details>
  </Card>;
}
