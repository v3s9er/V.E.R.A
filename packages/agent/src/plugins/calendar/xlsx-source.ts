const MAX_COMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 512;
const MIN_HEADER_DAY_COLUMNS = 7;
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface WorkCalendarImportRequest {
  /** A generic identifier matched exactly after whitespace normalization. */
  person: string;
  /** Optional generic group identifier that must be on the same row as person. */
  team?: string;
  /** Gregorian year used to turn month/day headers into dates. */
  year: number;
}

export interface WorkDateAssignment {
  date: string;
  kind: 'off' | 'onsite';
  /** Present only for onsite dates; no raw cell, row, or workbook data is returned. */
  destinationLabel?: string;
}

interface ParsedCell { column: number; value: string; formula: boolean; }
interface ParsedSheet { name: string; rows: Map<number, Map<number, ParsedCell>>; merges: MergeRange[]; }
interface MergeRange { startColumn: number; endColumn: number; startRow: number; endRow: number; }
interface ZipEntry { name: string; compressedSize: number; uncompressedSize: number; }

/**
 * Reads a bounded, non-macro .xlsx archive. The fflate package is deliberately
 * loaded only here so importing calendar helpers never loads workbook bytes.
 */
export async function parseWorkCalendarXlsx(
  fileName: string,
  bytes: Uint8Array,
  request: WorkCalendarImportRequest,
): Promise<WorkDateAssignment[]> {
  if (!/\.xlsx$/i.test(fileName) || /\.xlsm$/i.test(fileName)) throw new Error('Only .xlsx workbooks are accepted');
  validateRequest(request);
  const entries = preflightXlsxZip(bytes);
  let unzipSync: (data: Uint8Array) => Record<string, Uint8Array>;
  try {
    ({ unzipSync } = await import('fflate'));
  } catch {
    throw new Error('XLSX import support is unavailable');
  }

  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new Error('XLSX archive could not be safely decoded');
  }
  verifyUnzippedArchive(archive, entries);
  const workbook = decodeXml(requiredEntry(archive, 'xl/workbook.xml'));
  const rels = decodeXml(requiredEntry(archive, 'xl/_rels/workbook.xml.rels'));
  rejectForbiddenWorkbookContent(archive, workbook);
  const sharedStrings = archive['xl/sharedStrings.xml'] ? parseSharedStrings(decodeXml(archive['xl/sharedStrings.xml'])) : [];
  const relationships = parseRelationships(rels);
  const sheets = parseWorkbookSheets(workbook, relationships, archive, sharedStrings);
  const matchedSheets = sheets.filter((sheet) => [...sheet.rows.entries()].some(([rowNumber, row]) => rowMatches(sheet, rowNumber, row, request)));
  if (matchedSheets.length > 1) throw new Error('Person identifier is not unique in the workbook');
  if (matchedSheets.length === 0) throw new Error('Matching person and team row was not found');
  const assignments = matchedSheets.length === 1 ? assignmentsForSheet(matchedSheets[0], request) : [];
  // A date can appear in only one target row across sheets; ambiguity is safer
  // than silently selecting arbitrary imported sensitive data.
  const byDate = new Map<string, WorkDateAssignment>();
  for (const assignment of assignments) {
    const previous = byDate.get(assignment.date);
    if (previous && (previous.kind !== assignment.kind || previous.destinationLabel !== assignment.destinationLabel)) {
      throw new Error('Workbook contains conflicting assignments for one date');
    }
    byDate.set(assignment.date, assignment);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Exported for XML-only unit tests; it never accepts or returns raw workbook data. */
export function extractWorkAssignmentsFromWorksheetXml(
  sheetXml: string,
  request: WorkCalendarImportRequest,
): WorkDateAssignment[] {
  validateRequest(request);
  return assignmentsForSheet(parseWorksheet('sheet', sheetXml, []), request);
}

/** ZIP central-directory preflight prevents zip-bomb allocation before unzip. */
function preflightXlsxZip(bytes: Uint8Array): ReadonlyArray<ZipEntry> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_COMPRESSED_BYTES) throw new Error('XLSX file exceeds the compressed size limit');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0 || count > MAX_ZIP_ENTRIES || centralOffset + centralSize > eocd) throw new Error('Unsupported XLSX ZIP directory');

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid XLSX ZIP entry');
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || (flags & 0x1) !== 0 || ![0, 8].includes(compression) || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error('Unsupported XLSX ZIP entry');
    const name = decodeZipName(bytes.subarray(offset + 46, offset + 46 + nameLength), flags);
    if (!isSafeZipName(name) || forbiddenArchivePath(name)) throw new Error('XLSX contains a prohibited archive entry');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error('XLSX exceeds the uncompressed size limit');
    entries.push({ name, compressedSize, uncompressedSize });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw new Error('Malformed XLSX ZIP directory');
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  for (let offset = view.byteLength - 22; offset >= Math.max(0, view.byteLength - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === view.byteLength) return offset;
  }
  throw new Error('XLSX ZIP end record is missing');
}

