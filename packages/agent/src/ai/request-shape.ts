import type { Turn } from './provider.js';

/** Recognize only self-contained inline text transformations. This is capability
 * reduction, not a model selector or a reasoning-quality classifier. */
export function isInlineTextTask(text: string): boolean {
  if (text.length > 16_000) return false;
  const separator = text.search(/[:：]/u);
  if (separator < 1 || separator > 240) return false;
  const instruction = text.slice(0, separator).trim();
  const payload = text.slice(separator + 1).trim();
  if (!payload || /^(?:https?:\/\/\S+|[A-Za-z]:[\\/].*|\/[^\s]+)$/i.test(payload)) return false;
  if (/파일|저장|첨부|링크|페이지|검색|웹|인터넷|최신|실시간|실행|업로드|다운로드|수정하고|적용|컴퓨터|프로젝트|폴더|\b(?:file|save|attach|url|link|page|search|browse|latest|current|execute|run|upload|download|project|folder|send)\b/i.test(instruction)) return false;
  return /^(?:다음|아래|이)\s*(?:문장|텍스트|글|내용|문구)[\s\S]*(?:번역|요약|교정|다듬|분류|추출)/u.test(instruction)
    || /^(?:translate|summarize|rewrite|proofread|classify|extract)\b/i.test(instruction);
}

/** Explicitly in-conversation recall/summarization can use the same text lane.
 * Do not treat generic follow-ups, other sessions, files or actions as recall. */
export function isTextOnlyTask(text: string, history: readonly Turn[]): boolean {
  if (isInlineTextTask(text)) return true;
  if (!history.length || text.length > 2000) return false;
  if (/파일|첨부|이미지|사진|저장|검색|웹|인터넷|최신|실행|업로드|다운로드|방문|수정|적용|작업|컴퓨터|프로젝트|폴더|열어|\b(?:file|attachment|image|save|search|browse|web|latest|execute|run|upload|download|modify|project|folder|open)\b/i.test(text)) return false;
  return /^(?:이|현재|우리|지금까지의|위)\s*대화(?:에서|의|를|는|에|\s)[\s\S]*(?:요약|정리|뭐|무엇|말했|말한|알려|기억|다시)/u.test(text.trim())
    || /^(?:(?:summarize|recap) (?:this|our) (?:conversation|chat)|(?:what|which)[\s\S]*\bin (?:this|our) (?:conversation|chat))\b/i.test(text.trim());
}
