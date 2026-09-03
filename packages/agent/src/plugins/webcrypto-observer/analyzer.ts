import { WEBCRYPTO_OBSERVER_LIMITS } from './policy.js';
import type { OfflineAnalysisResult, OfflineAnalyzeRequest, OfflineCandidate } from './types.js';

const MAX_CANDIDATES = 100;

const FIXED_PATTERNS: ReadonlyArray<{
  operation: OfflineCandidate['operation'];
  api: OfflineCandidate['api'];
  confidence: OfflineCandidate['confidence'];
  pattern: RegExp;
}> = [
  {
    operation: 'encrypt', api: 'crypto.subtle.encrypt', confidence: 'high',
    pattern: /\b(?:globalThis\s*\.\s*|window\s*\.\s*)?crypto\s*\.\s*subtle\s*\.\s*encrypt\s*\(/g,
  },
  {
    operation: 'decrypt', api: 'crypto.subtle.decrypt', confidence: 'high',
    pattern: /\b(?:globalThis\s*\.\s*|window\s*\.\s*)?crypto\s*\.\s*subtle\s*\.\s*decrypt\s*\(/g,
  },
  {
    operation: 'encrypt', api: 'crypto.subtle.encrypt', confidence: 'medium',
    pattern: /\bsubtle\s*\.\s*encrypt\s*\(/g,
  },
  {
    operation: 'decrypt', api: 'crypto.subtle.decrypt', confidence: 'medium',
    pattern: /\bsubtle\s*\.\s*decrypt\s*\(/g,
  },
  {
    operation: 'encode', api: 'TextEncoder.encode', confidence: 'medium',
    pattern: /(?:\bnew\s+TextEncoder\s*\(\s*\)|\b[A-Za-z_$][\w$]{0,63})\s*\.\s*encode\s*\(/g,
  },
  {
    operation: 'decode', api: 'TextDecoder.decode', confidence: 'medium',
    pattern: /(?:\bnew\s+TextDecoder\s*\([^)]{0,128}\)|\b[A-Za-z_$][\w$]{0,63})\s*\.\s*decode\s*\(/g,
  },
] as const;

/** Static token-pattern analysis only. The supplied JavaScript is never executed or imported. */
export function analyzeJavaScriptCandidates(raw: unknown): OfflineAnalysisResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('오프라인 분석 요청 객체가 필요합니다.');
  const request = raw as Partial<OfflineAnalyzeRequest>;
  const unknown = Object.keys(request).filter((key) => key !== 'authorizationConfirmed' && key !== 'sourceText');
  if (unknown.length > 0) throw new Error(`오프라인 분석 요청에 지원하지 않는 필드가 있습니다: ${unknown.slice(0, 3).join(', ')}`);
  if (request.authorizationConfirmed !== true) throw new Error('분석할 코드에 대한 소유권 또는 명시적 허가를 확인해야 합니다.');
  if (typeof request.sourceText !== 'string') throw new Error('sourceText 문자열이 필요합니다.');
  const sourceBytes = Buffer.byteLength(request.sourceText, 'utf8');
  if (sourceBytes === 0 || sourceBytes > WEBCRYPTO_OBSERVER_LIMITS.maxSourceBytes) {
    throw new Error(`sourceText는 UTF-8 기준 1~${WEBCRYPTO_OBSERVER_LIMITS.maxSourceBytes}바이트여야 합니다.`);
  }

  const lineStarts = [0];
  for (let index = request.sourceText.indexOf('\n'); index >= 0; index = request.sourceText.indexOf('\n', index + 1)) {
    lineStarts.push(index + 1);
  }
  const candidates: Array<OfflineCandidate & { offset: number; end: number }> = [];
  const seen = new Set<string>();
  for (const definition of FIXED_PATTERNS) {
    definition.pattern.lastIndex = 0;
    let patternCandidates = 0;
    for (const match of request.sourceText.matchAll(definition.pattern)) {
      const offset = match.index;
      if (definition.confidence === 'medium' && candidates.some((candidate) => (
        candidate.api === definition.api && candidate.confidence === 'high'
        && offset >= candidate.offset && offset < candidate.end
      ))) continue;
      const identity = `${definition.api}:${offset}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const { line, column } = locateOffset(lineStarts, offset);
      candidates.push({
        operation: definition.operation,
        api: definition.api,
        confidence: definition.confidence,
        line,
        column,
        offset,
        end: offset + match[0].length,
      });
      patternCandidates += 1;
      if (patternCandidates >= MAX_CANDIDATES + 1) break;
    }
  }
  candidates.sort((left, right) => left.offset - right.offset || left.api.localeCompare(right.api));

  const truncated = candidates.length > MAX_CANDIDATES;
  const outputCandidates: OfflineCandidate[] = candidates.slice(0, MAX_CANDIDATES).map(({ offset: _offset, end: _end, ...candidate }) => candidate);
  return {
    truncated,
    candidates: outputCandidates,
  };
}

function locateOffset(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}
