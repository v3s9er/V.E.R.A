import { useState } from 'react';
import type { ConversationSummary, WorkspaceInfo } from '@mr-robot/shared';
import { useMrRobot } from '../state';
import { Button, Input, Modal } from './ui';
import './ProjectNavigation.css';

export function ProjectNavigation({ projects, conversations, active, running = [], onSelect, onChanged }: {
  projects: WorkspaceInfo[]; conversations: ConversationSummary[]; active: string;
  running?: string[];
  onSelect: (id: string) => void; onChanged: (projects: WorkspaceInfo[]) => void;
}) {
  const { client } = useMrRobot();
  const [editing, setEditing] = useState<WorkspaceInfo | 'new' | null>(null);
  const [name, setName] = useState(''), [path, setPath] = useState(''), [instructions, setInstructions] = useState('');
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [confirmRemove, setConfirmRemove] = useState(false);
  const open = (project: WorkspaceInfo | 'new') => {
    setEditing(project); setName(project === 'new' ? '' : project.name); setPath(project === 'new' ? '' : project.path);
    setInstructions(project === 'new' ? '' : project.instructions ?? ''); setError(''); setConfirmRemove(false);
  };
  const save = async () => {
    if (!editing || saving) return;
    setSaving(true); setError('');
    try {
      const project = await client.call(editing === 'new' ? 'projects.create' : 'projects.update', { id: editing === 'new' ? undefined : editing.id, name, path, instructions }) as WorkspaceInfo;
      onChanged([...projects.filter(item => item.id !== project.id), project]);
      setEditing(null); onSelect(project.id);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!editing || editing === 'new' || saving) return;
    setSaving(true); setError('');
    try {
      await client.call('projects.delete', { id: editing.id });
      onChanged(projects.filter(item => item.id !== editing.id)); setEditing(null); onSelect('*');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  return <section className="project-navigation" aria-label="프로젝트">
    <div className="project-nav-heading"><span>프로젝트</span>{client.isAdmin && <button title="프로젝트 만들기" aria-label="프로젝트 만들기" onClick={() => open('new')}>＋</button>}</div>
    <button className={`project-row ${active === '*' ? 'selected' : ''}`} onClick={() => onSelect('*')}><span>▤</span><b>모든 대화</b><small>{conversations.length}</small></button>
    <div className="project-nav-items">
      {projects.map(project => <div className="project-nav-item" key={project.id}>
        <button className={`project-row ${active === project.id ? 'selected' : ''}`} onClick={() => onSelect(project.id)} title={project.path}><span>▱</span><b>{project.name}</b>{conversations.some(c => c.workspaceId === project.id && running.includes(c.id)) && <span className="project-running" aria-label="작업 진행 중">●</span>}<small>{conversations.filter(c => c.workspaceId === project.id).length}</small></button>
        {client.isAdmin && <button className="project-edit" title={`${project.name} 설정`} aria-label={`${project.name} 프로젝트 설정`} onClick={() => open(project)}>···</button>}
      </div>)}
    </div>
    <Modal open={editing !== null} onClose={() => { if (!saving) setEditing(null); }} title={editing === 'new' ? '새 프로젝트' : '프로젝트 설정'}>
      <form className="project-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <p>작업 폴더와 지침을 연결하세요. 각 대화는 자체 세션을 유지하며 다른 대화 내용은 자동으로 합치지 않습니다.</p>
        <label>프로젝트 이름<Input autoFocus value={name} maxLength={80} required onChange={e => setName(e.target.value)} placeholder="예: 앱 리뉴얼" disabled={saving} /></label>
        <label>PC 작업 폴더<Input value={path} onChange={e => setPath(e.target.value)} placeholder="비우면 PC에 새 전용 폴더 생성" disabled={saving || editing !== 'new'} /></label>
        {editing === 'new' && window.mrRobotDesktop?.chooseDirectory && <Button type="button" variant="ghost" disabled={saving} onClick={() => void window.mrRobotDesktop!.chooseDirectory().then(value => { if (value) setPath(value); }).catch(() => setError('폴더 선택을 열지 못했습니다. 경로를 직접 입력하세요.'))}>기존 폴더 선택</Button>}
        <label>프로젝트 지침 <small>선택</small><textarea className="input" rows={4} value={instructions} maxLength={8000} onChange={e => setInstructions(e.target.value)} placeholder="작업 목표, 작성 언어, 검증 방법 등" disabled={saving} /></label>
        <p>프로젝트 구분은 파일 접근 권한이나 OS 샌드박스를 대체하지 않습니다. 현재 권한 설정이 그대로 적용됩니다.</p>
        {error && <div className="inline-error" role="alert">{error}</div>}
        {confirmRemove && <div className="project-remove-confirm"><b>프로젝트 연결만 해제할까요?</b><p>PC 파일과 대화는 남습니다. 기존 대화는 다른 프로젝트를 선택한 후 다시 실행할 수 있습니다.</p><Button type="button" variant="danger" disabled={saving} onClick={() => void remove()}>연결 해제 확인</Button><Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>취소</Button></div>}
        <div className="modal-actions">{editing && editing !== 'new' && <Button type="button" variant="ghost" disabled={saving} onClick={() => setConfirmRemove(true)}>연결 해제</Button>}<Button type="button" variant="ghost" disabled={saving} onClick={() => setEditing(null)}>닫기</Button><Button type="submit" disabled={saving || !name.trim()}>{saving ? '저장 중…' : editing === 'new' ? '프로젝트 만들기' : '저장'}</Button></div>
      </form>
    </Modal>
  </section>;
}