function verifyUnzippedArchive(archive: Record<string, Uint8Array>, entries: ReadonlyArray<ZipEntry>): void {
  let total = 0;
  const declared = new Map(entries.map((entry) => [entry.name, entry]));
  for (const [name, value] of Object.entries(archive)) {
    const entry = declared.get(name);
    if (!entry || value.byteLength !== entry.uncompressedSize) throw new Error('XLSX archive contents do not match its directory');
    total += value.byteLength;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('XLSX exceeds the uncompressed size limit');
  }
  if (!archive['[Content_Types].xml']) throw new Error('XLSX content types are missing');
}

function rejectForbiddenWorkbookContent(archive: Record<string, Uint8Array>, workbook: string): void {
  const contentTypes = decodeXml(requiredEntry(archive, '[Content_Types].xml'));
  const hasExternalRelationship = Object.entries(archive)
    .filter(([name]) => /\.rels$/i.test(name))
    .some(([, bytes]) => /TargetMode\s*=\s*["']External["']/i.test(decodeXml(bytes)));
  if (/macroenabled|vbaProject|externalLink/i.test(contentTypes) || hasExternalRelationship || /externalLink/i.test(workbook)) {
    throw new Error('XLSX macros or external links are not accepted');
  }
}

function parseWorkbookSheets(workbookXml: string, relationships: Map<string, string>, archive: Record<string, Uint8Array>, sharedStrings: string[]): ParsedSheet[] {
  const sheets: ParsedSheet[] = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/gi)) {
    const attributes = attributesOf(match[1]);
    const name = attributes.name;
    const relationId = attributes['r:id'];
    if (!name || !relationId) throw new Error('Workbook sheet metadata is invalid');
    const target = relationships.get(relationId);
    if (!target || !/^xl\/worksheets\/[^/]+\.xml$/i.test(target)) throw new Error('Workbook sheet relationship is invalid');
    sheets.push(parseWorksheet(name, decodeXml(requiredEntry(archive, target)), sharedStrings));
  }
  if (sheets.length === 0) throw new Error('Workbook contains no worksheets');
  return sheets;
}

function parseRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi)) {
    const attributes = attributesOf(match[1]);
    if (!attributes.Id || !attributes.Target || /TargetMode\s*=\s*["']External["']/i.test(match[0])) throw new Error('Workbook relationship is invalid');
    const target = `xl/${attributes.Target.replace(/^\/+/, '').replace(/^\.\//, '')}`.replace(/\/+/g, '/');
    if (target.includes('..') || forbiddenArchivePath(target)) throw new Error('Workbook relationship is invalid');
    relationships.set(attributes.Id, target);
  }
  return relationships;
}

function parseSharedStrings(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) values.push(textFromXml(match[1]));
  return values;
}

