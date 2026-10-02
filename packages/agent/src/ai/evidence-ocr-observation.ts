import type { OcrObservation } from './evidence-ocr.js';

/** Known-disputed OCR tokens must not become an answer-looking transcript.
 * Keep original pixels/coordinates authoritative and allow explicit inspection
 * of both raw hypotheses; this does not select either OCR pass as correct.
 */
export function evidenceOcrObservation(ocr: OcrObservation | undefined, includeHypotheses = false) {
  if (!ocr?.available || !ocr.disagreements?.length || includeHypotheses) return ocr;
  const disputed = ocr.disagreements.map((d, index) => ({...d, marker:`[uncertain-region-${index + 1}]`}));
  const ordered = [...disputed].filter(d=>d.text.trim()).sort((a,b)=>b.text.length-a.text.length);
  const pattern = ordered.map(d=>'('+d.text.trim().split(/\s+/).map(token=>token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+')+')').join('|');
  // One replacement pass: a short disputed token must not rewrite markers or
  // swallow a longer disputed token before it can be identified.
  const mask = (text: string) => pattern ? text.replace(new RegExp(pattern,'g'),(...args)=>
    ordered[args.slice(1,1+ordered.length).findIndex(value=>value!==undefined)].marker) : text;
  return {
    ...ocr,
    text: ocr.text === undefined ? undefined : mask(ocr.text),
    lines: ocr.lines?.map(line=>({...line,text:mask(line.text)})),
    disagreements: disputed.map(({marker,box})=>({marker,box})),
    rawHypothesesOmitted: true,
    notice: 'Known-disputed OCR tokens are replaced by uncertainty markers, not corrected text. Read the matching original-pixel review region before using it. Other OCR text is also unverified. Set ocrHypotheses:true only to compare both raw fallible hypotheses after visual inspection.',
  };
}
