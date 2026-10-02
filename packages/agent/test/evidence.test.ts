import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { runInNewContext } from 'node:vm';
import { createEvidenceTools, evidencePython, parsePythonOnly, needsSourceEvidence, namedPngSources, EVIDENCE_IMAGE_RENDER_EXAMPLE, EVIDENCE_TOOLS } from '../src/ai/evidence.js';
import { evidenceImageInputs } from '../src/ai/cli-isolated.js';
import { NativeToolEvents } from '../src/ai/native-tool-events.js';
import type { NativeToolEvent } from '../src/ai/provider.js';
import { evidenceContentBounds, evidenceReviewSheet } from '../src/ai/evidence-pixels.js';

const signal = () => new AbortController().signal;

test('Code Mode example renders every original/review image without swallowing metadata or printing base64', async () => {
  const source=new PNG({width:20,height:10});for(let i=0;i<source.data.length;i++)source.data[i]=i%251;
  const review=evidenceReviewSheet(source,[{x:3,y:2,width:5,height:4}])!;
  const urls=[PNG.sync.write(source),review.bytes].map(bytes=>`data:image/png;base64,${bytes.toString('base64')}`);
  const metadata=[JSON.stringify({source:'a.png',imageCount:2}),JSON.stringify({kind:'ocr-disagreement-original-pixels',regions:review.regions})];
  const contentItems=urls.flatMap((imageUrl,i)=>[{type:'inputText',text:metadata[i]},{type:'inputImage',imageUrl}]);
  for(const result of [metadata[0]+'\n'+urls[0]+'\n'+metadata[1]+'\n'+urls[1],{success:true,contentItems}]) {
    const emitted:string[]=[],textItems:string[]=[];
    await runInNewContext(`(async()=>{${EVIDENCE_IMAGE_RENDER_EXAMPLE}})()`,{
      tools:{evidence_image:async()=>result},image:(url:string)=>emitted.push(url),text:(s:string)=>textItems.push(s.trim()),
    },{timeout:1000});
    assert.deepEqual(emitted,urls);
    assert.deepEqual(textItems,metadata);
    assert.ok(!textItems.some(text=>text.includes('base64')));
    for(const [i,url] of emitted.entries())assert.deepEqual(PNG.sync.read(Buffer.from(url.split(',')[1],'base64')).data,i===0?source.data:PNG.sync.read(review.bytes).data);
  }
  const errors:string[]=[];
  await runInNewContext(`(async()=>{${EVIDENCE_IMAGE_RENDER_EXAMPLE}})()`,{
    tools:{evidence_image:async()=>'{"error":"Source changed"}'},image:()=>assert.fail('error is not an image'),text:(s:string)=>errors.push(s),
  },{timeout:1000});
  assert.equal(errors.length,1);
  assert.ok(EVIDENCE_TOOLS.find(t=>t.name==='evidence_image')!.description.includes(EVIDENCE_IMAGE_RENDER_EXAMPLE));
});

test('uncertain-word review sheet preserves original RGBA pixels and maps every enlarged region',()=>{
  const source=new PNG({width:20,height:10});for(let i=0;i<source.data.length;i++)source.data[i]=i%251;
  const boxes=[{x:2,y:1,width:4,height:3},{x:10,y:5,width:5,height:4}];
  const review=evidenceReviewSheet(source,boxes)!;const decoded=PNG.sync.read(review.bytes);
  assert.equal(review.regions.length,2);
  for(const r of review.regions)for(let y=0;y<r.sheet.height;y++)for(let x=0;x<r.sheet.width;x++){
    const a=((r.source.y+Math.floor(y/r.scale))*source.width+r.source.x+Math.floor(x/r.scale))*4;
    const b=((r.sheet.y+y)*decoded.width+r.sheet.x+x)*4;
    assert.deepEqual(decoded.data.subarray(b,b+4),source.data.subarray(a,a+4));
  }
  assert.equal(evidenceReviewSheet(source,[{x:-1,y:0,width:3,height:2}]),undefined);
});