function parseWorksheet(name: string, xml: string, sharedStrings: string[]): ParsedSheet {
  const rows = new Map<number, Map<number, ParsedCell>>();
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    const rowNumber = Number(attributesOf(rowMatch[1]).r);
    if (!Number.isInteger(rowNumber) || rowNumber < 1) continue;
    const cells = new Map<number, ParsedCell>();
    // The reluctant attribute match is important: a greedy match can treat a
    // self-closing empty cell as an opening tag and swallow the next populated
    // cell, shifting an entire calendar header.
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi)) {
      const attributes = attributesOf(cellMatch[1]);
      const reference = attributes.r;
      const column = reference ? columnFromReference(reference) : NaN;
      if (!Number.isInteger(column)) continue;
      const body = cellMatch[2] ?? '';
      const formula = /<f\b/i.test(body);
      // Never evaluate formulas. Cached values already embedded in the XLSX
      // are plain input data, however, and operational workbooks commonly use
      // them for month headers. Reading that cache is safe and keeps the parser
      // compatible without launching Excel or resolving external references.
      const value = normalizeCellText(cellValue(attributes.t, body, sharedStrings));
      cells.set(column, { column, value, formula });
    }
    rows.set(rowNumber, cells);
  }
  const merges: MergeRange[] = [];
  for (const match of xml.matchAll(/<mergeCell\b([^>]*)\/?>(?:<\/mergeCell>)?/gi)) {
    const ref = attributesOf(match[1]).ref;
    const parsed = ref ? parseRange(ref) : undefined;
    if (parsed) merges.push(parsed);
  }
  return { name, rows, merges };
}

function assignmentsForSheet(sheet: ParsedSheet, request: WorkCalendarImportRequest): WorkDateAssignment[] {
  const matches = [...sheet.rows.entries()].filter(([rowNumber, row]) => rowMatches(sheet, rowNumber, row, request));
  if (matches.length > 1) throw new Error('Person identifier is not unique in a worksheet');
  if (matches.length === 0) return [];
  const [targetRowNumber] = matches[0];
  const headers = findHeaderPair(sheet, targetRowNumber);
  if (!headers) throw new Error('Calendar month and day headers were not found above the matching row');
  const result: WorkDateAssignment[] = [];
  for (const [column, day] of headers.days) {
    const month = headers.months.get(column);
    if (!month || !isCalendarDay(request.year, month, day)) continue;
    const raw = cellAt(sheet, targetRowNumber, column)?.value ?? '';
    const assignment = classifyCell(raw, dateFor(request.year, month, day));
    if (assignment) result.push(assignment);
  }
  return result;
}

function rowMatches(sheet: ParsedSheet, rowNumber: number, row: Map<number, ParsedCell>, request: WorkCalendarImportRequest): boolean {
  const candidateCells = new Map<string, ParsedCell>();
  for (const cell of row.values()) {
    if (!cell.formula) candidateCells.set(`${rowNumber}:${cell.column}`, cell);
  }
  // Person/group labels can be vertically merged. Include only anchors whose
  // merge covers this exact row, retaining their structural column.
  for (const merge of sheet.merges) {
    if (rowNumber < merge.startRow || rowNumber > merge.endRow) continue;
    const anchor = sheet.rows.get(merge.startRow)?.get(merge.startColumn);
    if (anchor && !anchor.formula) candidateCells.set(`${merge.startRow}:${merge.startColumn}`, anchor);
  }
  const person = normalizeMatch(request.person);
  const personCells = [...candidateCells.values()].filter((cell) => normalizeMatch(cell.value) === person);
  if (personCells.length !== 1) return false;
  if (!request.team) return true;

  // A group/team label is metadata to the left of the person identifier. Never
  // accept the same text from notes or date-assignment cells to its right.
  const personColumn = personCells[0].column;
  const team = normalizeMatch(request.team);
  const directGroupMatch = [...candidateCells.values()].some((cell) => cell.column < personColumn
    && personColumn - cell.column <= 16 && normalizeMatch(cell.value) === team);
  return directGroupMatch || inheritedGroupMatches(sheet, rowNumber, request.team, personColumn);
}

/**
 * Excel grouping columns often write a team once and leave every member row
 * below it blank. Treat that label as inherited only until the next non-empty
 * direct cell in the same column, so a previous group cannot bleed into the
 * next section.
 */
