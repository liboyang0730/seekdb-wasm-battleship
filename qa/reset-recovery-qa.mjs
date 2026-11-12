// 真实 OPFS 重置恢复回归：仅独立临时浏览器；不替换 query、不修改游戏源码。
// PLAYWRIGHT_MODULE、BROWSER_EXECUTABLE、BASE_URL、QA_OUTPUT 均可由运行环境指定。
// QA_SCENARIOS=cold-only 单测空origin首次建局；notes-only 仅运行首次notes_main故障场景。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const url=new URL(process.env.BASE_URL||'http://127.0.0.1:8903/游戏.html');url.searchParams.set('test','1');
const output=process.env.QA_OUTPUT||join(tmpdir(),'seekdb-opfs-reset-intent.json');
const scenario=process.env.QA_SCENARIOS||'all';
if(scenario==='all') {
  // 空origin和已有旧局必须使用不同的新profile；子进程严格顺序启动，不并发浏览器。
  const source=new URL('../game/游戏逻辑.mjs',import.meta.url);
  const digest=async()=>createHash('sha256').update(await readFile(source)).digest('hex');
  const result={startedAt:new Date().toISOString(),url:url.href,sourceHash:await digest(),
    scope:'空origin与已有旧局的独立真实OPFS重置恢复；顺序两profile，每次一个浏览器。',runs:[],checks:[]};
  await mkdir(dirname(output),{recursive:true});
  for(const part of ['cold-only','warm']) {
    const partOutput=`${output.replace(/\.json$/,'')}-${part}.json`;
    const exitCode=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,QA_SCENARIOS:part,QA_OUTPUT:partOutput},stdio:'inherit'});
      child.once('error',reject);child.once('exit',(code,signal)=>resolve(signal?1:code));
    });
    const data=JSON.parse(await readFile(partOutput,'utf8'));
    result.runs.push({scenario:part,output:partOutput,exitCode,...data});
    result.checks.push(...data.checks.map(check=>({...check,scenario:part})));
  }
  result.pageErrors=result.runs.flatMap(run=>run.pageErrors.map(error=>({scenario:run.scenario,...error})));
  result.consoleErrors=result.runs.flatMap(run=>run.consoleErrors);
  result.externalRequests=result.runs.flatMap(run=>run.externalRequests);
  result.sourceHashAfter=await digest();result.sourceUnchanged=result.sourceHash===result.sourceHashAfter&&result.runs.every(run=>run.sourceUnchanged);
  result.passedCount=result.checks.filter(check=>check.passed).length;result.failedCount=result.checks.filter(check=>!check.passed).length;
  result.passed=result.runs.every(run=>run.passed&&run.exitCode===0)&&result.sourceUnchanged;
  result.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({output,passed:result.passed,passedCount:result.passedCount,failedCount:result.failedCount,pageErrors:result.pageErrors.length,sourceUnchanged:result.sourceUnchanged}));
  if(!result.passed)process.exitCode=1;
} else {
const profile=await mkdtemp(join(tmpdir(),'seekdb-reset-recovery-profile-'));
const source=new URL('../game/游戏逻辑.mjs',import.meta.url);
const hash=value=>createHash('sha256').update(value).digest('hex');
const report={startedAt:new Date().toISOString(),url:url.href,profile,
  sourceHash:hash(await readFile(source)),scope:'独立真实引擎：header重开后首次notes_main建表前触发真实1146；不修改query或SQL结果。',
  checks:[],sqlBeforeRefresh:[],sqlAfterRefresh:[],pageErrors:[],consoleErrors:[],externalRequests:[],events:[]};
await mkdir(dirname(output),{recursive:true});
let context,page,closing=false,activeCheck='启动';
const save=()=>writeFile(output,JSON.stringify(report,null,2)+'\n');
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label}超时${ms}ms`)),ms);})]);}finally{clearTimeout(timer);}}
async function diagnostic(){return page?await page.evaluate(()=>({engine:document.querySelector('#engine-status')?.textContent,
  detail:document.querySelector('#engine-detail')?.textContent,save:document.querySelector('#save-status')?.textContent,
  info:window.navalTest?.archiveInfo(),view:window.navalTest?.getState().view,phase:window.navalTest?.getState().state?.phase})).catch(()=>null):null;}
async function check(name,work,{continueOnFail=false}={}){
  activeCheck=name;
  const at=Date.now();try{const data=await bounded(work(),90000,name);report.checks.push({name,passed:true,ms:Date.now()-at,data});console.log(JSON.stringify({name,passed:true}));return data;}
  catch(error){report.checks.push({name,passed:false,ms:Date.now()-at,error:{name:error.name,message:error.message},diagnostic:await diagnostic()});console.log(JSON.stringify({name,passed:false,error:error.message}));if(!continueOnFail)throw error;}
  finally{await save();}
}
async function ready(){await page.waitForFunction(()=>window.navalTest||/失败/.test(document.querySelector('#engine-status')?.textContent||''),{},{timeout:80000});assert.ok(await page.evaluate(()=>Boolean(window.navalTest)),JSON.stringify(await diagnostic()));await idle();}
async function idle(){await page.waitForFunction(()=>window.navalTest&&!navalTest.getState().busy,{},{timeout:80000});}
async function inspect(){return await page.evaluate(async()=>{
  const db=navalTest.db,info=navalTest.archiveInfo(),catalog=(await db.query('SELECT database_name,reset_json FROM `seekdb_naval_catalog`.`active_game` WHERE slot=1')).rows;
  const databases=(await db.query('SHOW DATABASES')).rows;
  const name=info.database;
  if(!/^seekdb_naval_\d+$/.test(name))throw Error('检查目标数据库名无效');
  const tables=(await db.query(`SHOW TABLES FROM \`${name}\``)).rows;
  const current=(await db.query(`SELECT schema_version,revision,payload_json,pending_json FROM \`${name}\`.naval_current WHERE slot=1`)).rows;
  const state=navalTest.getState();
  return{info,catalog,databases,tables,current,view:state.view,phase:state.state?.phase,level:state.campaign?.level};
});}

