/** Small, explicit vocabulary. This is not an OWL/SHACL implementation. */
export const KNOWLEDGE_RELATIONS = [
  { id: 'is_a', label: '유형', rule: '분류 상속' },
  { id: 'subclass_of', label: '상위 분류', rule: '분류 상속' },
  { id: 'part_of', label: '소속 / 구성', rule: '전이·순환 검사' },
  { id: 'depends_on', label: '의존', rule: '전이·순환 검사' },
  { id: 'requires', label: '필요 조건', rule: '여러 값 허용' },
  { id: 'located_in', label: '현재 위치', rule: '단일 값 충돌 검사' },
  { id: 'owner', label: '담당자', rule: '단일 값 충돌 검사' },
  { id: 'status', label: '현재 상태', rule: '단일 값 충돌 검사' },
  { id: 'disjoint_with', label: '동시에 성립할 수 없는 유형', rule: '유형 충돌 검사' },
] as const;

export interface KnowledgeMetrics {
  asserted: number;
  inferred: number;
  conflicts: number;
  contextBytes: number;
  retrievalMs: number;
  truncated: boolean;
}
