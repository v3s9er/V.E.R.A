import assert from 'node:assert/strict';
import {test} from 'node:test';
import {evidenceOcrObservation} from '../src/ai/evidence-ocr-observation.js';
import type {OcrObservation} from '../src/ai/evidence-ocr.js';

test('disputed OCR is explicitly uncertain, never silently corrected or leaked through duplicate lines',()=>{
 const box={x:20,y:30,width:90,height:20};
 const input:OcrObservation={available:true,engine:'tesseract-local-eng',verified:false,
   text:'a="u"; a+="o"\nb="v"; a+="o"',reviewRequired:true,
   lines:[{text:'a="u"; a+="o"',confidence:80,box}],
   disagreements:[{text:'a+="o"',alternative:'a+="O"',box}],probes:2};
 const before=JSON.stringify(input),out=evidenceOcrObservation(input)!;
 assert.equal(out.verified,false);assert.equal(out.reviewRequired,true);
 assert.equal(out.text,'a="u"; [uncertain-region-1]\nb="v"; [uncertain-region-1]');
 assert.equal(out.lines![0].text,'a="u"; [uncertain-region-1]');
 assert.deepEqual(out.disagreements,[{marker:'[uncertain-region-1]',box}]);
 assert.equal(JSON.stringify(input),before,'cached observation must not be mutated');
 assert.equal(evidenceOcrObservation(input,true),input,'explicit hypothesis inspection preserves both raw candidates');
});

test('masking escapes regex characters, preserves case, and handles repeated whitespace',()=>{
 const input:OcrObservation={available:true,engine:'tesseract-local-eng',verified:false,
   text:'s=s[::-1];  A+= "x"\nA+=  "x"\na+= "x"',
   disagreements:[{text:'s=s[::-1];',alternative:'s=s[:-1];',box:{x:0,y:0,width:1,height:1}},
     {text:'A+= "x"',alternative:'A+= "X"',box:{x:1,y:0,width:1,height:1}}]};
 assert.equal(evidenceOcrObservation(input)!.text,'[uncertain-region-1]  [uncertain-region-2]\n[uncertain-region-2]\na+= "x"');
 assert.equal(evidenceOcrObservation(undefined),undefined);
 const unavailable:OcrObservation={available:false,engine:'tesseract-local-eng',verified:false,reason:'busy'};
 assert.equal(evidenceOcrObservation(unavailable),unavailable);
 const undisputed:OcrObservation={available:true,engine:'tesseract-local-eng',verified:false,text:'not proven',disagreements:[]};
 assert.equal(evidenceOcrObservation(undisputed),undisputed);
});

test('overlapping OCR guesses cannot corrupt inserted region markers',()=>{
 const box={x:0,y:0,width:1,height:1};
 const input:OcrObservation={available:true,engine:'tesseract-local-eng',verified:false,text:'x=1; 1',
   disagreements:[{text:'1',alternative:'l',box},{text:'x=1',alternative:'x=l',box}]};
 assert.equal(evidenceOcrObservation(input)!.text,'[uncertain-region-2]; [uncertain-region-1]');
});
