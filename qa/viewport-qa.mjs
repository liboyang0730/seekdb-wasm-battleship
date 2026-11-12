// 桌面真实引擎验收；PLAYWRIGHT_MODULE/BROWSER_EXECUTABLE 由测试环境提供，不操作现有浏览器。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const output=process.env.QA_OUTPUT||await mkdtemp(join(tmpdir(),'seekdb-viewport-'));
await mkdir(output,{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'seekdb-viewport-profile-'));
const report={startedAt:new Date().toISOString(),scope:'真实seekdb、12×12、核心完整画面及鼠标坐标；stage仅解锁第六关夹具，不替代自然通关',checks:[],errors:[],consoleErrors:[]};
let context;
const record=async(name,work)=>{const at=Date.now();try{const data=await work();report.checks.push({name,passed:true,ms:Date.now()-at,data});console.log(JSON.stringify({name,passed:true,data}));return data;}catch(e){report.checks.push({name,passed:false,error:e.message});throw e;}finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));}};
try{
 context=await chromium.launchPersistentContext(profile,{executablePath:process.env.BROWSER_EXECUTABLE,headless:true,chromiumSandbox:true,viewport:{width:1440,height:900},reducedMotion:'reduce'});
 const page=context.pages()[0];page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());});
 const idle=()=>page.waitForFunction(()=>window.navalTest&&!navalTest.getState().busy,{}, {timeout:120000});
 await record('真实OPFS首次创建与第六关检索',async()=>{
  await page.goto(process.env.BASE_URL||'http://127.0.0.1:8903/游戏.html?test=1');await page.waitForFunction(()=>window.navalTest||document.querySelector('#engine-status')?.textContent.includes('失败'),{}, {timeout:120000});assert.ok(await page.evaluate(()=>Boolean(window.navalTest)),await page.locator('#engine-detail').innerText());
  await page.evaluate(()=>navalTest.start('VIEWPORT-QA-FIXED-SEED'));await idle();await page.evaluate(()=>navalTest.stage(6));await idle();await page.evaluate(()=>navalTest.confirm());await idle();
  await page.evaluate(()=>{for(const g of navalTest.reconTask().groups)navalTest.selectReconCard(g.choices.find(c=>c.description===g.target).id);});await page.evaluate(()=>navalTest.recon());await idle();
  await page.evaluate(()=>{for(const g of navalTest.detailTask().groups)navalTest.selectDetailInput(g.kind,g.choices[0].id);});await page.evaluate(()=>navalTest.detailSearch());await idle();await page.evaluate(()=>navalTest.acceptBriefing());await idle();await page.evaluate(()=>navalTest.engage(navalTest.getState().state.proposedSector));await idle();
  const state=await page.evaluate(()=>({view:navalTest.getState().view,size:navalTest.getState().state.player.size,database:navalTest.archiveInfo().database}));assert.equal(state.view,'battle');assert.equal(state.size,12);return state;
 });
 for(const [width,height] of [[1440,900],[1280,800],[1024,768],[1728,1117],[2320,1329]])await record(`真实12格一屏与边界坐标 ${width}×${height}`,async()=>{
  await page.setViewportSize({width,height});await page.waitForTimeout(200);
  const data=await page.evaluate(()=>{
   const selectors=['.battle-fit-stage>.masthead','.battle-fit-manual-slot>.quick-rule-section','.battle-fit-core-slot>.navy-game-screen','#enemy-board','#fleet-board','.weapon-choices','#fire-shot','#mark-question','#restart-game'];
   return {width:innerWidth,height:innerHeight,scale:document.body.dataset.battleFitScale,scrollY,rects:selectors.map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return{selector,x:r.x,y:r.y,right:r.right,bottom:r.bottom,visible:r.width>0&&r.height>0};})};
  });
  for(const r of data.rects){assert.ok(r.visible,r.selector);assert.ok(r.x>=-1&&r.y>=-1&&r.right<=width+1&&r.bottom<=height+1,JSON.stringify(r));}
  for(const cell of [{x:0,y:0},{x:11,y:11},{x:5,y:6}]){
   const position=await page.evaluate(c=>{const canvas=document.querySelector('#enemy-board'),r=canvas.getBoundingClientRect(),g=navalTest.geometry('enemy-board');return{x:r.left+(g.mx+(c.x+.5)*g.step)*r.width/canvas.width,y:r.top+(g.my+(c.y+.5)*g.step)*r.height/canvas.height};},cell);
   await page.mouse.click(position.x,position.y);assert.deepEqual(await page.evaluate(()=>navalTest.selection()),[cell]);
  }
  await page.screenshot({path:join(output,`${width}x${height}.png`)});return data;
 });
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.passed=false;report.fatal=e.stack||String(e);console.log(JSON.stringify({failed:true,error:e.message}));process.exitCode=1;}
finally{if(context)await context.close();report.finishedAt=new Date().toISOString();await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,passed:report.passed,checks:report.checks.length,consoleErrors:report.consoleErrors.length}));}
