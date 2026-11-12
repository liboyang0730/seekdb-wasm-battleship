// 对最终离线单页进行真实引擎验收；仅使用独立临时浏览器，不操作已有窗口。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const origin=process.env.BASE_URL||'http://127.0.0.1:8905/';
const url=new URL('?test=1',origin).href;
const output=process.env.QA_OUTPUT||await mkdtemp(join(tmpdir(),'seekdb-offline-opfs-'));
await mkdir(output,{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'seekdb-offline-opfs-profile-'));
const report={startedAt:new Date().toISOString(),url,profile,scope:'最终单页、真实SQL与OPFS，独立浏览器；不以关卡夹具替代自然通关',checks:[],errors:[],consoleErrors:[],externalRequests:[]};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let context,page;
const save=()=>writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
async function check(name,work){const at=Date.now();try{const data=await work();report.checks.push({name,passed:true,ms:Date.now()-at,data});console.log(JSON.stringify({name,passed:true,data}));return data;}catch(e){report.checks.push({name,passed:false,error:e.message});throw e;}finally{await save();}}
async function ready(){await page.waitForFunction(()=>window.navalTest||/失败/.test(document.querySelector('#engine-status')?.textContent||''),{},{timeout:120000});assert.ok(await page.evaluate(()=>Boolean(window.navalTest)),await page.locator('#engine-detail').innerText());await idle();}
async function idle(){await page.waitForFunction(()=>window.navalTest&&!navalTest.getState().busy,{},{timeout:120000});}
async function open(){
 context=await chromium.launchPersistentContext(profile,{executablePath:process.env.BROWSER_EXECUTABLE,headless:true,chromiumSandbox:true,viewport:{width:1440,height:900}});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===new URL(origin).origin||['blob:','data:','about:'].includes(u.protocol))return route.continue();report.externalRequests.push(u.href);return route.abort();});
 page=context.pages()[0];page.on('pageerror',e=>report.errors.push(e.message));page.on('crash',()=>report.errors.push('page-crash'));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());});
 await page.goto(url);await ready();
}
async function fingerprint(){return await page.evaluate(async()=>{
 const name=navalTest.archiveInfo().database,db=navalTest.db;
 const current=(await db.query(`SELECT revision,payload_json,pending_json FROM \`${name}\`.naval_current WHERE slot=1`)).rows;
 const history=(await db.query(`SELECT COUNT(*) AS n FROM \`${name}\`.naval_history`)).rows;
 const p=navalTest.snapshot();
 return {database:name,current,history,payload:{campaign:p.campaign,state:p.state,deal:p.deal,notes:p.notes,cards:p.cards,abilities:p.abilities,targets:p.targets,selectedShip:p.selectedShip,view:p.view,detailSelection:p.detailSelection,fitMode:p.ui.fitMode}};
 });}
