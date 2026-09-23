import { readFileSync } from 'node:fs';
import { comparePerformance, parsePerformanceReport } from '../packages/agent/src/evaluation/performance-metrics.js';
import { argumentsOf } from './performance-common.js';
const args = argumentsOf(process.argv.slice(2), ['baseline', 'candidate']);
if (!args.baseline || !args.candidate) throw new Error('Supply --baseline and --candidate report paths.');
const result = comparePerformance(parsePerformanceReport(readFileSync(args.baseline, 'utf8')), parsePerformanceReport(readFileSync(args.candidate, 'utf8')));
console.log(JSON.stringify(result, null, 2));
// A CI promotion requires evidence of an improvement, not just absence of an exception.
if (!result.promotionEligible) process.exitCode = 2;
