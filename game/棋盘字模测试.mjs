import test from 'node:test';
import assert from 'node:assert/strict';
import {AXIS_DIGITS, drawAxisNumber, AXIS_LETTERS, drawAxisLetter} from './棋盘字模.mjs';

test('5/6/8具有足够像素差异，不能退化成一像素区别',()=>{
  const distance=(a,b)=>[...a.join('')].reduce((n,p,i)=>n+(p!==b.join('')[i]),0);
  for(const [a,b] of [['5','6'],['6','8'],['5','8']])assert.ok(distance(AXIS_DIGITS[a],AXIS_DIGITS[b])>=6);
});
test('A到L列字母无需缩放字体，整像素落在最窄10px列内且不碰顶部装饰',()=>{
  assert.equal(Object.keys(AXIS_LETTERS).length,12);
  for(const n of [8,10,12]){
    const step=Math.floor(120/n),mx=Math.floor((160-step*n)/2),my=Math.floor((144-step*n)/2);
    for(let col=0;col<n;col++){
      const painted=[];
      const ctx={fillStyle:'',fillRect:(x,y,w,h)=>painted.push({x,y,w,h}),fillText:()=>assert.fail('列字母不能依赖缩小的字体')};
      drawAxisLetter(ctx,String.fromCharCode(65+col),mx+(col+.5)*step,my-7,'#fff1c6');
      assert.ok(painted.length>10);
      assert.ok(painted.every(p=>[p.x,p.y,p.w,p.h].every(Number.isInteger)));
      assert.ok(painted.every(p=>p.x>=mx+col*step&&p.x<mx+(col+1)*step));
      assert.ok(painted.every(p=>p.y>=0&&p.y<my-2));
    }
  }
});
test('8/10/12盘全部行号在格中心，双位标签不越出画布或碰海图边框',()=>{
  for(const n of [8,10,12]){
    const step=Math.floor(120/n),mx=Math.floor((160-step*n)/2),my=Math.floor((144-step*n)/2);
    for(let row=0;row<n;row++){
      const painted=[];const ctx={fillStyle:'',fillRect:(x,y,w,h)=>painted.push({x,y,w,h})};
      const box=drawAxisNumber(ctx,row+1,mx-12,my+(row+.5)*step,'#163e58');
      assert.ok(box.x>=0);assert.ok(box.x+box.width<=mx-4);
      assert.ok(Math.abs(box.y+box.height/2-(my+(row+.5)*step))<=.5);
      assert.ok(painted.length>0);assert.ok(painted.every(p=>[p.x,p.y,p.w,p.h].every(Number.isInteger)));
    }
  }
});
