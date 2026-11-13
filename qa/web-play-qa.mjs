// 普通HTTP模拟Pages：独立临时浏览器/profile，不使用安全绕过参数，不接触已有窗口。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';

const ownedOrigin=process.env.QA_ORIGIN_MODE==='owned-server';
const origin=new URL(process.env.BASE_URL||(ownedOrigin?'http://127.0.0.1:8933/':'http://127.0.0.1:8921/'));
const output=process.env.QA_OUTPUT||await mkdtemp(join(tmpdir(),'seekdb-web-qa-'));
const profile=await mkdtemp(join(tmpdir(),'seekdb-web-profile-'));
await mkdir(output,{recursive:true});
const report={startedAt:new Date().toISOString(),origin:origin.href,profile,
  scope:'全新独立配置、真实seekdb与OPFS；普通HTTP由Service Worker提供隔离；非自然通关',
  outageMode:ownedOrigin?'只停止脚本自建origin服务；不模拟系统断网':'Playwright context.setOffline(true)',
  browser:process.env.BROWSER_ENGINE||'chromium',checks:[],pageErrors:[],consoleErrors:[],crashes:[],externalRequests:[],processes:[],navigations:[]};
const spawn=childProcess.spawn;
childProcess.spawn=function(executable,args,...rest){
  const proc=spawn.call(this,executable,args,...rest);
  if(executable===process.env.BROWSER_EXECUTABLE){
    const item={pid:proc.pid,executable,args};report.processes.push(item);
    proc.on('exit',(code,signal)=>Object.assign(item,{exitCode:code,signal}));
  }
  return proc;
};
const require=createRequire(import.meta.url);
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let context,page,closing=false,server,serverExit;
const save=()=>writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
function observe(p){
  p.setDefaultTimeout(15000);
  p.on('pageerror',e=>report.pageErrors.push({at:new Date().toISOString(),url:p.url(),message:e.message}));
  p.on('console',m=>{if(m.type()==='error')report.consoleErrors.push({at:new Date().toISOString(),url:p.url(),message:m.text()});});
  p.on('crash',()=>report.crashes.push({at:new Date().toISOString(),url:p.url()}));
  p.on('framenavigated',frame=>{if(frame===p.mainFrame())report.navigations.push({at:new Date().toISOString(),url:frame.url()});});
}
async function check(name,work){
  const started=Date.now();console.log(JSON.stringify({step:name,status:'running'}));
  try{const data=await work();report.checks.push({name,passed:true,ms:Date.now()-started,data});console.log(JSON.stringify({step:name,status:'passed',data}));return data;}
  catch(e){
    report.checks.push({name,passed:false,ms:Date.now()-started,error:e.message});
    if(page&&!page.isClosed())report.failureUI=await page.evaluate(()=>({url:location.href,isolated:crossOriginIsolated,
      launch:document.querySelector('#launch-status')?.textContent,status:document.querySelector('#engine-status')?.textContent,
      detail:document.querySelector('#engine-detail')?.textContent,save:document.querySelector('#save-status')?.textContent,
      action:document.querySelector('#status-message')?.textContent})).catch(()=>null);
    console.log(JSON.stringify({step:name,status:'failed',error:e.message,ui:report.failureUI}));throw e;
  }finally{await save();}
}
async function idle(){await page.waitForFunction(()=>window.navalTest&&!navalTest.getState().busy,null,{timeout:30000});}
async function engineReady(hook=false){
  await page.waitForFunction(wantHook=>{
    const text=document.querySelector('#engine-status')?.textContent||'';
    return /失败/.test(text)||/真实 seekdb 已就绪/.test(text)&&(!wantHook||window.navalTest);
  },hook,{timeout:30000});
  assert.match(await page.locator('#engine-status').innerText(),/真实 seekdb 已就绪/,await page.locator('#engine-detail').innerText());
  if(hook)await idle();
}
async function indexReady(p=page){
  await p.waitForFunction(()=>!document.querySelector('#launch-start')?.disabled||!document.querySelector('#launch-retry')?.hidden,null,{timeout:30000});
  assert.ok(await p.locator('#launch-start').isEnabled(),await p.locator('#launch-status').innerText());
}
async function fingerprint(){
  const data=await page.evaluate(async()=>{
    const info=navalTest.archiveInfo(),db=navalTest.db,p=navalTest.snapshot();
    const current=(await db.query(`SELECT revision,payload_json,pending_json FROM \`${info.database}\`.naval_current WHERE slot=1`)).rows;
    const history=(await db.query(`SELECT COUNT(*) AS n FROM \`${info.database}\`.naval_history`)).rows;
    return {info,current,history,payload:{campaign:p.campaign,state:p.state,deal:p.deal,detailEvidence:p.detailEvidence,
      notes:p.notes,cards:p.cards,abilities:p.abilities,targets:p.targets,selectedShip:p.selectedShip,view:p.view,detailSelection:p.detailSelection}};
  });
  return {database:data.info.database,revision:data.info.revision,saveBlocked:data.info.saveBlocked,
    currentHash:hash(data.current),historyCount:data.history[0].n,stateHash:hash(data.payload)};
}