try{
 await check('最终单页离线启动与真实引擎',async()=>{await open();const data=await page.evaluate(()=>({isolated:crossOriginIsolated,version:navalTest.db.engineVersion,manifest:JSON.parse(document.querySelector('#seekdb-bundle-manifest').textContent),info:navalTest.archiveInfo()}));assert.ok(data.isolated);assert.match(data.version,/seekdb/i);assert.ok(data.manifest.notes.some(n=>n.includes('OPFS')));return{isolated:data.isolated,version:data.version,modules:data.manifest.moduleCount};});
 await check('手册弹窗也有可点击的重开入口',async()=>{
  await page.locator('#help-button').click();assert.ok(await page.locator('#help-dialog').isVisible());
  assert.equal(await page.locator('#help-restart').count(),1,'模态手册内必须保留重开新游戏入口');
  assert.ok(await page.locator('#help-restart').isEnabled());
  await page.locator('#help-dialog').evaluate(e=>{e.scrollTop=e.scrollHeight;});
  const button=await page.locator('#help-restart').boundingBox();assert.ok(button.y>=0&&button.y+button.height<=900,'读到手册底部也应看到重开入口');return{dialogOpen:true,button};
 });
 await check('从手册实际创建新局并关闭弹窗',async()=>{
  await page.locator('#help-restart').click();await page.waitForFunction(()=>window.navalTest&&!navalTest.getState().busy&&navalTest.archiveInfo().database&&!navalTest.archiveInfo().saveBlocked,{},{timeout:120000});
  assert.equal(await page.evaluate(()=>navalTest.getState().view),'deploy');assert.ok(!await page.locator('#help-dialog').isVisible());return{database:await page.evaluate(()=>navalTest.archiveInfo().database)};
 });
 await check('正常检索、标记与完整炮击',async()=>{
  await page.evaluate(()=>navalTest.start('FINAL-OFFLINE-PERSISTENCE'));await idle();await page.evaluate(()=>navalTest.confirm());await idle();
  await page.evaluate(()=>{for(const g of navalTest.reconTask().groups)navalTest.selectReconCard(g.choices.find(c=>c.description===g.target).id);});await page.evaluate(()=>navalTest.recon());await idle();
  await page.evaluate(()=>{for(const g of navalTest.detailTask().groups)navalTest.selectDetailInput(g.kind,g.choices[0].id);});await page.evaluate(()=>navalTest.detailSearch());await idle();await page.evaluate(()=>navalTest.acceptBriefing());await idle();await page.locator('#engage-sector').click();await idle();
  await page.evaluate(()=>navalTest.target([{x:0,y:0}]));await page.locator('#mark-flag').click();await idle();
  await page.evaluate(()=>navalTest.target([{x:1,y:1}]));await page.locator('#mark-question').click();await idle();
  const marks=await page.evaluate(()=>navalTest.getState().state.mapMarks);assert.equal(marks['0,0'].kind,'flag');assert.equal(marks['1,1'].kind,'question');
  await page.evaluate(()=>{navalTest.weapon('normal');navalTest.target([{x:2,y:2}]);});
  await page.locator('#fire-shot').click();await page.waitForFunction(()=>navalTest.animationInfo()?.type==='launch',{},{timeout:15000});const duration=await page.evaluate(()=>navalTest.animationInfo().duration);assert.ok(duration>50);await idle();
  await page.evaluate(()=>navalTest.flush());await idle();const s=await page.evaluate(()=>navalTest.getState());assert.equal(s.state.round,2);assert.equal(s.state.shotHistory.filter(s=>s.side==='player').length,1);await page.screenshot({path:join(output,'battle.png')});return{round:s.state.round,shots:s.state.shotHistory.length,launchDurationMs:duration};
 });
 const expected=await fingerprint();
 for(let i=1;i<=3;i++)await check(`刷新恢复 ${i}/3，无额外存档写入`,async()=>{await page.reload();await ready();const actual=await fingerprint();assert.deepEqual(actual,expected);return{fingerprint:hash(actual),database:actual.database,revision:actual.current[0].revision};});
 for(let i=1;i<=3;i++)await check(`关闭独立浏览器再打开 ${i}/3`,async()=>{await context.close();context=null;await open();const actual=await fingerprint();assert.deepEqual(actual,expected);return{fingerprint:hash(actual),revision:actual.current[0].revision};});
 await check('实际重开删旧库建新库，核心数据全部归零',async()=>{
  const old=expected.database;await page.locator('#restart-game').click();await page.waitForFunction(old=>window.navalTest&&!navalTest.getState().busy&&navalTest.archiveInfo().database!==old&&!navalTest.archiveInfo().saveBlocked,old,{timeout:120000});
  const data=await page.evaluate(async()=>({info:navalTest.archiveInfo(),state:navalTest.getState(),databases:(await navalTest.db.query('SHOW DATABASES')).rows.map(r=>Object.values(r)[0]),sql:document.querySelector('#database-lifecycle-sql').textContent}));
  assert.ok(!data.databases.includes(old));assert.ok(data.databases.includes(data.info.database));assert.equal(data.state.view,'deploy');assert.equal(data.state.campaign.level,1);assert.equal(data.state.state.round,1);assert.equal(data.state.state.shotHistory.length,0);assert.match(data.sql,new RegExp(`DROP DATABASE IF EXISTS .${old}`));assert.match(data.sql,/CREATE DATABASE/);assert.ok(await page.locator('#database-lifecycle').isVisible());assert.ok(!await page.locator('#help-dialog').isVisible());return{old,next:data.info.database,sql:data.sql};
 });
 assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);report.passed=true;
}catch(e){report.passed=false;report.fatal=e.stack||String(e);process.exitCode=1;console.log(JSON.stringify({failed:true,error:e.message}));}
finally{if(context)await context.close();report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({output,passed:report.passed,checks:report.checks.length,errors:report.errors.length,consoleErrors:report.consoleErrors.length}));}
