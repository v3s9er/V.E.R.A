import { useState } from 'react';
import { visibleModelChoices, type ProviderInfo } from '@mr-robot/shared';
import { Modal } from './ui';
import './ModelPicker.css';

export function ModelPicker({ providers, catalogs, providerId, model, disabled, scenario, refreshing, onRefresh, onSelect }: {
  providers: ProviderInfo[]; catalogs: Record<string, string[]>; providerId?: string; model?: string;
  disabled: boolean; scenario: boolean; refreshing: boolean;
  onRefresh(force: boolean): void; onSelect(providerId?: string, model?: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const current = providers.find(p => p.id === providerId) ?? providers.find(p => p.isDefault) ?? providers[0];
  const close = () => setOpen(false);
  return <>
    <button type="button" className="model-picker-trigger" aria-label="대화 모델" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => { setQuery(''); setFilter(''); setOpen(true); onRefresh(false); }}><span>{scenario ? '시나리오 자동 배정' : model || current?.model || '모델 선택'}</span><span aria-hidden="true">⌄</span></button>
    <Modal open={open} onClose={close} title="모델 선택">
      <div className="model-picker">
        <div className="model-picker-search"><input autoFocus aria-label="모델 검색" placeholder="이름으로 모델 검색" value={query} onChange={e => setQuery(e.target.value)} /><button type="button" aria-label="모델 목록 새로고침" disabled={refreshing} onClick={() => onRefresh(true)}>{refreshing ? '확인 중…' : '새로고침'}</button></div>
        <div className="model-picker-filters" aria-label="공급자 필터"><button type="button" aria-pressed={!filter} onClick={() => setFilter('')}>전체</button>{providers.map(p => <button type="button" key={p.id} aria-pressed={filter === p.id} onClick={() => setFilter(p.id)}>{p.label}</button>)}</div>
        <div className="model-picker-list">
          {!query && !filter && <button type="button" className="model-picker-row" disabled={disabled || scenario} onClick={() => { onSelect(); close(); }}><span>기본 모델 사용</span><small>{providers.find(p => p.isDefault)?.model}</small></button>}
          {providers.filter(p => !filter || p.id === filter).map(p => {
            const choices = visibleModelChoices(catalogs[p.id] ?? [p.model], providerId === p.id ? model : undefined).filter(m => `${m} ${p.label}`.toLowerCase().includes(query.trim().toLowerCase()));
            return choices.length ? <section key={p.id}><h3>{p.label}</h3>{choices.map(m => <button type="button" key={m} className="model-picker-row" aria-pressed={!scenario && current?.id === p.id && (model || current.model) === m} disabled={disabled} onClick={() => { onSelect(p.id, m); close(); }}><span>{m}</span>{!scenario && current?.id === p.id && (model || current.model) === m && <span aria-label="선택됨">✓</span>}</button>)}</section> : null;
          })}
          {providers.filter(p => !filter || p.id === filter).every(p => !visibleModelChoices(catalogs[p.id] ?? [p.model], providerId === p.id ? model : undefined).some(m => `${m} ${p.label}`.toLowerCase().includes(query.trim().toLowerCase()))) && <p role="status">일치하는 모델이 없습니다.</p>}
        </div>
        <p className="model-picker-hint">추론과 Daybreak는 입력창의 별도 옵션에서 설정합니다.</p>
      </div>
    </Modal>
  </>;
}
