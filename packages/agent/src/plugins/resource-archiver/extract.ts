import { posix } from 'node:path';
import { canonicalResourceUrl } from './security.js';

const HTML_MIME = /^(?:text\/html|application\/xhtml\+xml)$/i;
const CSS_MIME = /^text\/css$/i;
const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
export const MAX_REWRITE_BYTES = 2 * 1024 * 1024;
// Bounded tokens keep malformed or adversarial multi-megabyte text from
// turning dependency discovery into an unbounded regular-expression scan.
const RESOURCE_TAG = /<(script|img|source|video|audio|iframe|embed|object|input|link)\b[^>]{0,16384}>/gi;
const ATTRIBUTE = /\b(src|href|poster|data|srcset|style)\s*=\s*(?:"([^"]{0,4096})"|'([^']{0,4096})'|([^\s"'=<>`]{1,4096}))/gi;
const STYLE_BLOCK = /<style\b[^>]{0,4096}>([\s\S]{0,2097152}?)<\/style\s*>/gi;
const BASE_TAG = /<base\b[^>]{0,4096}>/i;
const CSS_REFERENCE = /url\(\s*(?:"([^"]{0,4096})"|'([^']{0,4096})'|([^)'"\s][^)]{0,4095}?))\s*\)|@import\s+(?:url\(\s*)?(?:"([^"]{0,4096})"|'([^']{0,4096})'|([^\s;)'"\s]{1,4096}))/gi;

