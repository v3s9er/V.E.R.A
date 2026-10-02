import type { PNG } from 'pngjs';

/** Remove only exactly uniform outer pixels, never infer/OCR/repaint content. */
export function evidenceContentBounds(image: PNG): {x:number;y:number;width:number;height:number} {
  const {width,height,data}=image;
  const full={x:0,y:0,width,height};
  const same=(offset:number)=>data[offset]===data[0]&&data[offset+1]===data[1]&&data[offset+2]===data[2]&&data[offset+3]===data[3];
  // Different corners are evidence of a nonuniform background: preserve all.
  if(![width-1,(height-1)*width,width*height-1].every(p=>same(p*4))) return full;
  let left=width,top=height,right=-1,bottom=-1;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    if(same((y*width+x)*4)) continue;
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  }
  if(right<left) return full; // A blank image is still evidence, not a zero-sized crop.
  left=Math.max(0,left-12);top=Math.max(0,top-12);
  right=Math.min(width-1,right+12);bottom=Math.min(height-1,bottom+12);
  const crop={x:left,y:top,width:right-left+1,height:bottom-top+1};
  return crop.width*crop.height<=width*height*0.8?crop:full;
}
