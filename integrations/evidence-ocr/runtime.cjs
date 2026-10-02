'use strict';
// Fixed offline OCR worker. Input is bounded PNG bytes, never paths or commands.
const {parentPort}=require('node:worker_threads');
const {createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const {join,dirname}=require('node:path');
const {createWorker,PSM}=require('tesseract.js');
const {PNG}=require('pngjs');
const unavailable={available:false,engine:'tesseract-local-eng',verified:false,reason:'unavailable'};
let engine,active=false;
parentPort.on('message',async ({id,bytes})=>{
 if(active){parentPort.postMessage({id,result:{...unavailable,reason:'busy'}});return;}
 active=true;
 try {
  const png=Buffer.from(bytes);
  if(png.length>8*1024*1024||png.length<33||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.toString('ascii',12,16)!=='IHDR'||png[28]!==0||!png.readUInt32BE(16)||!png.readUInt32BE(20)||png.readUInt32BE(16)*png.readUInt32BE(20)>8000000)throw Error('input');
  if(!engine) {
   const langPath=join(dirname(require.resolve('@tesseract.js-data/eng')),'4.0.0');
   const data=readFileSync(join(langPath,'eng.traineddata.gz'));
   if(createHash('sha256').update(data).digest('hex')!=='ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468')throw Error('asset');
   engine=await createWorker('eng',1,{langPath,gzip:true,cacheMethod:'none',logger:()=>{},errorHandler:()=>{}},
    {load_system_dawg:'0',load_freq_dawg:'0',load_unambig_dawg:'0',load_punc_dawg:'0',load_number_dawg:'0',load_bigram_dawg:'0'});
   await engine.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK,preserve_interword_spaces:'1',classify_enable_learning:'0'});
  }
  const started=performance.now();
  await engine.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK});
  const {data}=await engine.recognize(png,{}, {text:true,blocks:true});
  const lines=(data.blocks??[]).flatMap(b=>b.paragraphs.flatMap(p=>p.lines));
  const candidates=lines.flatMap(l=>l.words??[]).filter(w=>w.confidence<90&&w.text.length<=100&&w.bbox.x1>w.bbox.x0&&w.bbox.y1>w.bbox.y0)
   .sort((a,b)=>a.confidence-b.confidence);
  const disagreements=[];let probes=0;
  if(candidates.length&&performance.now()-started<3500){
   const original=PNG.sync.read(png,{checkCRC:true});
   await engine.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE});
   for(const word of candidates.slice(0,12)){
    if(performance.now()-started>4500)break;
    const x=Math.max(0,word.bbox.x0-8),y=Math.max(0,word.bbox.y0-8);
    const width=Math.min(original.width-x,word.bbox.x1-word.bbox.x0+16),height=Math.min(original.height-y,word.bbox.y1-word.bbox.y0+16);
    if(width<=0||height<=0||width*height>100000||width>1000||height>100)continue;
    const crop=new PNG({width:width*3,height:height*3});
    for(let cy=0;cy<crop.height;cy++)for(let cx=0;cx<crop.width;cx++){
     const from=((y+Math.floor(cy/3))*original.width+x+Math.floor(cx/3))*4;
     original.data.copy(crop.data,(cy*crop.width+cx)*4,from,from+4);
    }
    const again=await engine.recognize(PNG.sync.write(crop),{}, {text:true});probes++;
    const alternative=again.data.text.trim().slice(0,200);
    // A second OCR pass is NOT a correction vote. Preserve both hypotheses and
    // request direct pixel review, including case and punctuation differences.
    if(alternative&&alternative.replace(/\s/g,'')!==word.text.replace(/\s/g,''))
     disagreements.push({text:word.text.slice(0,100),alternative,box:{x,y,width,height}});
    if(disagreements.length>=6)break;
   }
  }
  const result={available:true,engine:'tesseract-local-eng',verified:false,text:data.text.slice(0,10000),confidence:Math.round(data.confidence),
   reviewRequired:disagreements.length>0,disagreements,probes,probesPartial:probes<candidates.length,
   truncated:data.text.length>10000||lines.length>100,lines:lines.slice(0,100).map(l=>({text:l.text.slice(0,500),confidence:Math.round(l.confidence),box:{x:l.bbox.x0,y:l.bbox.y0,width:l.bbox.x1-l.bbox.x0,height:l.bbox.y1-l.bbox.y0}}))};
  if(Buffer.byteLength(JSON.stringify(result))>24000){result.lines=[];result.truncated=true;}
  parentPort.postMessage({id,result});
 } catch {parentPort.postMessage({id,result:unavailable});}
 finally {active=false;}
});
