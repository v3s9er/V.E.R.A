/** CUSTOM BFCL-derived function-call evaluation, NOT the official BFCL score.
 * References remain host-only. No Python/AST/eval or benchmark functions execute.
 */
import { createHash } from 'node:crypto';
import type { NeutralTool, Turn } from '../ai/provider.js';

export const BENCHMARK_CATEGORIES = ['simple_python', 'multiple', 'parallel', 'irrelevance'] as const;
export type BenchmarkCategory = typeof BENCHMARK_CATEGORIES[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Dict = Record<string, unknown>;
export interface BenchmarkFunction { name: string; description: string; parameters: Dict }
export interface BenchmarkTask { id: string; category: BenchmarkCategory; question: Turn[][]; functions: BenchmarkFunction[] }
export interface BenchmarkExpectedCall { name: string; arguments: Record<string, JsonValue[]> }
export interface BenchmarkAnswer { id: string; calls: BenchmarkExpectedCall[] }
export interface PreparedBenchmarkTask {
  id: string; category: BenchmarkCategory; turns: Turn[]; tools: NeutralTool[];
  /** Native alias -> original function name. Never consult reference answers here. */
  nameMap: Record<string, string>;
  /** Original descriptions/defaults/optional/type metadata retained unchanged for audit. */
  originalFunctions: BenchmarkFunction[];
}
export interface BenchmarkCall { name: string; input: unknown }
export type BenchmarkValidationCode = 'unknown_tool' | 'invalid_arguments' | 'missing_required' | 'extra_argument' | 'argument_type' | 'argument_constraint';
export type BenchmarkCallValidation = { valid: true; originalName: string } | { valid: false; code: BenchmarkValidationCode };
export type BenchmarkGradeCode = 'passed' | BenchmarkValidationCode | 'reference_invalid' | 'missing_call' | 'extra_call' | 'arguments_mismatch' | 'irrelevant_call';
export interface BenchmarkGrade { passed: boolean; code: BenchmarkGradeCode; expectedCalls: number; actualCalls: number }
const own = (v: object, key: string) => Object.prototype.hasOwnProperty.call(v, key);
const object = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
function fail(): never { throw new Error('Invalid or unsupported benchmark data'); }
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
function exactKeys(v: Dict, keys: string[]) { if (Object.keys(v).some(k => !keys.includes(k))) fail(); }
function boundedString(v: unknown, max = 16_384): v is string { return typeof v === 'string' && v.length > 0 && v.length <= max; }

/** Strict bounded JSON, including duplicate-key rejection; errors never echo input. */
export function parseBenchmarkJson(raw: string): JsonValue {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 512 * 1024) fail();
  let at = 0, nodes = 0;
  const ws = () => { while (at < raw.length && /[ \t\r\n]/.test(raw[at]!)) at++; };
  const string = (): string => {
    const start = at++;
    while (at < raw.length) {
      if (raw[at] === '\\') { at += 2; continue; }
      if (raw[at++] === '"') { try { return JSON.parse(raw.slice(start, at)); } catch { fail(); } }
    }
    return fail();
  };
  const value = (depth: number): JsonValue => {
    if (depth > 24 || ++nodes > 30_000) fail();
    ws(); const c = raw[at];
    if (c === '"') return string();
    if (c === '{') {
      at++; const result: Record<string, JsonValue> = Object.create(null); ws();
      if (raw[at] === '}') { at++; return result; }
      while (at < raw.length) {
        ws(); if (raw[at] !== '"') fail(); const key = string();
        if (forbidden.has(key) || own(result, key) || Object.keys(result).length >= 256) fail();
        ws(); if (raw[at++] !== ':') fail(); result[key] = value(depth + 1); ws();
        if (raw[at] === '}') { at++; return result; } if (raw[at++] !== ',') fail();
      }
      return fail();
    }
    if (c === '[') {
      at++; const result: JsonValue[] = []; ws(); if (raw[at] === ']') { at++; return result; }
      while (at < raw.length) {
        if (result.length >= 4096) fail(); result.push(value(depth + 1)); ws();
        if (raw[at] === ']') { at++; return result; } if (raw[at++] !== ',') fail();
      }
      return fail();
    }
    for (const [text, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (raw.startsWith(text, at)) { at += text.length; return result; }
    }
    const n = raw.slice(at).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!n) return fail(); at += n[0].length; const result = Number(n[0]);
    if (!Number.isFinite(result)) fail(); return result;
  };
  const result = value(0); ws(); if (at !== raw.length) fail(); return result;
}
function rows(raw: string): JsonValue[] {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32 * 1024 * 1024) fail();
  const lines = raw.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length || lines.length > 4096) fail(); return lines.map(parseBenchmarkJson);
}
function categoryCheck(category: BenchmarkCategory) { if (!BENCHMARK_CATEGORIES.includes(category)) fail(); }
function idCheck(id: unknown, category: BenchmarkCategory): id is string {
  return typeof id === 'string' && new RegExp(`^${category}_[0-9]{1,6}$`).test(id);
}
export function parseBenchmarkTasks(raw: string, category: BenchmarkCategory): BenchmarkTask[] {
  categoryCheck(category); const ids = new Set<string>();
  return rows(raw).map(value => {
    if (!object(value)) return fail(); exactKeys(value, ['id', 'question', 'function']);
    if (!idCheck(value.id, category) || ids.has(value.id) || !Array.isArray(value.question) || value.question.length !== 1
      || !Array.isArray(value.function) || !value.function.length || value.function.length > 64) return fail();
    ids.add(value.id);
    const question = value.question.map(turns => {
      if (!Array.isArray(turns) || !turns.length || turns.length > 16) return fail();
      return turns.map(turn => {
        if (!object(turn)) return fail(); exactKeys(turn, ['role', 'content']);
        if (!['user', 'assistant', 'system'].includes(String(turn.role)) || !boundedString(turn.content, 128 * 1024)) return fail();
        return { role: turn.role as Turn['role'], content: turn.content };
      });
    });
    const names = new Set<string>();
    const functions = value.function.map(fn => {
      if (!object(fn)) return fail(); exactKeys(fn, ['name', 'description', 'parameters']);
      if (!boundedString(fn.name, 200) || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(fn.name) || names.has(fn.name)
        || !boundedString(fn.description) || !object(fn.parameters)) return fail();
      names.add(fn.name);
      // Schema support is checked AFTER selection, never used to cherry-pick tasks.
      return { name: fn.name, description: fn.description, parameters: structuredClone(fn.parameters) };
    });
    return { id: value.id, category, question, functions };
  });
}
function validAlternative(v: unknown, depth = 0): v is JsonValue {
  if (depth > 20) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 4096 && v.every(x => validAlternative(x, depth + 1));
  return object(v) && Object.values(v).every(x => Array.isArray(x) && x.length > 0 && x.length <= 128 && x.every(y => validAlternative(y, depth + 1)));
}
export function parseBenchmarkAnswers(raw: string, category: BenchmarkCategory): Map<string, BenchmarkAnswer> {
  categoryCheck(category); const result = new Map<string, BenchmarkAnswer>();
  for (const value of rows(raw)) {
    if (!object(value)) fail(); exactKeys(value, ['id', 'ground_truth']);
    if (!idCheck(value.id, category) || result.has(value.id) || !Array.isArray(value.ground_truth)
      || value.ground_truth.length > 64 || (category !== 'irrelevance' && !value.ground_truth.length)) fail();
    const calls = value.ground_truth.map(call => {
      if (!object(call) || Object.keys(call).length !== 1) return fail();
      const name = Object.keys(call)[0]!; const args = call[name];
      if (!boundedString(name, 200) || !object(args) || !Object.values(args).every(v => Array.isArray(v) && v.length > 0 && v.length <= 128 && v.every(x => validAlternative(x)))) return fail();
      return { name, arguments: args as Record<string, JsonValue[]> };
    });
    result.set(value.id, { id: value.id, calls });
  }
  return result;
}

