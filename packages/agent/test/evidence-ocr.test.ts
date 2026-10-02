import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeOcr, closeEvidenceOcr } from '../src/ai/evidence-ocr.js';
import { createEvidenceTools } from '../src/ai/evidence.js';

test('offline OCR reports independent, fallible text and can be reused without learning across requests', {timeout:30000}, async t => {
  t.after(closeEvidenceOcr);
  // Owned synthetic fixture. No external task image, answer key or user file.
  const png=await sharp(Buffer.from('<svg width="700" height="160"><rect width="100%" height="100%" fill="white"/><text x="20" y="70" fill="black" font-family="monospace" font-size="36">return total + 123</text></svg>')).png().toBuffer();
  for(let i=0;i<2;i++) {
    const result=await observeOcr(png,new AbortController().signal);
    assert.equal(result.available,true);assert.equal(result.verified,false);
    assert.match(result.text!,/return total \+ 123/);assert.ok(result.lines!.length>0);
    assert.ok(Buffer.byteLength(JSON.stringify(result))<26000);
  }
  const root=mkdtempSync(join(tmpdir(),'mrrobot-ocr-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'sample.png'),png);
  const tools=createEvidenceTools(root,['sample.png']);t.after(()=>tools.dispose?.());
  const first=await tools.execute('evidence_image',{path:'sample.png',trim:false},new AbortController().signal);
  const meta=JSON.parse((first.contentItems[0] as any).text);
  assert.equal(meta.ocr.available,true);assert.equal(meta.ocr.verified,false);
  assert.match(meta.ocr.text,/return total/);
  const cached=await tools.execute('evidence_image',{path:'sample.png',trim:false},new AbortController().signal);
  assert.deepEqual(JSON.parse((cached.contentItems[0] as any).text).ocr,meta.ocr);
  const disabled=await tools.execute('evidence_image',{path:'sample.png',ocr:false},new AbortController().signal);
  assert.equal(JSON.parse((disabled.contentItems[0] as any).text).ocr,undefined);
  await assert.rejects(tools.execute('evidence_image',{path:'sample.png',ocr:'yes'},new AbortController().signal),/OCR/);
});

test('invalid, oversized and cancelled OCR calls retire safely; no third concurrent worker', {timeout:30000}, async t => {
  t.after(closeEvidenceOcr);
  assert.equal((await observeOcr(Buffer.alloc(8*1024*1024+1),new AbortController().signal)).available,false);
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(observeOcr(Buffer.alloc(0),aborted.signal));
  const controller=new AbortController();
  const one=observeOcr(Buffer.alloc(10),controller.signal);
  const two=observeOcr(Buffer.alloc(10),controller.signal);
  assert.equal((await observeOcr(Buffer.alloc(10),controller.signal)).reason,'busy');
  controller.abort();
  assert.equal((await one).reason,'cancelled');assert.equal((await two).reason,'cancelled');
  await closeEvidenceOcr();
  assert.equal((await observeOcr(Buffer.alloc(10),new AbortController().signal)).reason,'unavailable');
});
