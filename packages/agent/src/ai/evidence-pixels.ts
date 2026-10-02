import { PNG } from 'pngjs';

/** A labelled-by-metadata contact sheet of original pixels, never OCR redraws. */
export function evidenceReviewSheet(image: PNG, boxes: Array<{x:number;y:number;width:number;height:number}>) {
  const regions: Array<{index:number;source:typeof boxes[number];sheet:{x:number;y:number;width:number;height:number};scale:number}> = [];
  let width=1,height=8;
  for (const [index, box] of boxes.slice(0,6).entries()) {
    if (!Object.values(box).every(Number.isSafeInteger) || box.x<0 || box.y<0 || box.width<1 || box.height<1 || box.width>1184
      || box.x+box.width>image.width || box.y+box.height>image.height) continue;
    const scale=Math.min(3,Math.floor(1184/box.width));
    const nextWidth=Math.max(width,box.width*scale+16),nextHeight=height+box.height*scale+8;
    if (nextWidth*nextHeight>2_000_000) break;
    regions.push({index:index+1,source:box,sheet:{x:8,y:height,width:box.width*scale,height:box.height*scale},scale});
    width=nextWidth;height=nextHeight;
  }
  if (!regions.length) return undefined;
  const sheet=new PNG({width,height});sheet.data.fill(255);
  for(const region of regions)for(let y=0;y<region.sheet.height;y++)for(let x=0;x<region.sheet.width;x++) {
    const from=((region.source.y+Math.floor(y/region.scale))*image.width+region.source.x+Math.floor(x/region.scale))*4;
    image.data.copy(sheet.data,((region.sheet.y+y)*width+region.sheet.x+x)*4,from,from+4);
  }
  const bytes=PNG.sync.write(sheet);
  return bytes.length<=2*1024*1024?{bytes,regions}:undefined;
}

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