/** ID-only partition/rank; answers and schema support cannot influence membership.
 * Stable halves keep dev/holdout disjoint even when sample counts change.
 */
export function selectBenchmarkTasks(tasks: readonly BenchmarkTask[], options: { seed: string; perCategory: number; split: 'dev' | 'holdout' }): BenchmarkTask[] {
  if (!boundedString(options.seed, 200) || !Number.isSafeInteger(options.perCategory) || options.perCategory < 1 || options.perCategory > 1000
    || !['dev', 'holdout'].includes(options.split)) fail();
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) fail();
  const selected: BenchmarkTask[] = [];
  for (const category of BENCHMARK_CATEGORIES) {
    const ranked = tasks.filter(t => t.category === category).map(task => ({ task, hash: digest(`${options.seed}\0${task.id}`) }))
      .filter(({ hash }) => parseInt(hash.slice(0, 2), 16) % 2 === (options.split === 'dev' ? 0 : 1))
      .sort((a, b) => a.hash.localeCompare(b.hash) || a.task.id.localeCompare(b.task.id));
    if (ranked.length < options.perCategory) throw new Error('Insufficient benchmark tasks for requested split');
    selected.push(...ranked.slice(0, options.perCategory).map(item => item.task));
  }
  return selected;
}

/** Supported BFCL schema subset is explicit; unknown validation keywords fail. */
export function normalizeBenchmarkSchema(input: unknown, depth = 0): Dict {
  if (!object(input) || depth > 20) fail();
  exactKeys(input, ['type', 'description', 'properties', 'required', 'items', 'enum', 'default', 'optional', 'format',
    'minimum', 'maximum', 'minItems', 'maxItems', 'additionalProperties']);
  const mapping: Record<string, string> = { dict: 'object', object: 'object', tuple: 'array', list: 'array', array: 'array',
    float: 'number', number: 'number', integer: 'integer', string: 'string', boolean: 'boolean', null: 'null', any: 'any' };
  if (typeof input.type !== 'string' || !own(mapping, input.type)) fail();
  const type = mapping[input.type]!; const output: Dict = type === 'any' ? {} : { type };
  if (input.description !== undefined) { if (!boundedString(input.description)) fail(); output.description = input.description; }
  if (input.default !== undefined) output.default = structuredClone(input.default);
  // BFCL uses optional as a nonstandard annotation: booleans, strings ("True",
  // "yes"), or a root list of names. Only required controls validation. Preserve
  // the exact annotation in originalFunctions, never guess truthiness/coercions.
  if (input.optional !== undefined && typeof input.optional !== 'boolean'
    && !(typeof input.optional === 'string' && input.optional.length <= 200)
    && !(Array.isArray(input.optional) && input.optional.length <= 256 && input.optional.every(v => boundedString(v, 200)))) fail();
  if (input.enum !== undefined) {
    if (!Array.isArray(input.enum) || !input.enum.length || input.enum.length > 256) fail(); output.enum = structuredClone(input.enum);
  }
  if (input.format !== undefined) {
    if (type !== 'string' || !['date', 'date-time', 'email', 'uri'].includes(String(input.format))) fail(); output.format = input.format;
  }
  for (const key of ['minimum', 'maximum', 'minItems', 'maxItems'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || (key.endsWith('Items')
      ? type !== 'array' || !Number.isSafeInteger(input[key]) || input[key] < 0 : !['number', 'integer'].includes(type))) fail();
    output[key] = input[key];
  }
  if (type === 'object') {
    if (input.items !== undefined) fail();
    if (input.properties !== undefined && !object(input.properties)) fail();
    const properties = input.properties as Dict | undefined;
    if (properties) output.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
      if (forbidden.has(key)) fail(); return [key, normalizeBenchmarkSchema(value, depth + 1)];
    }));
    if (input.required !== undefined) {
      if (!Array.isArray(input.required) || input.required.some(key => !boundedString(key, 200) || forbidden.has(key))
        || new Set(input.required).size !== input.required.length || (properties && input.required.some(key => !own(properties, key)))) fail();
      output.required = [...input.required];
    }
    if (input.additionalProperties !== undefined && typeof input.additionalProperties !== 'boolean') fail();
    // Free-form dictionaries remain free-form. Function argument objects are closed below.
    output.additionalProperties = input.additionalProperties ?? !properties;
  } else {
    if (input.properties !== undefined || input.required !== undefined || input.additionalProperties !== undefined) fail();
    if (type === 'array') {
      if (Array.isArray(input.items)) {
        if (!input.items.length || input.items.length > 64) fail();
        output.prefixItems = input.items.map(v => normalizeBenchmarkSchema(v, depth + 1));
        output.minItems = input.items.length; output.maxItems = input.items.length;
      } else output.items = input.items === undefined ? {} : normalizeBenchmarkSchema(input.items, depth + 1);
    } else if (input.items !== undefined) fail();
  }
  return output;
}
export function prepareBenchmarkTask(task: BenchmarkTask): PreparedBenchmarkTask {
  const nameMap: Record<string, string> = Object.create(null);
  const tools = task.functions.map((fn, index) => {
    // Index guarantees a bijection even under an adversarial hash/name collision.
    const name = `bfcl_${index}_${fn.name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 26)}_${digest(fn.name).slice(0, 12)}`;
    nameMap[name] = fn.name;
    const parameters = normalizeBenchmarkSchema(fn.parameters);
    if (parameters.type !== 'object') fail(); parameters.additionalProperties = false;
    return { name, description: `${fn.description}\nOriginal benchmark function: ${fn.name}`, parameters };
  });
  return { id: task.id, category: task.category, turns: structuredClone(task.question[0]!), tools, nameMap,
    originalFunctions: structuredClone(task.functions) };
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => own(b, k) && jsonEqual(a[k], b[k]));
}
function schemaError(schema: Dict, input: unknown): BenchmarkValidationCode | undefined {
  const type = schema.type;
  if ((type === 'null' && input !== null) || (type === 'string' && typeof input !== 'string')
    || (type === 'boolean' && typeof input !== 'boolean') || (type === 'integer' && !Number.isSafeInteger(input))
    || (type === 'number' && (typeof input !== 'number' || !Number.isFinite(input)))
    || (type === 'array' && !Array.isArray(input)) || (type === 'object' && !object(input))) return 'argument_type';
  if (Array.isArray(schema.enum) && !schema.enum.some(v => jsonEqual(v, input))) return 'argument_constraint';
  if (typeof input === 'number' && ((typeof schema.minimum === 'number' && input < schema.minimum)
    || (typeof schema.maximum === 'number' && input > schema.maximum))) return 'argument_constraint';
  if (typeof input === 'string' && schema.format) {
    const valid = schema.format === 'date' ? /^\d{4}-\d{2}-\d{2}$/.test(input) && !Number.isNaN(Date.parse(input)) && new Date(input).toISOString().slice(0, 10) === input
      : schema.format === 'date-time' ? /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d\d:\d\d)$/.test(input) && !Number.isNaN(Date.parse(input))
      : schema.format === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) : /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(input);
    if (!valid) return 'argument_constraint';
  }
  if (Array.isArray(input)) {
    if ((typeof schema.minItems === 'number' && input.length < schema.minItems)
      || (typeof schema.maxItems === 'number' && input.length > schema.maxItems)) return 'argument_constraint';
    for (let i = 0; i < input.length; i++) {
      const itemSchema = Array.isArray(schema.prefixItems) ? schema.prefixItems[i] : schema.items;
      if (object(itemSchema)) { const error = schemaError(itemSchema, input[i]); if (error) return error; }
    }
  }
  if (object(input) && type === 'object') {
    if (Array.isArray(schema.required) && schema.required.some(k => !own(input, String(k)))) return 'missing_required';
    const properties = object(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(input)) {
      if (!own(properties, key)) { if (schema.additionalProperties === false) return 'extra_argument'; continue; }
      const error = schemaError(properties[key] as Dict, input[key]); if (error) return error;
    }
  }
  return undefined;
}
export function validateBenchmarkCall(prepared: PreparedBenchmarkTask, call: BenchmarkCall): BenchmarkCallValidation {
  if (!call || typeof call.name !== 'string' || !own(prepared.nameMap, call.name)) return { valid: false, code: 'unknown_tool' };
  let input: JsonValue;
  try {
    // JSON.stringify otherwise silently converts NaN/Infinity/undefined and sparse arrays.
    let nodes = 0; const seen = new Set<object>();
    const check = (value: unknown, depth = 0): void => {
      if (++nodes > 30_000 || depth > 24) fail();
      if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
      if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return; }
      if ((!object(value) && !Array.isArray(value)) || seen.has(value)) fail();
      seen.add(value);
      if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { if (!own(value, String(i))) fail(); check(value[i], depth + 1); } }
      else for (const key of Object.keys(value)) { if (forbidden.has(key)) fail(); check(value[key], depth + 1); }
      seen.delete(value);
    };
    check(call.input); input = parseBenchmarkJson(JSON.stringify(call.input));
  } catch { return { valid: false, code: 'invalid_arguments' }; }
  if (!object(input)) return { valid: false, code: 'invalid_arguments' };
  const tool = prepared.tools.find(tool => tool.name === call.name)!;
  const code = schemaError(tool.parameters, input);
  return code ? { valid: false, code } : { valid: true, originalName: prepared.nameMap[call.name]! };
}
/** BFCL JSON dict leaves are themselves alternative lists; array order remains exact. */
function matchesAlternative(actual: unknown, expected: JsonValue): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matchesAlternative(actual[i], v));
  if (object(expected)) return object(actual) && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([k, choices]) => own(actual, k) && Array.isArray(choices) && choices.some(v => matchesAlternative(actual[k], v)));
  return actual === expected;
}
export function gradeBenchmarkCalls(prepared: PreparedBenchmarkTask, answer: BenchmarkAnswer | undefined, calls: readonly BenchmarkCall[]): BenchmarkGrade {
  const count = Array.isArray(calls) ? calls.length : 0;
  const result = (code: BenchmarkGradeCode, expectedCalls = answer?.calls.length ?? 0): BenchmarkGrade => ({ passed: code === 'passed', code, expectedCalls, actualCalls: count });
  if (!Array.isArray(calls) || count > 64) return result('invalid_arguments');
  if (prepared.category === 'irrelevance') return result(count ? 'irrelevant_call' : 'passed', 0);
  if (!answer || answer.id !== prepared.id || !answer.calls.length || answer.calls.length > 64
    || answer.calls.some(call => !Object.values(prepared.nameMap).includes(call.name))) return result('reference_invalid');
  const actual: Array<{ name: string; input: Dict }> = [];
  for (const call of calls) {
    const validation = validateBenchmarkCall(prepared, call); if (!validation.valid) return result(validation.code);
    actual.push({ name: validation.originalName, input: call.input as Dict });
  }
  if (count < answer.calls.length) return result('missing_call');
  if (count > answer.calls.length) return result('extra_call');
  const matches = actual.map(call => answer.calls.map(expected => {
    if (call.name !== expected.name || Object.keys(call.input).some(k => !own(expected.arguments, k))) return false;
    const original = prepared.originalFunctions.find(fn => fn.name === expected.name)!;
    const required = Array.isArray(original.parameters.required) ? original.parameters.required : [];
    return Object.entries(expected.arguments).every(([key, choices]) => own(call.input, key)
      ? choices.some(value => matchesAlternative(call.input[key], value))
      : !required.includes(key) && choices.includes(''));
  }));
  // Augmenting-path bipartite matching, not greedy matching or reusable expectations.
  const assigned = new Array<number>(answer.calls.length).fill(-1);
  const assign = (index: number, seen: Set<number>): boolean => {
    for (let target = 0; target < assigned.length; target++) {
      if (!matches[index]![target] || seen.has(target)) continue;
      seen.add(target);
      if (assigned[target] === -1 || assign(assigned[target]!, seen)) { assigned[target] = index; return true; }
    }
    return false;
  };
  return result(actual.every((_, index) => assign(index, new Set())) ? 'passed' : 'arguments_mismatch');
}
