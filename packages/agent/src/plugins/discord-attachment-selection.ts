import type { StoredAttachment } from '../server/discord-attachment-store.js';

const audio = /\.(wav|mp3|m4a|aac|ogg|opus|flac|webm|wma|mp4)$/i;
/** Selection is made from the USER message, never extracted document instructions.
 * Focus IDs belong to one ticket/access key. No inventory-order assumptions. */
export function selectDiscordAttachments(text: string, files: StoredAttachment[], uploaded: string[], focused: string[] = []) {
  const byIds = (ids: string[]) => files.filter(f => ids.includes(f.id));
  const latest = (items: StoredAttachment[]) => [...items].sort((a, b) => b.expiresAt - a.expiresAt || a.id.localeCompare(b.id)).slice(0, 1);
  const input = text.normalize('NFKC').toLowerCase();
  if (uploaded.length) return { files: byIds(uploaded), reason: 'uploaded', remember: true };
  const named = files.filter(f => input.includes(f.name.normalize('NFKC').toLowerCase()) || input.includes(f.id));
  if (named.length) return { files: named, reason: 'named', remember: true };
  // "내용 다 출력" is NOT a request for every historic attachment.
  if (/(?:모든|전체|전부|모두)\s*(?:첨부|파일)|(?:첨부|파일)(?:들)?\s*(?:을|를|의)?\s*(?:모두|전부|전체)|\ball\s+(?:files|attachments)\b/i.test(input)) {
    return { files, reason: 'all', remember: false };
  }
  const kinds: Array<(f: StoredAttachment) => boolean> = [];
  if (/음성|녹음|오디오|\b(?:audio|wav|mp3|recording)\b/i.test(input)) kinds.push(f => audio.test(f.name));
  if (/\bpdf\b/i.test(input)) kinds.push(f => /\.pdf$/i.test(f.name));
  if (kinds.length) {
    const matching = files.filter(f => kinds.some(kind => kind(f)));
    const focus = byIds(focused).filter(f => matching.some(m => m.id === f.id));
    return { files: focus.length ? focus : latest(matching), reason: 'kind', remember: true };
  }
  if (/첨부|파일|내용|분석|핵심|요약|평문|원문|텍스트|전사|읽어|읽고|추출|번역|정리|이거|이것|\b(?:summari[sz]e|transcri\w*|extract|attachment|this file)\b/i.test(input)) {
    const focus = byIds(focused);
    // Old versions copied all attachments at recovery time, losing original
    // chronology. Do not guess when multiple legacy files have the same time.
    const newest = latest(files);
    const ambiguous = !focus.length && newest.length && files.filter(f => Math.abs(f.expiresAt - newest[0]!.expiresAt) < 2000).length > 1;
    return { files: ambiguous ? [] : focus.length ? focus : newest, reason: ambiguous ? 'ambiguous' : 'focused', remember: false };
  }
  return { files: [], reason: 'none', remember: false };
}