function inheritedGroupMatches(sheet: ParsedSheet, targetRow: number, expected: string, personColumn: number): boolean {
  const normalized = normalizeMatch(expected);
  const anchors: Array<{ row: number; column: number }> = [];
  for (const [rowNumber, row] of sheet.rows) {
    if (rowNumber >= targetRow || targetRow - rowNumber > 250) continue;
    for (const cell of row.values()) {
      if (!cell.formula && cell.column < personColumn && personColumn - cell.column <= 16
        && normalizeMatch(cell.value) === normalized) anchors.push({ row: rowNumber, column: cell.column });
    }
  }
  return anchors.some((anchor) => {
    for (let rowNumber = anchor.row + 1; rowNumber <= targetRow; rowNumber++) {
      const next = sheet.rows.get(rowNumber)?.get(anchor.column);
      if (next && !next.formula && normalizeMatch(next.value)) return false;
    }
    return true;
  });
}

function findHeaderPair(sheet: ParsedSheet, targetRow: number): { months: Map<number, number>; days: Map<number, number> } | undefined {
  const rowNumbers = [...sheet.rows.keys()].filter((row) => row < targetRow).sort((a, b) => b - a);
  for (const dayRow of rowNumbers) {
    const monthRow = dayRow - 1;
    const days = new Map<number, number>();
    for (const column of sheet.rows.get(dayRow)?.keys() ?? []) {
      const day = Number(cellAt(sheet, dayRow, column)?.value.trim());
      if (Number.isInteger(day) && day >= 1 && day <= 31) days.set(column, day);
    }
    if (days.size === 0 || !sheet.rows.has(monthRow)) continue;
    // Many operational workbooks put the month only in the first date column
    // ("center across selection") instead of a real merged cell. Carry that
    // marker forward across numeric day columns; summary columns have no valid
    // day and are therefore never accepted below.
    const months = new Map<number, number>();
    const orderedDayColumns = [...days.keys()].sort((a, b) => a - b);
    let currentMonth: number | undefined;
    const firstColumn = orderedDayColumns[0];
    const lastColumn = orderedDayColumns.at(-1) ?? firstColumn;
    for (let column = firstColumn; column <= lastColumn; column++) {
      // A month marker must align with day 1. Operational sheets often keep
      // other small numeric summaries on the month row; accepting those as a
      // month would silently shift every following date.
      const marker = days.get(column) === 1 ? parseMonth(cellAt(sheet, monthRow, column)?.value ?? '') : undefined;
      if (marker) currentMonth = marker;
      if (days.has(column) && currentMonth) months.set(column, currentMonth);
    }
    const acceptedColumns = calendarHeaderColumns(months, days);
    if (acceptedColumns.size >= MIN_HEADER_DAY_COLUMNS) {
      return {
        months: new Map([...months].filter(([column]) => acceptedColumns.has(column))),
        days: new Map([...days].filter(([column]) => acceptedColumns.has(column))),
      };
    }
  }
  return undefined;
}

function calendarHeaderColumns(months: Map<number, number>, days: Map<number, number>): Set<number> {
  const columns = [...days.keys()].sort((a, b) => a - b);
  const accepted = new Set<number>();
  let runStart = 0;
  for (let index = 1; index <= columns.length; index++) {
    const previous = columns[index - 1];
    const current = columns[index];
    const continuous = index < columns.length
      && current === previous + 1
      && months.get(current) === months.get(previous)
      && days.get(current) === (days.get(previous) ?? 0) + 1;
    if (continuous) continue;
    const first = columns[runStart];
    const length = index - runStart;
    if (length >= MIN_HEADER_DAY_COLUMNS && days.get(first) === 1 && months.get(first) !== undefined) {
      for (let runIndex = runStart; runIndex < index; runIndex++) accepted.add(columns[runIndex]);
    }
    runStart = index;
  }
  return accepted;
}

function classifyCell(value: string, date: string): WorkDateAssignment | undefined {
  const label = value;
  if (!label || label === '0' || /^(?:off|x|-|—|휴무|비번|휴가)$/i.test(label)) return { date, kind: 'off' };
  return { date, kind: 'onsite', destinationLabel: label.slice(0, 160) };
}

