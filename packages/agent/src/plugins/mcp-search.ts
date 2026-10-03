/** Local lexical ranking only: no model request, embeddings, or extra server
 * capabilities. Descriptions remain untrusted data, never instructions. */
export function validateMcpSearchQuery(query: unknown): string {
  if (typeof query !== 'string' || query.length > 256 || !query.trim()
    || !/[\p{L}\p{N}]/u.test(query)) throw new Error('MCP 검색어는 1~256자의 문자 또는 숫자를 포함해야 합니다.');
  return query.trim();
}

function words(value: string): string[] {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function mcpToolSearchScore(query: string, tool: { name: string; description?: string }): number {
  const terms = [...new Set(words(query))].slice(0, 12);
  if (!terms.length) return 0;
  const name = words(tool.name).join(' ');
  const nameWords = new Set(name.split(' '));
  const description = words((tool.description ?? '').slice(0, 4000)).join(' ');
  let matched = 0, score = 0;
  for (const term of terms) {
    if (nameWords.has(term)) { score += 4; matched++; }
    else if (name.includes(term)) { score += 2; matched++; }
    else if (description.includes(term)) { score++; matched++; }
  }
  if (matched === terms.length) score += 4;
  if (name === terms.join(' ')) score += 8;
  return matched ? score : 0;
}