try{
  await check('独立Chrome真实引擎与起始状态',async()=>{
    context=await chromium.launchPersistentContext(profile,{executablePath:process.env.BROWSER_EXECUTABLE,
      headless:true,chromiumSandbox:true,viewport:{width:1440,height:1080},reducedMotion:'reduce',timeout:20000});
    context.on('close',()=>report.events.push({event:'context-close',expected:closing}));
    await context.route('**/*',route=>{const target=new URL(route.request().url());if(target.origin===url.origin||['blob:','data:','about:'].includes(target.protocol))return route.continue();report.externalRequests.push(target.href);return route.abort();});
    page=context.pages()[0]||await context.newPage();
    page.on('pageerror',error=>report.pageErrors.push({phase:activeCheck,name:error.name,message:error.message,stack:error.stack}));page.on('crash',()=>report.events.push({event:'page-crash'}));
    page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
    await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:20000});await ready();
    report.engineVersion=(await page.evaluate(()=>navalTest.db.query('SELECT VERSION() AS version'))).rows;
    assert.match(report.engineVersion[0].version,/seekdb/i);
    if(process.env.QA_SCENARIOS==='cold-only'){
      const catalog=await page.evaluate(()=>navalTest.db.query('SELECT database_name,reset_json FROM `seekdb_naval_catalog`.`active_game` WHERE slot=1'));
      assert.deepEqual(catalog.rows,[],'cold-only必须使用全新profile空origin');
      return{emptyOrigin:true,version:report.engineVersion};
    }
    await page.evaluate(async()=>{await navalTest.start('RESET-INTENT-REGRESSION');await navalTest.confirm();await navalTest.flush();});await idle();
    report.before=await inspect();assert.equal(report.before.current.length,1);assert.equal(report.before.phase,'player');assert.equal(report.before.catalog[0].reset_json,null);
    return{database:report.before.info.database,revision:report.before.current[0].revision,version:report.engineVersion};
  });

  if(process.env.QA_SCENARIOS==='cold-only') {
  await check('空origin首次start的notes_main真实1146，reset.oldDatabase保留null',async()=>{
    await page.evaluate(()=>{
      const db=navalTest.db,originalExec=db.exec.bind(db),oldTrace=db.onQuery;
      window.__coldResetQA={fired:false,sql:[],fault:null};
      db.onQuery=entry=>{oldTrace?.(entry);window.__coldResetQA.sql.push({sql:entry.sql,error:entry.error||null,rowCount:entry.rows.length});};
      db.exec=async sql=>{
        if(!window.__coldResetQA.fired&&/^CREATE TABLE notes_main_/.test(sql)){
          window.__coldResetQA.fired=true;
          const invalidSQL='INSERT INTO `qa_reset_cold_missing_table` VALUES (1)';
          try{await originalExec(invalidSQL);throw Error('故障表不应存在');}
          catch(error){window.__coldResetQA.fault={originalSQL:sql,executedSQL:invalidSQL,code:error.code,sqlState:error.sqlState,message:error.message};throw error;}
        }
        return await originalExec(sql);
      };
      return navalTest.start('RESET-COLD-EXPLICIT-SEED');
    });await idle();
    report.coldFault=await page.evaluate(()=>window.__coldResetQA);
    assert.equal(Number(report.coldFault.fault.code),1146);report.coldFailure=await inspect();
    assert.equal(report.coldFailure.current.length,0);assert.notEqual(report.coldFailure.catalog[0].reset_json,null);
    const reset=JSON.parse(report.coldFailure.catalog[0].reset_json);
    assert.equal(reset.oldDatabase,null);assert.equal(reset.newDatabase,report.coldFailure.info.database);
    return{fault:report.coldFault.fault,reset,currentRows:0};
  });
  await check('空origin首次建局中断后刷新，同target自动deploy且有首份current',async()=>{
    await page.reload({waitUntil:'domcontentloaded',timeout:20000});await ready();report.coldReload=await inspect();
    const actual=report.coldReload;assert.equal(actual.info.database,report.coldFailure.info.database);
    assert.equal(actual.phase,'deploy');assert.equal(actual.view,'deploy');assert.equal(actual.level,1);
    assert.equal(actual.current.length,1);assert.equal(actual.catalog[0].reset_json,null);
    assert.equal(actual.catalog[0].database_name,actual.info.database);assert.ok(Number(actual.current[0].revision)>=1);
    return{database:actual.info.database,phase:actual.phase,revision:actual.current[0].revision,catalog:actual.catalog};
  });
  } else {
  await check('header重开首次notes_main建表被真实1146打断',async()=>{
    await page.evaluate(()=>{
      const db=navalTest.db,originalExec=db.exec.bind(db),oldTrace=db.onQuery;
      window.__resetRecoveryQA={fired:false,sql:[],fault:null};
      db.onQuery=entry=>{oldTrace?.(entry);window.__resetRecoveryQA.sql.push({sql:entry.sql,error:entry.error||null,rowCount:entry.rows.length,elapsedMs:entry.elapsedMs});};
      db.exec=async sql=>{
        if(!window.__resetRecoveryQA.fired&&/^CREATE TABLE notes_main_/.test(sql)){
          window.__resetRecoveryQA.fired=true;
          const invalidSQL='INSERT INTO `qa_reset_intent_missing_table` VALUES (1)';
          try{await originalExec(invalidSQL);throw Error('故障表不应存在');}
          catch(error){window.__resetRecoveryQA.fault={originalSQL:sql,executedSQL:invalidSQL,code:error.code,sqlState:error.sqlState,message:error.message};throw error;}
        }
        return await originalExec(sql);
      };
    });
    await page.locator('#restart-game').click();
    await page.waitForFunction(()=>window.__resetRecoveryQA.fired&&!navalTest.getState().busy,{},{timeout:80000});
    report.fault=await page.evaluate(()=>window.__resetRecoveryQA.fault);
    assert.equal(Number(report.fault.code),1146,'必须来自真实不存在表SQL的1146，不能用虚构异常替代');
    report.afterFailure=await inspect();report.sqlBeforeRefresh=await page.evaluate(()=>window.__resetRecoveryQA.sql);
    assert.notEqual(report.afterFailure.info.database,report.before.info.database);
    assert.equal(report.afterFailure.current.length,0,'故障发生在新局首份快照之前');
    return{fault:report.fault,newDatabase:report.afterFailure.info.database,catalog:report.afterFailure.catalog};
  });

  await check('首次快照失败后重置意图仍持久且指向同一新库',async()=>{
    const row=report.afterFailure.catalog[0];
    assert.notEqual(row.reset_json,null,'P1：新局首次快照提交之前，不得清除catalog.reset_json');
    const reset=JSON.parse(row.reset_json);assert.equal(reset.oldDatabase,report.before.info.database);
    assert.equal(reset.newDatabase,report.afterFailure.info.database);
    return{reset,pointer:row.database_name};
  },{continueOnFail:true});

  await check('刷新自动续建同一新局，生成current且旧库不复活',async()=>{
    // 页面重载移除这次exec故障注入；后续全部调用原始数据库接口。
    await page.reload({waitUntil:'domcontentloaded',timeout:20000});await ready();
    report.afterReload=await inspect();
    const actual=report.afterReload;
    assert.equal(actual.info.database,report.afterFailure.info.database);
    assert.equal(actual.phase,'deploy','刷新应自动完成新局，不能停留在空白welcome');
    assert.equal(actual.view,'deploy');assert.equal(actual.level,1);assert.equal(actual.current.length,1);
    assert.ok(Number(actual.current[0].revision)>=1);assert.equal(actual.current[0].pending_json,null);
    assert.equal(actual.catalog[0].reset_json,null,'成功提交新局快照后才清除重置意图');
    assert.ok(!actual.databases.some(row=>Object.values(row).includes(report.before.info.database)),'旧库不应复活');
    const payload=JSON.parse(actual.current[0].payload_json);assert.equal(payload.state.phase,'deploy');assert.equal(payload.campaign.level,1);
    return{database:actual.info.database,revision:actual.current[0].revision,phase:actual.phase,databases:actual.databases};
  },{continueOnFail:true});

  if(process.env.QA_SCENARIOS!=='notes-only') {
  await check('首次current REPLACE前暂停：已有动态表但reset意图仍在',async()=>{
    await page.evaluate(()=>navalTest.flush());await idle();report.pauseOldDatabase=await page.evaluate(()=>navalTest.archiveInfo().database);
    await page.evaluate(oldDatabase=>{
      const db=navalTest.db,originalExec=db.exec.bind(db),oldTrace=db.onQuery;
      window.__resetPauseQA={fired:false,oldDatabase,sql:[]};
      db.onQuery=entry=>{oldTrace?.(entry);window.__resetPauseQA.sql.push({sql:entry.sql,error:entry.error||null,rowCount:entry.rows.length});};
      db.exec=async sql=>{
        const match=/^REPLACE INTO `(seekdb_naval_\d+)`\.`naval_current`/.exec(sql);
        if(!window.__resetPauseQA.fired&&match&&match[1]!==oldDatabase){
          window.__resetPauseQA.fired=true;window.__resetPauseQA.targetDatabase=match[1];window.__resetPauseQA.pausedSQL=sql;
          // 仅暂停这条尚未发给引擎的 REPLACE；不伪造结果、不提交当前事务。
          return await new Promise(()=>{});
        }
        return await originalExec(sql);
      };
    },report.pauseOldDatabase);
    await page.locator('#restart-game').click();await page.waitForFunction(()=>window.__resetPauseQA.fired,{},{timeout:80000});
    report.beforeFirstCommit=await inspect();report.pausedStatement=await page.evaluate(()=>({targetDatabase:window.__resetPauseQA.targetDatabase,pausedSQL:window.__resetPauseQA.pausedSQL,sql:window.__resetPauseQA.sql}));
    assert.equal(report.beforeFirstCommit.current.length,0);
    assert.ok(report.beforeFirstCommit.tables.some(row=>Object.values(row).some(name=>/^notes_main_/.test(name))),'必须实际创建动态表后才测试刷新，覆盖同名表重建冲突');
    assert.notEqual(report.beforeFirstCommit.catalog[0].reset_json,null);
    const reset=JSON.parse(report.beforeFirstCommit.catalog[0].reset_json);
    assert.equal(reset.oldDatabase,report.pauseOldDatabase);assert.equal(reset.newDatabase,report.pausedStatement.targetDatabase);
    return{oldDatabase:report.pauseOldDatabase,newDatabase:reset.newDatabase,currentRows:0,tables:report.beforeFirstCommit.tables,reset};
  });

  await check('首份快照提交前刷新，同名target重建后自动deploy',async()=>{
    await page.reload({waitUntil:'domcontentloaded',timeout:20000});await ready();report.afterFirstCommitReload=await inspect();
    const actual=report.afterFirstCommitReload;assert.equal(actual.info.database,report.pausedStatement.targetDatabase);
    assert.equal(actual.phase,'deploy');assert.equal(actual.view,'deploy');assert.equal(actual.current.length,1);
    assert.equal(actual.catalog[0].reset_json,null);assert.ok(Number(actual.current[0].revision)>=1);
    assert.ok(!actual.databases.some(row=>Object.values(row).includes(report.pauseOldDatabase)));
    return{database:actual.info.database,phase:actual.phase,revision:actual.current[0].revision,tables:actual.tables,databases:actual.databases};
  });

  await check('首次COMMIT后finishReset用真实catalog SQL触发1146',async()=>{
    report.finalizeOldDatabase=report.afterFirstCommitReload.info.database;
    await page.evaluate(()=>{
      const db=navalTest.db,originalExec=db.exec.bind(db),oldTrace=db.onQuery;
      window.__resetFinalizeQA={fired:false,sql:[],fault:null};
      db.onQuery=entry=>{oldTrace?.(entry);window.__resetFinalizeQA.sql.push({sql:entry.sql,error:entry.error||null,rowCount:entry.rows.length});};
      db.exec=async sql=>{
        if(!window.__resetFinalizeQA.fired&&/^REPLACE INTO `seekdb_naval_catalog`\.`active_game`/.test(sql)&&/,\s*NULL\s*\)\s*;?$/.test(sql)){
          window.__resetFinalizeQA.fired=true;
          const invalidSQL='INSERT INTO `qa_reset_finalize_missing_table` VALUES (1)';
          try{await originalExec(invalidSQL);throw Error('故障表不应存在');}
          catch(error){window.__resetFinalizeQA.fault={originalSQL:sql,executedSQL:invalidSQL,code:error.code,sqlState:error.sqlState,message:error.message};throw error;}
        }
        return await originalExec(sql);
      };
    });
    await page.locator('#restart-game').click();
    await page.waitForFunction(()=>window.__resetFinalizeQA.fired&&!navalTest.getState().busy,{},{timeout:80000});
    report.afterFinalizeFailure=await inspect();report.finalizeInjection=await page.evaluate(()=>window.__resetFinalizeQA);
    assert.equal(Number(report.finalizeInjection.fault.code),1146);
    const actual=report.afterFinalizeFailure;assert.equal(actual.current.length,1,'finishReset故障必须发生在首份快照真实COMMIT后');
    assert.notEqual(actual.catalog[0].reset_json,null);
    const reset=JSON.parse(actual.catalog[0].reset_json);assert.equal(reset.oldDatabase,report.finalizeOldDatabase);assert.equal(reset.newDatabase,actual.info.database);
    report.committedSeed=JSON.parse(actual.current[0].payload_json).campaign.seed;
    return{fault:report.finalizeInjection.fault,database:actual.info.database,revision:actual.current[0].revision,committedSeed:report.committedSeed,reset};
  });

  await check('finishReset失败后刷新保留已提交payload与种子，只完成pointer收尾',async()=>{
    await page.reload({waitUntil:'domcontentloaded',timeout:20000});await ready();report.afterFinalizeReload=await inspect();
    const actual=report.afterFinalizeReload,committed=report.afterFinalizeFailure;
    assert.equal(actual.info.database,committed.info.database);assert.deepEqual(actual.current,committed.current,'已有完整首档不能drop重建或重新生成seed');
    assert.equal(actual.phase,'deploy');assert.equal(actual.view,'deploy');assert.equal(actual.catalog[0].database_name,committed.info.database);assert.equal(actual.catalog[0].reset_json,null);
    assert.equal(JSON.parse(actual.current[0].payload_json).campaign.seed,report.committedSeed);
    assert.ok(!actual.databases.some(row=>Object.values(row).includes(report.finalizeOldDatabase)));
    return{database:actual.info.database,revision:actual.current[0].revision,seed:report.committedSeed,payloadHash:hash(actual.current[0].payload_json),databases:actual.databases};
  });
  }
  }
  await check('故障处理及恢复不产生未捕获页面异常',async()=>{
    assert.deepEqual(report.pageErrors,[],'注入的SQL错误应被游戏处理，不应产生额外页面异常');
    return{pageErrors:0,consoleErrors:report.consoleErrors.length};
  });
}catch(error){report.error={name:error.name,message:error.message,stack:error.stack};}
finally{
  closing=true;if(context)await bounded(context.close(),10000,'关闭独立Chrome').catch(error=>report.events.push({event:'close-error',message:error.message}));
  report.sourceHashAfter=hash(await readFile(source));report.sourceUnchanged=report.sourceHash===report.sourceHashAfter;
  report.passedCount=report.checks.filter(check=>check.passed).length;report.failedCount=report.checks.filter(check=>!check.passed).length;
  report.passed=!report.error&&report.failedCount===0;report.finishedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({output,passed:report.passed,passedCount:report.passedCount,failedCount:report.failedCount,error:report.error,sourceUnchanged:report.sourceUnchanged,profile}));
  if(!report.passed)process.exitCode=1;
}
}
