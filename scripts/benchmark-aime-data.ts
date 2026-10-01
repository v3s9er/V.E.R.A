import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { distribution } from '../packages/agent/src/evaluation/performance-metrics.js';

export const AIME_REVISION = '13f9e12f613e720c2a2b2f345dd04b998a29494d';
export const AIME_JSON_SHA256 = '24e50dcd3ba120e4eb0f605bb03bf778f5dc5d6ace59ebb0ed106be943c67838';
export interface AimeTask { id: string; year: number; exam: 'I' | 'II'; number: number; problem: string; answer: number; url: string }
export interface AimeSample {
  id: string; completed: boolean; passed: boolean; failure: string | null; durationMs: number; firstTextMs: number | null;
  actualEffort: string | null; promptTokens: number | null; completionTokens: number | null; cachedPromptTokens: number | null;
  calls: number; toolCalls: number; predicted: number | null;
}
export function parseAimeTasks(value: unknown): AimeTask[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).records)) throw new Error('Invalid AIME cache');
  const data = value as Record<string, any>;
  if (data.revision !== AIME_REVISION || data.dataset !== 'AI-MO/aimo-validation-aime' || data.declaredLicense !== 'apache-2.0') throw new Error('Unexpected AIME provenance');
  const seen = new Set<string>();
  return data.records.map((row: any) => {
    if (!row || ![2022, 2023, 2024].includes(row.year) || !['I', 'II'].includes(row.exam)
      || !Number.isInteger(row.number) || row.number < 1 || row.number > 15
      || row.id !== `${row.year}-AIME-${row.exam}-${String(row.number).padStart(2, '0')}` || seen.has(row.id)
      || typeof row.problem !== 'string' || !row.problem.trim() || row.problem.length > 16000
      || !Number.isInteger(row.answer) || row.answer < 0 || row.answer > 999
      || typeof row.url !== 'string' || !/^https?:\/\/(?:www\.)?artofproblemsolving\.com\//.test(row.url)) throw new Error('Invalid AIME record');
    seen.add(row.id);
    return { id: row.id, year: row.year, exam: row.exam, number: row.number, problem: row.problem, answer: row.answer, url: row.url };
  });
}
export function readAimeCache(path: string): AimeTask[] {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error('Invalid AIME cache file');
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== AIME_JSON_SHA256) throw new Error('Pinned AIME checksum mismatch');
  return parseAimeTasks(JSON.parse(bytes.toString('utf8')));
}
export function selectAimeYear(tasks: AimeTask[], year: number): AimeTask[] {
  if (![2022, 2023, 2024].includes(year)) throw new Error('Choose a supported year');
  const selected = tasks.filter(task => task.year === year).sort((a, b) => a.exam.localeCompare(b.exam) || a.number - b.number);
  const expected = ['I', 'II'].flatMap(exam => Array.from({ length: 15 }, (_, i) => `${year}-AIME-${exam}-${String(i + 1).padStart(2, '0')}`));
  if (JSON.stringify(selected.map(t => t.id)) !== JSON.stringify(expected)) throw new Error('All 30 original problems are required; no answer-based selection');
  return selected;
}
export function aimePrompt(task: Pick<AimeTask, 'problem'>): string {
  return `Solve this competition mathematics problem independently. No tools or external lookup are available. Return only the final integer in the exact format Answer: N, where N is from 0 to 999.\n\n${task.problem}`;
}
export function gradeAime(text: string, expected: number) {
  const match = /^Answer:\s*([0-9]{1,3})$/u.exec(text.trim());
  const predicted = match ? Number(match[1]) : null;
  return { predicted, passed: predicted === expected, failure: predicted === null ? 'answer_format' : predicted === expected ? null : 'wrong_answer' };
}
export function summarizeAime(expectedIds: readonly string[], samples: readonly AimeSample[]) {
  if (expectedIds.length !== 30 || new Set(expectedIds).size !== 30 || new Set(samples.map(s => s.id)).size !== samples.length
    || samples.some(s => !expectedIds.includes(s.id) || s.passed && !s.completed)) throw new Error('Invalid AIME sample coverage');
  const passed = samples.filter(s => s.passed).length, completeUsage = samples.filter(s => s.promptTokens !== null && s.completionTokens !== null);
  const p = passed / expectedIds.length, z = 1.96, n = expectedIds.length;
  const center = (p + z * z / (2 * n)) / (1 + z * z / n), half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n);
  return { expected: n, attempted: samples.length, completed: samples.filter(s => s.completed).length, passed, accuracy: p,
    missing: n - samples.length, accuracyWilson95: [Math.max(0, center - half), Math.min(1, center + half)],
    completionMs: distribution(samples.map(s => s.durationMs)), firstTextMs: distribution(samples.map(s => s.firstTextMs)),
    completeUsageSamples: completeUsage.length,
    tokensPerSuccess: completeUsage.length === n && passed > 0 ? completeUsage.reduce((sum, s) => sum + s.promptTokens! + s.completionTokens!, 0) / passed : null,
    failures: Object.fromEntries([...new Set(samples.map(s => s.failure).filter((s): s is string => s !== null))].map(code => [code, samples.filter(s => s.failure === code).length])),
    byExam: ['I', 'II'].map(exam => ({ exam, expected: 15, passed: samples.filter(s => s.id.includes(`-AIME-${exam}-`) && s.passed).length })),
  };
}
