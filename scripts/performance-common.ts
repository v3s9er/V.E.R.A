import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { comparePerformance, parsePerformanceReport, summarizePerformance, type PerformanceReport, type PerformanceSample } from '../packages/agent/src/evaluation/performance-metrics.js';

export function argumentsOf(argv: string[], allowed: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!key || !argv[i]!.startsWith('--') || !allowed.includes(key) || options[key] !== undefined || !argv[i + 1] || argv[i + 1]!.startsWith('--')) throw new Error(`Expected --${allowed.join(', --')} with explicit values`);
    options[key] = argv[i + 1]!;
  }
  return options;
}
export function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}..${max}`);
  return n;
}
export function sourceHashes(files: string[]): Record<string, string> {
  return Object.fromEntries(files.map(path => [path, createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex')]));
}
export function report(suite: string, mode: PerformanceReport['mode'], configuration: PerformanceReport['configuration'], files: string[], samples: PerformanceSample[]): PerformanceReport {
  return { schemaVersion: 1, suite, mode, createdAt: new Date().toISOString(), configuration,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpuCount: cpus().length }, sourceHashes: sourceHashes(files), samples };
}
export function finishReport(value: PerformanceReport, output?: string, baseline?: string) {
  parsePerformanceReport(JSON.stringify(value));
  // Preserve measurements: an existing report cannot silently be overwritten.
  if (output) writeFileSync(resolve(output), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const comparison = baseline ? comparePerformance(parsePerformanceReport(readFileSync(resolve(baseline), 'utf8')), value) : undefined;
  console.log(JSON.stringify({ ...value, samples: undefined, summary: summarizePerformance(value), comparison }, null, 2));
  if (value.samples.some(s => !s.completed || !s.qualityPassed) || comparison?.cases.some(c => c.status === 'regressed')) process.exitCode = 1;
}
