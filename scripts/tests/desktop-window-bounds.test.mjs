import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fitWindowBounds,initialWindowBounds} from '../../packages/desktop/window-bounds.mjs';
const fits=(b,a)=>{assert.ok(b.x>=a.x&&b.y>=a.y);assert.ok(b.x+b.width<=a.x+a.width&&b.y+b.height<=a.y+a.height);assert.ok(b.minHeight<=b.height&&b.minWidth<=b.width);};
test('initial desktop window fits small, HiDPI and negative-origin display work areas',()=>{
 for(const area of [{x:0,y:0,width:1280,height:720},{x:0,y:0,width:1024,height:576},{x:-1920,y:-100,width:1920,height:1040},{x:1366,y:0,width:800,height:600}])fits(initialWindowBounds(area),area);
});
test('a removed or resized monitor cannot leave the composer below the work area',()=>{
 const area={x:0,y:0,width:1024,height:560};
 const fitted=fitWindowBounds({x:-1900,y:200,width:1320,height:860},area);fits(fitted,area);
 assert.equal(fitted.x,0);assert.equal(fitted.y,0);assert.equal(fitted.height,560);
 assert.deepEqual(fitWindowBounds(fitted,area),fitted);
});
