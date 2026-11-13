// 奖励展示回归：stage/confirm/win 是受控关卡夹具，实际SQL与OPFS照常执行，不代表自然通关。
// QA_OUTPUT 为目录，输出 report.json 与 L1/L2/L5 截图；只使用独立临时profile。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const url=new URL('?test=1',process.env.BASE_URL||'http://127.0.0.1:8905/');
const output=process.env.QA_OUTPUT||await mkdtemp(join(tmpdir(),'seekdb-reward-display-'));
const profile=await mkdtemp(join(tmpdir(),'seekdb-reward-profile-'));
await mkdir(output,{recursive:true});
const stepMs=Number(process.env.QA_STEP_TIMEOUT_MS||20000);
assert.ok(Number.isFinite(stepMs)&&stepMs>0&&stepMs<=30000,'单步超时须在0到30000ms之间');
const deadline=Date.now()+180000;
const report={startedAt:new Date().toISOString(),url:url.href,profile,
  scope:'六关受控stage/confirm/win夹具；真实seekdb SQL及OPFS，不声称自然通关。',
  checks:[],sqlProof:[],screenshots:[],pageErrors:[],consoleErrors:[],externalRequests:[],events:[]};
let context,page,closing=false,phase='启动',prompt;
const save=()=>writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
async function bounded(work,ms,label){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label}超时`)),ms);})]);}finally{clearTimeout(timer);}}
async function diagnostic(){return page?await page.evaluate(()=>({engine:document.querySelector('#engine-status')?.textContent,
  detail:document.querySelector('#engine-detail')?.textContent,save:document.querySelector('#save-status')?.textContent,
  view:window.navalTest?.getState().view,phase:window.navalTest?.getState().state?.phase,info:window.navalTest?.archiveInfo()})).catch(()=>null):null;}
async function collectSQL(){if(page)report.sqlProof.push(...await page.evaluate(()=>window.__rewardDisplaySQL?.splice(0)||[]).catch(()=>[]));}
async function check(name,work){phase=name;const start=Date.now();try{const data=await bounded(work(),Math.max(1,Math.min(stepMs,deadline-Date.now())),name);report.checks.push({name,passed:true,ms:Date.now()-start,data});console.log(JSON.stringify({name,passed:true}));return data;}
  catch(error){report.checks.push({name,passed:false,ms:Date.now()-start,error:{message:error.message,stack:error.stack},diagnostic:await diagnostic()});throw error;}
  finally{await collectSQL();await save();}}
async function idle(){await page.waitForFunction(()=>window.navalTest&&!navalTest.getState().busy,{},{timeout:stepMs});}
async function ready(){await page.waitForFunction(()=>window.navalTest||/失败/.test(document.querySelector('#engine-status')?.textContent||''),{},{timeout:stepMs});
  assert.ok(await page.evaluate(()=>Boolean(window.navalTest)),JSON.stringify(await diagnostic()));await idle();
  await page.evaluate(()=>{
    window.__rewardDisplaySQL=[];const db=navalTest.db,previous=db.onQuery;
    db.onQuery=entry=>{previous?.(entry);if(/^(?:MERGE TABLE|INSERT INTO capabilities|SELECT VERSION)/i.test(entry.sql))window.__rewardDisplaySQL.push({sql:entry.sql,error:entry.error||null,rows:entry.rows,ms:entry.elapsedMs});};
  });}
async function invoke(name,arg){await idle();await page.evaluate(({name,arg})=>navalTest[name](arg),{name,arg});await idle();}
async function rewardUI(){return await page.evaluate(()=>{
  const s=navalTest.getState(),gallery=document.querySelector('#reward-gallery');
  return{level:s.campaign.level,phase:s.state.phase,view:s.view,raw:structuredClone(s.state.rewardCards),pending:structuredClone(s.state.pendingRewards),
    medals:[...s.campaign.medals],confirmed:s.state.rewardsConfirmed,top:document.querySelector('#result-copy').textContent,
    confirmDisabled:document.querySelector('#confirm-rewards').disabled,nextDisabled:document.querySelector('#next-level').disabled,
    cards:[...gallery.querySelectorAll('.reward-card')].map(card=>({kind:card.dataset.rewardKind,id:card.dataset.rewardId,
      title:card.querySelector('h5')?.textContent,icon:card.querySelector('canvas')?.dataset.pixelIcon,
      effect:card.querySelector('.reward-effect')?.textContent||'',feature:card.querySelector('.reward-feature')?.textContent||'',
      featureTitle:card.querySelector('.reward-feature-title')?.textContent||'',featureUrl:card.querySelector('.reward-feature-link')?.href||'',
      pattern:card.querySelector('.reward-pattern')?.textContent||'',unlocks:[...card.querySelectorAll('.reward-unlock')].map(n=>n.textContent)}))};
});}
const rawCounts=[2,2,2,2,4,0],visibleCounts=[2,1,2,2,4,1],featureCounts=[2,1,1,1,2,0];
function verifyUI(ui,level){
  assert.equal(ui.level,level);assert.equal(ui.phase,'victory');assert.equal(ui.view,'result');
  assert.equal(ui.raw.length,rawCounts[level-1],'底层奖励列表不得因展示合并而改变');
  assert.equal(ui.cards.length,visibleCounts[level-1]);
  const features=ui.cards.map(c=>c.feature).filter(Boolean),effects=ui.cards.map(c=>c.effect).filter(Boolean);
  assert.equal(features.length,featureCounts[level-1]);assert.equal(new Set(features).size,features.length);assert.equal(new Set(effects).size,effects.length);
  assert.equal(ui.cards.filter(c=>c.featureUrl).length,features.length,'特性标题/正文/官方链接应成组去重');
  for(const card of ui.cards){assert.ok(card.icon);if(!card.feature){assert.equal(card.featureTitle,'');assert.equal(card.featureUrl,'');}}
  if(level<6){if(prompt===undefined)prompt=ui.top;assert.equal(ui.top,prompt,'各关页顶应保留中性领取提示');
    for(const raw of ui.raw)for(const text of [raw.description,raw.featureDescription])if(text)assert.ok(!ui.top.includes(text),'页顶不得复述完整奖励效果或特性');}
  if(level===2){assert.ok(ui.cards[0].unlocks.some(text=>text.includes('试错机会')));assert.equal(effects.length,1);}
  if(level===3){const skill=ui.cards.find(c=>c.kind==='skill'&&c.id==='mysql');assert.ok(skill);assert.equal(skill.icon,'dual');assert.match(skill.effect,/每四轮/);assert.equal(effects.length,2);}
  for(const raw of ui.raw.filter(c=>c.kind==='weapon')){
    const visible=ui.cards.find(c=>c.kind==='weapon'&&c.id===raw.id);assert.ok(visible,`武器${raw.id}应独立显示`);
    assert.equal(visible.icon,raw.icon);assert.equal(visible.effect,`游戏效果：${raw.description}`);
    if(raw.pattern){assert.ok(visible.pattern.includes(`${raw.pattern.size}×${raw.pattern.size}`));assert.ok(visible.pattern.includes(`${raw.pattern.cells.length}点`));}
  }
  if(level===5){assert.match(ui.cards.find(c=>c.id==='piercing'&&c.kind==='weapon').effect,/独立弹包/);assert.match(ui.cards.find(c=>c.id==='distributed_ii'&&c.kind==='weapon').effect,/共享/);}
  if(level===6)assert.equal(ui.cards[0].icon,'trophy');
}

try{
  await check('独立真实引擎与初始战役',async()=>{
    context=await chromium.launchPersistentContext(profile,{executablePath:process.env.BROWSER_EXECUTABLE,headless:true,chromiumSandbox:true,viewport:{width:1440,height:1080},reducedMotion:'reduce',timeout:stepMs});
    context.on('close',()=>report.events.push({event:'context-close',expected:closing}));
    await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===url.origin||['blob:','data:','about:'].includes(u.protocol))return route.continue();report.externalRequests.push(u.href);return route.abort();});
    page=context.pages()[0]||await context.newPage();
    page.on('pageerror',e=>report.pageErrors.push({phase,message:e.message,stack:e.stack}));page.on('crash',()=>report.events.push({event:'page-crash',phase}));
    page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push({phase,text:message.text()});});
    await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:stepMs});await ready();
    const version=(await page.evaluate(()=>navalTest.db.query('SELECT VERSION() AS version'))).rows;assert.match(version[0].version,/seekdb/i);
    await invoke('start','REWARD-DISPLAY-QA-CONTROLLED');return{version,isolated:await page.evaluate(()=>crossOriginIsolated)};
  });
  for(let level=1;level<=6;level++){
    const before=await check(`L${level}受控胜利：展示去重且原始奖励保留`,async()=>{
      await invoke('stage',level);await invoke('confirm');await invoke('win');
      const ui=await rewardUI();verifyUI(ui,level);assert.equal(ui.confirmed,false);assert.equal(ui.confirmDisabled,false);assert.equal(ui.nextDisabled,true);
      await page.evaluate(()=>{navalTest.target([]);navalTest.target([]);});
      assert.deepEqual(await rewardUI(),ui,'重复渲染不得沿用上次去重集合或修改原卡');return ui;
    });
    await check(`L${level}刷新恢复同一奖励页与展示结果`,async()=>{
      await collectSQL();await page.reload({waitUntil:'domcontentloaded',timeout:stepMs});await ready();
      const restored=await rewardUI();verifyUI(restored,level);assert.deepEqual(restored,before);
      if([1,2,5].includes(level)){
        await page.evaluate(()=>scrollTo(0,0));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const path=join(output,`reward-level-${level}.png`);await page.screenshot({path,fullPage:true,timeout:stepMs});report.screenshots.push({level,path,fixture:'受控win夹具，非自然通关'});
      }
      return restored;
    });
    await check(`L${level}确认奖励后允许继续，领取数据保持原语义`,async()=>{
      await page.locator('#confirm-rewards').click();await idle();await page.waitForTimeout(300);await idle();
      const ui=await rewardUI();assert.equal(ui.confirmed,true);assert.equal(ui.confirmDisabled,true);assert.equal(ui.nextDisabled,false);
      assert.deepEqual(ui.raw,before.raw);for(const id of before.pending)assert.ok(ui.medals.includes(id));
      if(level===3){await collectSQL();assert.ok(report.sqlProof.some(entry=>/INSERT INTO capabilities.*SELECT 'player'/s.test(entry.sql)),'MySQL奖励必须仍执行真实INSERT SELECT');}
      if(level<6){await page.locator('#next-level').click();await idle();await page.waitForTimeout(300);await idle();
        const next=await page.evaluate(()=>({level:navalTest.getState().campaign.level,phase:navalTest.getState().state.phase,view:navalTest.getState().view}));
        assert.deepEqual(next,{level:level+1,phase:'deploy',view:'deploy'});return{confirmed:ui.confirmed,medals:ui.medals,next};}
      return{confirmed:ui.confirmed,canStartNewGame:!ui.nextDisabled,medals:ui.medals};
    });
  }
  await check('页面无未处理异常，真实SQL夹具与截图齐全',async()=>{
    assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.externalRequests,[]);
    assert.equal(report.screenshots.length,3);assert.ok(report.sqlProof.filter(entry=>/^MERGE TABLE/i.test(entry.sql)).length>=6);
    return{screenshots:report.screenshots,sqlProofCount:report.sqlProof.length};
  });report.passed=true;
}catch(error){report.error={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;}
finally{
  closing=true;if(context)await bounded(context.close(),5000,'关闭自有浏览器').catch(error=>{report.events.push({event:'close-error',message:error.message});report.passed=false;process.exitCode=1;});
  report.finishedAt=new Date().toISOString();report.passedCount=report.checks.filter(c=>c.passed).length;report.failedCount=report.checks.filter(c=>!c.passed).length;
  await save();console.log(JSON.stringify({output,passed:Boolean(report.passed),passedCount:report.passedCount,failedCount:report.failedCount,error:report.error}));
}