test('uniform-margin trimming preserves every differing pixel and can be disabled', async () => {
  const root=mkdtempSync(join(tmpdir(),'mrrobot-margin-'));
  try {
    const png=new PNG({width:200,height:100});png.data.fill(255);
    assert.deepEqual(evidenceContentBounds(png),{x:0,y:0,width:200,height:100});
    for(let y=40;y<60;y++) for(let x=60;x<140;x++) png.data.fill(0,(y*200+x)*4,(y*200+x)*4+3);
    const box={x:48,y:28,width:104,height:44};
    assert.deepEqual(evidenceContentBounds(png),box);
    writeFileSync(join(root,'p.png'),PNG.sync.write(png));
    const tools=createEvidenceTools(root);
    const read=await tools.execute('evidence_image',{path:'p.png'},signal());
    const meta=JSON.parse((read.contentItems[0] as any).text);
    assert.deepEqual(meta.crop,box);assert.equal(meta.uniformMarginsRemoved,true);
    const decoded=PNG.sync.read(Buffer.from((read.contentItems[1] as any).imageUrl.split(',')[1],'base64'));
    for(let y=0;y<box.height;y++) assert.deepEqual(decoded.data.subarray(y*box.width*4,(y+1)*box.width*4),png.data.subarray(((y+box.y)*200+box.x)*4,((y+box.y)*200+box.x+box.width)*4));
    const full=await tools.execute('evidence_image',{path:'p.png',trim:false},signal());
    assert.equal(JSON.parse((full.contentItems[0] as any).text).uniformMarginsRemoved,false);
    const explicit=await tools.execute('evidence_image',{path:'p.png',crop:{x:0,y:0,width:200,height:100}},signal());
    assert.equal(JSON.parse((explicit.contentItems[0] as any).text).displayWidth,200);
    png.data[0]=0;
    assert.deepEqual(evidenceContentBounds(png),{x:0,y:0,width:200,height:100});
    await assert.rejects(tools.execute('evidence_image',{path:'p.png',trim:'yes'},signal()),/trim/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('native lifecycle counts once, handles missing start, rejects raw reasoning and never exposes payloads', () => {
  let now = 10;
  const events: NativeToolEvent[] = [];
  const tracker = new NativeToolEvents(e => events.push(e), () => now);
  tracker.accept('item/started', { id: 'a', type: 'commandExecution', command: 'PRIVATE_SECRET' });
  tracker.accept('item/started', { id: 'a', type: 'commandExecution' });
  now = 30;
  tracker.accept('item/completed', { id: 'a', type: 'commandExecution', exitCode: 1, output: 'PRIVATE_SECRET' });
  tracker.accept('item/completed', { id: 'a', type: 'commandExecution' });
  tracker.accept('item/completed', { id: 'b', type: 'imageView', path: 'PRIVATE_SECRET' });
  tracker.accept('item/started', { id: 'r', type: 'reasoning', text: 'PRIVATE_SECRET' });
  tracker.accept('item/started', { id: 'p', type: 'constructor' });
  tracker.accept('item/started', { id: 'c', type: 'dynamicToolCall', arguments: 'PRIVATE_SECRET' });
  tracker.finish(); tracker.finish();
  assert.deepEqual(events.map(e => e.status), ['start', 'error', 'start', 'done', 'start', 'error']);
  assert.equal(events[1].elapsedMs, 20);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_SECRET'));
  const disconnected = new NativeToolEvents(() => { throw new Error('disconnected'); });
  assert.doesNotThrow(() => { disconnected.accept('item/started', { id: 'x', type: 'imageView' }); disconnected.finish(); });
});

test('workspace evidence is identity-bound, pixel-exact, bounded and read-only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrrobot-evidence-'));
  try {
    const png = new PNG({ width: 8, height: 4 });
    for (let i = 0; i < png.data.length; i++) png.data[i] = i % 256;
    writeFileSync(join(root, 'a.png'), PNG.sync.write(png));
    writeFileSync(join(root, 'b.png'), PNG.sync.write(png));
    const interlaced = PNG.sync.write(png); interlaced[28] = 1;
    writeFileSync(join(root, 'interlaced.png'), interlaced);
    assert.deepEqual(namedPngSources(root, 'a.png와 "b.png"를 비교. https://example.com/a.png ../private.png'), ['a.png', 'b.png']);
    const scoped = createEvidenceTools(root, ['a.png']);
    await assert.rejects(scoped.execute('evidence_image', { path: 'b.png' }, signal()), /assigned/);
    const tool = createEvidenceTools(root);
    await assert.rejects(tool.execute('evidence_image', { path: 'interlaced.png' }, signal()), /Interlaced PNG/);
    const oldPython = process.env.MR_ROBOT_PYTHON;
    try {
      const fake = join(root, 'python.exe'); writeFileSync(fake, 'not executable');
      process.env.MR_ROBOT_PYTHON = fake;
      assert.notEqual(evidencePython(root), fake, 'model-writable interpreter must never run on host');
    } finally { if (oldPython === undefined) delete process.env.MR_ROBOT_PYTHON; else process.env.MR_ROBOT_PYTHON = oldPython; }
    const result = await tool.execute('evidence_image', { path: 'a.png', crop: { x: 2, y: 1, width: 3, height: 2 } }, signal());
    const meta = JSON.parse((result.contentItems[0] as any).text);
    assert.equal(meta.source, 'a.png'); assert.equal(meta.width, 8); assert.equal(meta.height, 4);
    assert.match(meta.sha256, /^[a-f0-9]{64}$/);
    const decoded = PNG.sync.read(Buffer.from((result.contentItems[1] as any).imageUrl.split(',')[1], 'base64'));
    for (let y = 0; y < 2; y++) assert.deepEqual(decoded.data.subarray(y * 12, (y + 1) * 12), png.data.subarray(((y + 1) * 8 + 2) * 4, ((y + 1) * 8 + 5) * 4));
    const zoom = await tool.execute('evidence_image', { path:'a.png', crop:{x:2,y:1,width:3,height:2}, scale:3 }, signal());
    const pixels = PNG.sync.read(Buffer.from((zoom.contentItems[1] as any).imageUrl.split(',')[1], 'base64'));
    assert.equal(pixels.width, 9); assert.equal(pixels.height, 6);
    for (let y=0; y<6; y++) for (let x=0; x<9; x++) {
      const src=(Math.floor(y/3)*3+Math.floor(x/3))*4, dst=(y*9+x)*4;
      assert.deepEqual(pixels.data.subarray(dst,dst+4), decoded.data.subarray(src,src+4));
    }
    assert.equal(JSON.parse((zoom.contentItems[0] as any).text).sha256,meta.sha256);
    await assert.rejects(tool.execute('evidence_image', {path:'a.png',scale:99},signal()), /bound/);
    await assert.rejects(tool.execute('evidence_image', { path: 'a.png', expectedSha256: '0'.repeat(64) }, signal()), /hash changed/);
    await assert.rejects(tool.execute('evidence_image', { path: 'a.png', crop: { x: 0, y: 0, width: 9, height: 4 } }, signal()), /Crop/);
    await assert.rejects(tool.execute('evidence_image', { path: '../outside.png' }, signal()), /밖/);
    await assert.rejects(tool.execute('shell_exec', { path: 'a.png' }, signal()), /Unknown/);
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(32769));
    await assert.rejects(tool.execute('evidence_text', { path: 'big.txt' }, signal()), /too large/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(tool.execute('evidence_image', { path: 'a.png' }, controller.signal));
    assert.equal(tool.authorize!('evidence_image', 'ask'), false);
    assert.equal(tool.authorize!('evidence_image', 'read-only'), true);
    const nested = join(root, 'link');
    symlinkSync(tmpdir(), nested, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(tool.execute('evidence_text', { path: 'link/secret' }, signal()), /junction|심볼릭/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('python checker compiles DATA only; refuses malformed input without executing side effects', async t => {
  const executable = evidencePython();
  if (!executable) { t.skip('CPython not installed'); return; }
  const root = mkdtempSync(join(tmpdir(), 'mrrobot-syntax-'));
  try {
    const marker = join(root, 'must-not-exist');
    const tool = createEvidenceTools(root);
    const good = await tool.execute('evidence_python_syntax', { source: `open(${JSON.stringify(marker)}, 'w').write('danger')\n` }, signal());
    const parsed = JSON.parse((good.contentItems[0] as any).text);
    assert.equal(parsed.syntaxValid, true); assert.equal(parsed.executed, false);
    assert.equal(existsSync(marker), false);
    const bad = await parsePythonOnly(Buffer.from('open;;open'), executable, signal()) as any;
    assert.equal(bad.syntaxValid, false); assert.equal(bad.line, 1);
    const valid = await parsePythonOnly(Buffer.from('open;open;8**8\n8//8'), executable, signal()) as any;
    assert.equal(valid.syntaxValid, true);
    const missing = await parsePythonOnly(Buffer.from('x'), undefined, signal()) as any;
    assert.equal(missing.available, false); assert.equal(missing.syntaxValid, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('visual transport rejects URLs, overflow, and preserves source labels', () => {
  const req = { turns: [], evidenceImages: [{ label: 'a.png hash', dataUrl: 'data:image/png;base64,YWJj' }] };
  assert.equal(evidenceImageInputs(req)[1].type, 'image');
  assert.throws(() => evidenceImageInputs({ ...req, evidenceImages: [{ label: 'a', dataUrl: 'https://example.com/private' }] }));
  assert.throws(() => evidenceImageInputs({ ...req, evidenceImages: Array(5).fill(req.evidenceImages[0]) }));
  assert.equal(needsSourceEvidence('read tablet.png'), true);
  assert.equal(needsSourceEvidence('hello'), false);
});

test('pure-value checker retains assignment order, slices and exact character arithmetic', async t => {
  if (!evidencePython()) { t.skip('CPython not installed'); return; }
  const root = mkdtempSync(join(tmpdir(), 'mrrobot-values-'));
  try {
    const tools = createEvidenceTools(root);
    const result = await tools.execute('evidence_python_values', { source: 'x="discard"; x="C"\nx+=chr(79); x+="DE"\ny=x[::-1]\nn=(17^3)+len(x)\nx[1:3]' }, signal());
    const data = JSON.parse((result.contentItems[0] as any).text);
    assert.equal(data.verified, true); assert.equal(data.originalExecuted, false);
    assert.deepEqual(data.values, { x:'CODE', y:'EDOC', n:22 });
    assert.deepEqual(data.trace.map((s:any)=>s.value), ['discard','C','CO','CODE','EDOC',22,'OD']);
    assert.equal(data.trace[0].line, 1); assert.equal(data.trace[1].line, 1);
    assert.match(data.sha256, /^[a-f0-9]{64}$/);
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test('pure-value checker refuses effects, dynamic execution, shadowed calls and resource bombs', async t => {
  if (!evidencePython()) { t.skip('CPython not installed'); return; }
  const root = mkdtempSync(join(tmpdir(), 'mrrobot-values-deny-'));
  try {
    const tools = createEvidenceTools(root), marker=join(root, 'must-not-exist');
    for (const source of [
      `open(${JSON.stringify(marker)},'w').write('no')`, 'import os', '__import__("os")',
      'eval("1+1")', 'exec("pass")', 'x=(1).__class__', 'x=[x for x in range(100)]',
      'while True: pass', 'x=2**999999', 'x="a"*999999999', 'x=1<<999999',
      'x="abc"[::0]', 'chr="shadow"; x=chr(65)', 'x="a"*4096\ny=x*4096',
      Array(8).fill('x="a"*4096').join('\n'), Array(129).fill('x=1').join('\n'),
    ]) {
      const result = await tools.execute('evidence_python_values', {source}, signal());
      const data=JSON.parse((result.contentItems[0] as any).text);
      assert.equal(data.verified, false, source); assert.equal(data.originalExecuted, false);
      assert.equal(data.values, undefined, 'partial evaluations must not look verified');
    }
    assert.equal(existsSync(marker), false);
    const unsupported = await tools.execute('evidence_python_values', {source:'import os'},signal());
    assert.equal(JSON.parse((unsupported.contentItems[0] as any).text).reason, 'unsupported_statement');
    await assert.rejects(tools.execute('evidence_python_values', {path:'a.py'},signal()), /source text only/);
    await assert.rejects(tools.execute('evidence_python_values', {source:' '.repeat(8193)},signal()), /size bound/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(tools.execute('evidence_python_values', {source:'x=1'},aborted.signal));
  } finally { rmSync(root, {recursive:true,force:true}); }
});