try{
  if(ownedOrigin){
    assert.equal(origin.href,'http://127.0.0.1:8933/','自有服务对照固定使用8933，不能连接或关闭已有服务');
    assert.ok(process.env.QA_SITE_DIR,'自有服务需要显式指定临时构建目录');
    server=childProcess.spawn('python3',['-m','http.server','8933','--bind','127.0.0.1','--directory',process.env.QA_SITE_DIR],{stdio:['ignore','ignore','pipe']});
    report.originServer={pid:server.pid,spawnedByThisScript:true,directory:process.env.QA_SITE_DIR};
    let stderr='';server.stderr.on('data',chunk=>{stderr+=chunk;});
    serverExit=new Promise(resolve=>server.once('exit',(code,signal)=>{Object.assign(report.originServer,{exitCode:code,signal});resolve();}));
    const deadline=Date.now()+5000;
    for(;;){
      if(server.exitCode!==null)throw new Error(`自有服务未能启动：${stderr}`);
      try{const response=await fetch(origin);await response.arrayBuffer();if(response.ok)break;}catch{}
      if(Date.now()>deadline)throw new Error('自有临时服务启动超时');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  const engine=playwright[report.browser];assert.ok(engine,'未知浏览器类型');
  context=await engine.launchPersistentContext(profile,{executablePath:process.env.BROWSER_EXECUTABLE,headless:true,
    ...(report.browser==='chromium'?{chromiumSandbox:true}:{}),viewport:{width:1440,height:900},reducedMotion:'reduce'});
  context.on('page',observe);for(const p of context.pages())observe(p);
  context.on('request',request=>{
    const u=new URL(request.url());if(u.protocol==='http:'||u.protocol==='https:')if(u.origin!==origin.origin)report.externalRequests.push(u.origin+u.pathname);
  });
  context.browser()?.on('disconnected',()=>{if(!closing)report.crashes.push({at:new Date().toISOString(),message:'unexpected-browser-disconnect'});});
  page=context.pages()[0]||await context.newPage();
  await check('无服务端隔离头的首次入口，SW仅受控重载一次',async()=>{
    const response=await page.goto(origin.href,{waitUntil:'domcontentloaded',timeout:30000});
    assert.equal(response.headers()['cross-origin-opener-policy'],undefined);
    assert.equal(response.headers()['cross-origin-embedder-policy'],undefined);
    await indexReady();
    const state=await page.evaluate(()=>({isolated:crossOriginIsolated,sab:typeof SharedArrayBuffer,controller:navigator.serviceWorker.controller?.scriptURL,
      hasDatabase:!!window.navalTest,status:document.querySelector('#launch-status').textContent}));
    assert.ok(state.isolated);assert.equal(state.sab,'function');assert.equal(state.hasDatabase,false);
    const indexNavigations=report.navigations.filter(n=>new URL(n.url).origin===origin.origin&&!new URL(n.url).pathname.endsWith('game.html'));
    assert.equal(indexNavigations.length,2,'新配置应只有首次导航和一次受控重载');
    return{...state,controlledReloads:indexNavigations.length-1};
  });
  await check('点击进入后真实引擎就绪，再导航测试钩子同页',async()=>{
    await page.locator('#launch-start').click();await engineReady();
    await page.goto(new URL('game.html?test=1',origin).href,{waitUntil:'domcontentloaded',timeout:30000});await engineReady(true);
    const data=await page.evaluate(async()=>({isolated:crossOriginIsolated,selectedEngine:window.seekdbSingleFileEngine,
      version:(await navalTest.db.query('SELECT VERSION() AS version')).rows[0].version}));
    assert.match(data.version,/seekdb/i);assert.ok(data.selectedEngine.verified);return data;
  });
  await check('真实建局、默认部署、范围定位与混合侦察进入海战',async()=>{
    await page.evaluate(()=>navalTest.start('WEB-OPFS-SMOKE'));await idle();
    await page.locator('#confirm-fleet').click();await idle();
    const cards=await page.evaluate(()=>navalTest.reconTask().groups.map(g=>g.choices.find(c=>c.description===g.target).id));
    for(const id of cards)await page.locator(`[data-card-id="${id}"]`).click();
    await page.locator('#run-query').click();await idle();
    assert.equal(await page.evaluate(()=>navalTest.getState().view),'briefing');
    const inputs=await page.evaluate(()=>navalTest.detailTask().groups.map(g=>({kind:g.kind,id:g.choices[0].id})));
    for(const input of inputs)await page.locator(`[data-detail-kind="${input.kind}"][data-detail-input-id="${input.id}"]`).click();
    await page.locator('#run-detail-search').click();await idle();
    const data=await page.evaluate(()=>{const s=navalTest.getState().state;return{reconSql:s.lastReconSql,detailSql:s.lastDetailSql,reconRows:s.resultRows.length,
      detailRows:s.detailRows.length,comparisons:s.detailComparisons,hybridReady:s.hybridReady};});
    assert.match(data.reconSql,/observed_round/);assert.match(data.detailSql,/MATCH\(/);assert.match(data.detailSql,/l2_distance/);assert.ok(data.hybridReady);
    await page.locator('#accept-briefing').click();await idle();await page.locator('#engage-sector').click();await idle();
    assert.equal(await page.evaluate(()=>navalTest.getState().view),'battle');return data;
  });
  await check('实际标记保存，回合与弹药不变',async()=>{
    const before=await page.evaluate(()=>{const s=navalTest.getState().state;return{round:s.round,ammo:s.ammo};});
    await page.evaluate(()=>navalTest.target([{x:0,y:0}]));await page.locator('#mark-question').click();await idle();
    await page.evaluate(()=>navalTest.flush());await idle();
    // 等待此前真实卡片点击可能排队的250ms选择存档完成，再取稳定指纹。
    await page.waitForTimeout(350);await idle();
    const after=await page.evaluate(()=>{const s=navalTest.getState().state;return{round:s.round,ammo:s.ammo,mark:s.mapMarks['0,0']};});
    assert.equal(after.mark.kind,'question');assert.deepEqual({round:after.round,ammo:after.ammo},before);return after;
  });
  const expected=await fingerprint();report.saved=expected;await save();
  await check(`${ownedOrigin?'自有origin服务停机后':'模拟断网后'}刷新恢复同库、同状态与原revision/current/history`,async()=>{
    if(ownedOrigin){
      assert.ok(server&&server.exitCode===null,'只能关闭仍由本脚本持有handle的自建服务');
      server.kill('SIGTERM');await serverExit;
      await assert.rejects(fetch(origin),'停止后不能仍有其他服务接管同端口');
      report.originServer.stoppedBeforeNavigation=true;
    }else await context.setOffline(true);
    await page.reload({waitUntil:'domcontentloaded',timeout:30000});await engineReady(true);
    const actual=await fingerprint();assert.deepEqual(actual,expected);return actual;
  });
  await check('第二入口检测已有游戏，中文阻挡而不启动另一个引擎',async()=>{
    const second=await context.newPage();
    try{
      await second.goto(origin.href,{waitUntil:'domcontentloaded',timeout:30000});
      await second.waitForFunction(()=>!document.querySelector('#launch-retry')?.hidden,null,{timeout:15000});
      const text=await second.locator('#launch-status').innerText();assert.match(text,/已有游戏正在运行/);assert.ok(await second.locator('#launch-start').isDisabled());
      assert.equal(await second.evaluate(()=>!!window.navalTest),false);return{message:text};
    }finally{await second.close();}
  });
  await check(`${ownedOrigin?'origin服务停机后':'模拟断网后'}回入口再进入，原战役保持`,async()=>{
    await page.goto(origin.href,{waitUntil:'domcontentloaded',timeout:30000});await indexReady();
    await page.locator('#launch-start').click();await engineReady();
    await page.goto(new URL('game.html?test=1',origin).href,{waitUntil:'domcontentloaded',timeout:30000});await engineReady(true);
    const actual=await fingerprint();assert.deepEqual(actual,expected);return actual;
  });
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.crashes,[]);assert.deepEqual(report.externalRequests,[]);
  report.passed=true;
}catch(error){report.passed=false;report.fatal=error.stack||String(error);process.exitCode=1;}
finally{
  closing=true;if(context)await context.close();
  if(server&&server.exitCode===null&&!server.signalCode){server.kill('SIGTERM');await serverExit;}
  await new Promise(resolve=>setTimeout(resolve,150));
  report.finishedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({output,passed:report.passed,checks:report.checks.length,pageErrors:report.pageErrors.length,consoleErrors:report.consoleErrors.length,crashes:report.crashes.length}));
}
