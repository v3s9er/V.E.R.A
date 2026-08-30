import { useCallback, useEffect, useRef, useState } from 'react';
import type { DependencyId, DependencyInstallResult, DependencyReport } from '@mr-robot/shared';
import { useMrRobot } from '../state';
import { Badge, Button, Card } from './ui';

interface Props {
  modal?: boolean;
  onComplete?: () => void;
}

export function DependencySetup({ modal = false, onComplete }: Props) {
  const { client } = useMrRobot();
  const canManage = client.isAdmin;
  const [report, setReport] = useState<DependencyReport | null>(null);
  const [selected, setSelected] = useState<Set<DependencyId>>(new Set());
  const [busy, setBusy] = useState<DependencyId | 'all' | 'complete' | null>(null);
  const [message, setMessage] = useState('');
  const initialized = useRef(false);
  const autoStarted = useRef(false);

  const refresh = useCallback(async (): Promise<DependencyReport | null> => {
    try {
      const next = await client.call('dependencies.status', {}) as DependencyReport;
      setReport(next);
      if (!initialized.current) {
        initialized.current = true;
        const productDependencies: DependencyId[] = ['node', 'git', 'speech-ko', 'codex', 'claude'];
        setSelected(new Set(next.items.filter((item) => !item.installed && item.canInstall && productDependencies.includes(item.id)).map((item) => item.id)));
      }
      return next;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!canManage || !modal || !report || autoStarted.current || report.wizardVersion >= 4) return;
    autoStarted.current = true;
    const missing = report.items.filter((item) => !item.installed && ['node', 'git', 'speech-ko', 'codex', 'claude'].includes(item.id));
    if (missing.length === 0) { void complete(); return; }
    setSelected(new Set(missing.map((item) => item.id)));
    window.setTimeout(() => void installMissing(missing), 250);
  }, [canManage, modal, report]);

  const toggle = (id: DependencyId): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const installOne = async (id: DependencyId): Promise<boolean> => {
    setBusy(id);
    setMessage('');
    try {
      const result = await client.call('dependencies.install', { id }) as DependencyInstallResult;
      setMessage(`${result.item.name}: ${result.ok ? '설치 완료' : '설치 실패'}${result.output ? `\n${result.output.slice(-2500)}` : ''}`);
      await refresh();
      return result.ok;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const installSelected = async (): Promise<void> => {
    if (!report) return;
    setBusy('all');
    setMessage('');
    const ordered = report.items.filter((item) => selected.has(item.id) && !item.installed);
    for (const item of ordered) {
      setMessage(`${item.name} 설치 중…`);
      try {
        const result = await client.call('dependencies.install', { id: item.id }) as DependencyInstallResult;
        if (!result.ok) {
          setMessage(`${item.name} 설치 실패\n${result.output.slice(-2500)}`);
          break;
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
        break;
      }
      await refresh();
    }
    setBusy(null);
    await refresh();
  };

  const installMissing = async (items: DependencyReport['items']): Promise<void> => {
    setBusy('all');
    for (const item of items) {
      setMessage(`${item.name} 자동 설치 중…`);
      try {
        const result = await client.call('dependencies.install', { id: item.id }) as DependencyInstallResult;
        if (!result.ok) { setMessage(`${item.name} 설치 실패\n${result.output.slice(-2500)}\n설치 버튼으로 다시 시도할 수 있습니다.`); setBusy(null); await refresh(); return; }
      } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setBusy(null); return; }
    }
    setBusy(null); await complete();
  };

  const complete = async (): Promise<void> => {
    setBusy('complete');
    try {
      await client.call('dependencies.complete', {});
      await refresh();
      onComplete?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const content = (
    <Card className={`dependency-setup ${modal ? 'dependency-modal-card' : ''}`}>
      <div className="dependency-header">
        <div>
          <h3>{modal ? 'Mr.Robot 첫 실행 준비' : '외부 도구 및 의존성'}</h3>
          <p className="panel-hint">설치 여부를 실제 실행 파일로 확인합니다. 선택한 누락 항목만 공식 패키지 경로로 설치합니다.</p>
        </div>
        <Button variant="ghost" disabled={busy !== null} onClick={() => void refresh()}>다시 검사</Button>
      </div>

      {!report && !message && <p className="panel-hint">의존성을 검사하는 중…</p>}
      {report && !report.packageManagerAvailable && (
        <div className="dependency-warning">winget을 찾지 못했습니다. Windows 앱 설치 관리자를 먼저 업데이트해야 자동 설치할 수 있습니다.</div>
      )}
      {!canManage && <div className="dependency-warning">의존성 설치와 업데이트는 해당 PC의 데스크톱 앱에서 관리자 연결로 진행하세요. 현재 기기에서는 설치 상태만 볼 수 있습니다.</div>}
      <div className="dependency-list">
        {report?.items.map((item) => (
          <label className={`dependency-row ${item.installed ? 'installed' : ''}`} key={item.id}>
            <input
              type="checkbox"
              checked={item.installed || selected.has(item.id)}
              disabled={!canManage || item.installed || busy !== null || !item.canInstall}
              onChange={() => toggle(item.id)}
            />
            <span className="dependency-copy">
              <span className="dependency-name">
                <b>{item.name}</b>
                {item.required && <Badge tone="accent">필수</Badge>}
                {item.installed ? <Badge tone="ok">설치됨</Badge> : <Badge tone="warn">없음</Badge>}
                {item.requiresLogin && <Badge>별도 로그인</Badge>}
              </span>
              <small>{item.description}</small>
              {item.version && <code>{item.version}</code>}
              {item.path && <span className="dependency-path" title={item.path}>{item.path}</span>}
            </span>
            {!item.installed && (
              <Button disabled={!canManage || busy !== null || !item.canInstall} onClick={(event) => { event.preventDefault(); void installOne(item.id); }}>
                {busy === item.id ? '설치 중…' : '설치'}
              </Button>
            )}
          </label>
        ))}
      </div>

      {message && <pre className="dependency-output">{message}</pre>}
      <p className="panel-hint">Codex와 Claude는 설치 후 각 공식 로그인 화면에서 직접 인증해야 합니다. Mr.Robot은 로그인 토큰을 복사하거나 묶어서 배포하지 않습니다.</p>
      <div className="dependency-actions">
        <Button disabled={!canManage || busy !== null || selected.size === 0} onClick={() => void installSelected()}>
          {busy === 'all' ? '선택 항목 설치 중…' : '선택한 누락 항목 설치'}
        </Button>
        {modal && <Button variant="ghost" disabled={!canManage || busy !== null} onClick={() => void complete()}>{busy === 'complete' ? '저장 중…' : '검사 완료하고 시작'}</Button>}
      </div>
    </Card>
  );

  return modal ? <div className="dependency-modal" role="dialog" aria-modal="true" aria-label="첫 실행 의존성 설정">{content}</div> : content;
}
