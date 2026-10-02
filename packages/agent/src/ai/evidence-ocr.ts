import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export interface OcrObservation {
  available: boolean;
  engine: 'tesseract-local-eng';
  verified: false;
  text?: string;
  confidence?: number;
  lines?: Array<{ text: string; confidence: number; box: { x: number; y: number; width: number; height: number } }>;
  truncated?: boolean;
  reviewRequired?: boolean;
  disagreements?: Array<{text:string;alternative:string;box:{x:number;y:number;width:number;height:number}}>;
  probes?: number;
  probesPartial?: boolean;
  reason?: 'busy' | 'unavailable' | 'timeout' | 'cancelled';
}
const absent=(reason:OcrObservation['reason']):OcrObservation=>({available:false,engine:'tesseract-local-eng',verified:false,reason});
type Slot={worker?:Worker;busy:boolean;idle?:ReturnType<typeof setTimeout>;cancel?:()=>void};
const slots:Slot[]=[{busy:false},{busy:false}];
let sequence=0;
function runtimePath():string {
  for(const url of [new URL('./integrations/evidence-ocr/runtime.cjs',import.meta.url),new URL('../../../../integrations/evidence-ocr/runtime.cjs',import.meta.url)]) {
    const path=fileURLToPath(url).replace(/([\\/])app\.asar([\\/])/,'$1app.asar.unpacked$2');
    if(existsSync(path))return path;
  }
  throw new Error('Shipped OCR runtime missing');
}
/** At most two local engines; no model paths, downloads, shell or cross-request queue. */
export async function observeOcr(png:Buffer,signal:AbortSignal):Promise<OcrObservation> {
  signal.throwIfAborted();
  if(png.length>8*1024*1024) return absent('unavailable');
  const slot=slots.find(s=>!s.busy);
  if(!slot)return absent('busy');
  slot.busy=true;clearTimeout(slot.idle);
  try {slot.worker??=new Worker(runtimePath(),{resourceLimits:{maxOldGenerationSizeMb:128}});}
  catch {slot.busy=false;return absent('unavailable');}
  const worker=slot.worker;const id=++sequence;
  return new Promise(resolve=>{
    let done=false;
    const finish=(result:OcrObservation,retire=false)=>{
      if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
      worker.off('message',message);worker.off('error',error);worker.off('exit',error);slot.cancel=undefined;
      if(retire) {
        slot.worker=undefined;
        // Keep capacity reserved until the supervising and nested workers retire.
        void worker.terminate().catch(()=>{}).finally(()=>{slot.busy=false;});
      } else {
        slot.busy=false;
        slot.idle=setTimeout(()=>{if(slot.worker===worker&&!slot.busy){slot.worker=undefined;void worker.terminate();}},30000);
        slot.idle.unref();worker.unref();
      }
      resolve(result);
    };
    const abort=()=>finish(absent('cancelled'),true);
    const error=()=>finish(absent('unavailable'),true);
    const message=(value:any)=>{
      if(value?.id!==id||value?.result?.engine!=='tesseract-local-eng'||value?.result?.verified!==false) {error();return;}
      if(Buffer.byteLength(JSON.stringify(value))>26000) {error();return;}
      finish(value.result,!value.result.available);
    };
    const timer=setTimeout(()=>finish(absent('timeout'),true),6000);
    slot.cancel=abort;
    worker.on('message',message);worker.once('error',error);worker.once('exit',error);worker.ref();
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();else try { worker.postMessage({id,bytes:png}); } catch { error(); }
  });
}
export async function closeEvidenceOcr():Promise<void> {
  await Promise.all(slots.map(async slot=>{clearTimeout(slot.idle);const worker=slot.worker;slot.cancel?.();slot.worker=undefined;if(worker)await worker.terminate().catch(()=>{});slot.busy=false;}));
}