/**
 * Excel permits tabs and line breaks in text cells, which are harmless once
 * collapsed to an ordinary space. Other C0/C1 controls are neither meaningful
 * schedule text nor valid protected-state text, so reject them before any
 * derived assignment can reach encrypted storage.
 */
function normalizeCellText(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error('XLSX cell contains unsupported control characters');
  }
  return value.trim().replace(/\s+/g, ' ');
}

function cellAt(sheet: ParsedSheet, row: number, column: number): ParsedCell | undefined {
  const direct = sheet.rows.get(row)?.get(column);
  if (direct) return direct;
  for (const merge of sheet.merges) {
    if (row >= merge.startRow && row <= merge.endRow && column >= merge.startColumn && column <= merge.endColumn) return sheet.rows.get(merge.startRow)?.get(merge.startColumn);
  }
  return undefined;
}

function cellValue(type: string | undefined, body: string, sharedStrings: string[]): string {
  if (type === 'inlineStr') return textFromXml(body);
  const value = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? '';
  if (type === 's') {
    const index = Number(value.trim());
    return Number.isInteger(index) && index >= 0 ? sharedStrings[index] ?? '' : '';
  }
  return decodeEntities(value.replace(/<[^>]*>/g, ''));
}

function textFromXml(xml: string): string {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((match) => decodeEntities(match[1].replace(/<[^>]*>/g, ''))).join('');
}

function decodeXml(bytes: Uint8Array): string {
  let xml: string;
  try { xml = decoder.decode(bytes); } catch { throw new Error('Workbook XML is not UTF-8'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Workbook XML declarations are not accepted');
  return xml;
}

function requiredEntry(archive: Record<string, Uint8Array>, name: string): Uint8Array {
  const entry = archive[name];
  if (!entry) throw new Error('Required XLSX component is missing');
  return entry;
}

function attributesOf(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attributes[match[1]] = decodeEntities(match[3]);
  return attributes;
}

function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return entities[entity] ?? '';
  });
}

function columnFromReference(reference: string): number {
  const match = reference.match(/^([A-Z]+)\d+$/i);
  if (!match) return Number.NaN;
  return [...match[1].toUpperCase()].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
}

function parseRange(ref: string): MergeRange | undefined {
  const [first, last] = ref.split(':');
  const start = first.match(/^([A-Z]+)(\d+)$/i);
  const end = (last ?? first).match(/^([A-Z]+)(\d+)$/i);
  if (!start || !end) return undefined;
  const startColumn = columnFromReference(first);
  const endColumn = columnFromReference(last ?? first);
  const startRow = Number(start[2]);
  const endRow = Number(end[2]);
  return startColumn <= endColumn && startRow <= endRow ? { startColumn, endColumn, startRow, endRow } : undefined;
}

function parseMonth(value: string): number | undefined {
  const match = value.trim().match(/^(?:([1-9]|1[0-2])\s*월?|([1-9]|1[0-2]))$/);
  const month = Number(match?.[1] ?? match?.[2]);
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : undefined;
}

function normalizeMatch(value: string): string { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US'); }
function isCalendarDay(year: number, month: number, day: number): boolean { return day <= new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function dateFor(year: number, month: number, day: number): string { return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
function validateRequest(request: WorkCalendarImportRequest): void {
  if (!normalizeMatch(request.person) || (request.team !== undefined && !normalizeMatch(request.team)) || !Number.isInteger(request.year) || request.year < 1900 || request.year > 2200) throw new Error('Invalid work-calendar import request');
}
function decodeZipName(bytes: Uint8Array, flags: number): string { return new TextDecoder((flags & 0x800) ? 'utf-8' : 'utf-8', { fatal: true }).decode(bytes); }
function isSafeZipName(name: string): boolean { return !!name && !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..') && !name.includes('\0'); }
function forbiddenArchivePath(name: string): boolean { return /(?:^|\/)(?:vbaProject|macros?|externalLinks?)(?:\/|\.|$)/i.test(name); }