export function isHtml(mimeType: string, url: string): boolean {
  return HTML_MIME.test(mimeType) || (!mimeType && /\.(?:html?|xhtml)(?:$|[?#])/i.test(url));
}

export function isCss(mimeType: string, url: string): boolean {
  return CSS_MIME.test(mimeType) || (!mimeType && /\.css(?:$|[?#])/i.test(url));
}

export function discoverReferences(body: Uint8Array, mimeType: string, ownerUrl: string, maxReferences: number): string[] {
  if (!isHtml(mimeType, ownerUrl) && !isCss(mimeType, ownerUrl)) return [];
  if (!Number.isInteger(maxReferences) || maxReferences < 0) throw new Error('maxReferences는 0 이상의 정수여야 합니다.');
  if (maxReferences === 0) return [];
  const text = new TextDecoder('utf-8', { fatal: false }).decode(body.subarray(0, MAX_DISCOVERY_BYTES));
  const discovered = new Set<string>();
  if (isCss(mimeType, ownerUrl)) {
    discoverCss(text, ownerUrl, discovered, maxReferences);
    return [...discovered];
  }

  const baseUrl = htmlBaseUrl(text, ownerUrl);
  for (const match of text.matchAll(RESOURCE_TAG)) {
    if (discovered.size >= maxReferences) break;
    const tagName = match[1].toLowerCase();
    const tag = match[0];
    const relation = tagName === 'link' ? attributeValue(tag, 'rel').toLowerCase() : '';
    for (const attr of tag.matchAll(ATTRIBUTE)) {
      const name = attr[1].toLowerCase();
      const value = decodeHtmlUrl(attr[2] ?? attr[3] ?? attr[4] ?? '');
      if (name === 'style') {
        discoverCss(value, baseUrl, discovered, maxReferences);
      } else if (name === 'srcset') {
        for (const candidate of splitSrcset(value)) {
          if (discovered.size >= maxReferences) break;
          addReference(candidate.url, baseUrl, discovered);
        }
      } else if (name !== 'href' || tagName !== 'link' || /(?:^|\s)(?:stylesheet|icon|preload|modulepreload|manifest)(?:\s|$)/i.test(relation)) {
        addReference(value, baseUrl, discovered);
      }
      if (discovered.size >= maxReferences) break;
    }
  }
  for (const match of text.matchAll(STYLE_BLOCK)) {
    if (discovered.size >= maxReferences) break;
    discoverCss(match[1], baseUrl, discovered, maxReferences);
  }
  return [...discovered];
}

export function rewriteResourceLinks(
  body: Uint8Array,
  mimeType: string,
  ownerUrl: string,
  ownerArchivePath: string,
  urlToArchivePath: ReadonlyMap<string, string>,
  maxOutputBytes: number,
): Uint8Array {
  if (!isHtml(mimeType, ownerUrl) && !isCss(mimeType, ownerUrl)) return body;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < body.byteLength) throw new Error('재작성 출력 바이트 한도가 원본보다 작습니다.');
  if (body.byteLength > MAX_REWRITE_BYTES) {
    throw new Error(`텍스트 링크 재작성 처리 한도 ${MAX_REWRITE_BYTES}바이트를 초과했습니다.`);
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
  const decodedBytes = Buffer.byteLength(text);
  if (decodedBytes > maxOutputBytes) throw new Error('UTF-8 재인코딩 결과가 출력 바이트 한도를 초과합니다.');
  const budget = new RewriteGrowthBudget(decodedBytes, maxOutputBytes);
  const rewrite = (raw: string, base: string): string => {
    const trimmed = decodeHtmlUrl(raw.trim());
    if (!isFetchableReference(trimmed)) return raw;
    try {
      const absolute = canonicalResourceUrl(trimmed, base);
      const target = urlToArchivePath.get(absolute);
      if (!target) return raw;
      const relative = posix.relative(posix.dirname(ownerArchivePath), target) || posix.basename(target);
      const fragment = safeFragment(trimmed, base);
      return `${relative}${fragment}`;
    } catch {
      return raw;
    }
  };

  if (isCss(mimeType, ownerUrl)) {
    const encoded = Buffer.from(rewriteCss(text, ownerUrl, rewrite, budget), 'utf8');
    if (encoded.byteLength > maxOutputBytes) throw new Error('재작성 결과가 출력 바이트 한도를 초과합니다.');
    return encoded;
  }

  const baseUrl = htmlBaseUrl(text, ownerUrl);
  let rewritten = text.replace(BASE_TAG, (tag) => budget.accept(tag, tag.replace(/\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, 'href="./"')));
  rewritten = rewritten.replace(RESOURCE_TAG, (tag, rawTagName: string) => {
    const tagName = rawTagName.toLowerCase();
    const relation = tagName === 'link' ? attributeValue(tag, 'rel').toLowerCase() : '';
    const candidate = tag.replace(ATTRIBUTE, (whole, rawName: string, double: string, single: string, bare: string) => {
      const name = rawName.toLowerCase();
      const value = double ?? single ?? bare ?? '';
      const quote = double !== undefined ? '"' : single !== undefined ? "'" : '"';
      let next = value;
      if (name === 'style') next = rewriteCss(value, baseUrl, rewrite);
      else if (name === 'srcset') next = splitSrcset(value).map((entry) => `${rewrite(entry.url, baseUrl)}${entry.descriptor ? ` ${entry.descriptor}` : ''}`).join(', ');
      else if (name !== 'href' || tagName !== 'link' || /(?:^|\s)(?:stylesheet|icon|preload|modulepreload|manifest)(?:\s|$)/i.test(relation)) next = rewrite(value, baseUrl);
      return `${rawName}=${quote}${next}${quote}`;
    });
    return budget.accept(tag, candidate);
  });
  rewritten = rewritten.replace(STYLE_BLOCK, (whole, css: string) => {
    const localBudget = new RewriteGrowthBudget(Buffer.byteLength(css), Buffer.byteLength(css) + budget.remainingGrowthBytes);
    return budget.accept(whole, whole.replace(css, rewriteCss(css, baseUrl, rewrite, localBudget)));
  });
  const encoded = Buffer.from(rewritten, 'utf8');
  if (encoded.byteLength > maxOutputBytes) throw new Error('재작성 결과가 출력 바이트 한도를 초과합니다.');
  return encoded;
}

function discoverCss(text: string, baseUrl: string, output: Set<string>, maxReferences: number): void {
  for (const match of text.matchAll(CSS_REFERENCE)) {
    if (output.size >= maxReferences) break;
    const value = match.slice(1).find((candidate) => candidate !== undefined) ?? '';
    addReference(value.trim(), baseUrl, output);
  }
}

function rewriteCss(
  text: string,
  baseUrl: string,
  rewrite: (raw: string, base: string) => string,
  budget?: RewriteGrowthBudget,
): string {
  return text.replace(CSS_REFERENCE, (whole, ...groups: unknown[]) => {
    const captures = groups.slice(0, 6) as Array<string | undefined>;
    const raw = captures.find((candidate) => candidate !== undefined);
    if (raw === undefined) return whole;
    const next = rewrite(raw.trim(), baseUrl);
    const candidate = whole.replace(raw, next);
    return budget ? budget.accept(whole, candidate) : candidate;
  });
}

class RewriteGrowthBudget {
  private remaining: number;

  constructor(initialBytes: number, maxOutputBytes: number) {
    this.remaining = maxOutputBytes - initialBytes;
  }

  get remainingGrowthBytes(): number {
    return this.remaining;
  }

  accept(original: string, replacement: string): string {
    const growth = Buffer.byteLength(replacement) - Buffer.byteLength(original);
    if (growth > this.remaining) throw new Error('재작성 결과가 출력 바이트 한도를 초과합니다.');
    this.remaining -= growth;
    return replacement;
  }
}

function addReference(raw: string, baseUrl: string, output: Set<string>): void {
  const value = decodeHtmlUrl(raw.trim());
  if (!isFetchableReference(value)) return;
  try {
    output.add(canonicalResourceUrl(value, baseUrl));
  } catch {
    // Malformed, credential-bearing, and non-web URLs are intentionally ignored.
  }
}

function isFetchableReference(value: string): boolean {
  return Boolean(value) && !value.startsWith('#') && !/^(?:data|blob|javascript|mailto|tel|about|chrome|file):/i.test(value);
}

function attributeValue(tag: string, wanted: string): string {
  const matcher = new RegExp(`\\b${wanted}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`, 'i');
  const match = matcher.exec(tag);
  return decodeHtmlUrl(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function htmlBaseUrl(html: string, ownerUrl: string): string {
  const tag = BASE_TAG.exec(html)?.[0];
  if (!tag) return ownerUrl;
  const href = attributeValue(tag, 'href');
  if (!href) return ownerUrl;
  try {
    return canonicalResourceUrl(href, ownerUrl);
  } catch {
    return ownerUrl;
  }
}

function decodeHtmlUrl(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&#x27;/gi, "'").replace(/&quot;/gi, '"');
}

function splitSrcset(value: string): Array<{ url: string; descriptor: string }> {
  return value.split(',').map((part) => {
    const trimmed = part.trim();
    const split = trimmed.search(/\s/);
    return split < 0 ? { url: trimmed, descriptor: '' } : { url: trimmed.slice(0, split), descriptor: trimmed.slice(split).trim() };
  }).filter((entry) => entry.url.length > 0);
}

function safeFragment(raw: string, base: string): string {
  try {
    const fragment = new URL(raw, base).hash;
    return /^[#A-Za-z0-9._~!$&'()*+,;=:@/?%-]{0,256}$/.test(fragment) ? fragment : '';
  } catch {
    return '';
  }
}
