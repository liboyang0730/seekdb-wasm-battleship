import test from 'node:test';
import assert from 'node:assert/strict';

let api;
try { api = await import('./engine/opfs-log-handles.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
let nextID = 100;

// 模拟持有同步访问句柄时浏览器拒绝 move 的真实约束，不模拟文件数据库。
function fixture(t, {name = 'observer.log', count = 1, noArgs = false, withFileHandles = false} = {}) {
  assert.ok(api, '应实现 OPFS 日志句柄适配模块');
  const events = [], allocated = [], ids = [];
  const fileID = ++nextID;
  let locks = 0;
  const file = {name, moveError:null, reopenError:null, entry:fileID,
    async isSameEntry(other) {return this.entry===other.entry;}};
  function access() {
    locks++;
    return {
      closed:false,
      flush() { assert.equal(this.closed,false); events.push('flush'); },
      close() { assert.equal(this.closed,false); this.closed=true;locks--;events.push('close'); },
      write(data) { assert.equal(this.closed,false);events.push(`write:${data}`);return data.length; },
    };
  }
  const open = args => {
    events.push({openArgs:args});
    if(file.reopenError)throw file.reopenError;
    return access();
  };
  file.createSyncAccessHandle = noArgs
    ? async function() {return open([...arguments]);}
    : async function(options) {return open([options]);};
  file.move = async (dir, name) => {
    events.push({move:[dir,name]});
    if(locks)throw Object.assign(new Error('file is locked'),{name:'NoModificationAllowedError'});
    if(file.moveError)throw file.moveError;
    file.name=name;
  };
  const allocator = {allocated,get(id){assert.ok(this.allocated[id],'access slot应有效');return this.allocated[id];},
    free(id){assert.ok(this.allocated[id],'只能释放尚有效的slot');this.allocated[id]=undefined;}};
  for(let i=0;i<count;i++){
    const id=++nextID;ids.push(id);allocated[id]=access();api.trackLogAccess(id,fileID,withFileHandles?file:undefined);
    t.after(()=>api.untrackLogAccess(id));
  }
  return {file,fileID,allocator,ids,events,locks:()=>locks};
}

test('日志轮转先flush/close再move，原ID重开后可继续write和close', async t => {
  const f=fixture(t),id=f.ids[0],old=f.allocator.get(id),dir={name:'log'};
  await api.moveWithLogHandles(f.fileID,f.file,dir,'observer.log.20261112',f.allocator);
  assert.deepEqual(f.events,['flush','close',{move:[dir,'observer.log.20261112']},{openArgs:[{mode:'in-place'}]}]);
  assert.equal(old.closed,true);assert.notEqual(f.allocator.get(id),old);
  assert.equal(f.allocator.get(id).write('next'),4);
  f.allocator.get(id).close();api.untrackLogAccess(id);assert.equal(f.locks(),0);
});

function allocationFixture(t, options = {}) {
  const f=fixture(t,{name:'allocation.tmp',withFileHandles:true,...options});
  const parent={name:'local',current:f.file,removeCalls:0,removeError:null,
    async getFileHandle(name){
      if(!this.current||name!=='allocation.tmp')throw Object.assign(new Error('missing'),{name:'NotFoundError'});
      return this.current;
    },
    async removeEntry(name){
      this.removeCalls++;f.events.push({remove:name});
      if(this.removeError)throw this.removeError;
      if(f.locks())throw Object.assign(new Error('file is locked'),{name:'NoModificationAllowedError'});
      this.current=null;
    },
  };
  // 用原条目清理测试中的待删登记，避免故意失败污染其他用例。
  t.after(async()=>{
    parent.removeError=null;parent.current=f.file;
    for(const id of f.ids){const a=f.allocator.allocated[id];if(a&&!a.closed){try{a.close();}catch{}}api.untrackLogAccess(id);}
    if(typeof api.removeRuntimeChild==='function')await api.removeRuntimeChild(parent,'allocation.tmp');
  });
  return {...f,parent};
}

test('allocation.tmp只在最后句柄关闭后真正删除，关闭前仍可读写原槽位', async t => {
  const f=allocationFixture(t),id=f.ids[0];
  await api.removeRuntimeChild(f.parent,'allocation.tmp');
  assert.equal(f.parent.removeCalls,0);assert.equal(f.allocator.get(id).write('alive'),5);
  await api.closeTrackedAccess(id,f.allocator);
  assert.equal(f.parent.removeCalls,1);assert.equal(f.parent.current,null);
  assert.equal(f.allocator.allocated[id],undefined);
});

test('同entry不同fileID的多句柄均计入，只有最后close触发删除', async t => {
  const f=allocationFixture(t,{count:2}),alias=Object.create(f.file);
  api.trackLogAccess(f.ids[1],++nextID,alias);
  await api.removeRuntimeChild(f.parent,'allocation.tmp');
  await api.closeTrackedAccess(f.ids[0],f.allocator);
  assert.equal(f.parent.removeCalls,0);assert.equal(f.locks(),1);
  await api.closeTrackedAccess(f.ids[1],f.allocator);
  assert.equal(f.parent.removeCalls,1);assert.equal(f.locks(),0);
});

test('没有跟踪句柄的allocation.tmp立即走真实删除', async t => {
  const f=allocationFixture(t,{count:0});
  await api.removeRuntimeChild(f.parent,'allocation.tmp');
  assert.equal(f.parent.removeCalls,1);assert.equal(f.parent.current,null);
});

test('持久数据文件或非local目录完全透传，不关闭任何访问句柄', async t => {
  for(const [name,parentName] of [['data','local'],['lock','local'],['clog_001','local'],['allocation.tmp','store']]){
    const f=fixture(t,{name,withFileHandles:true}),original=new Error('original remove failure');
    const parent={name:parentName,async removeEntry(actual){assert.equal(actual,name);throw original;},
      async getFileHandle(){assert.fail('非目标删除不能查询entry');}};
    await assert.rejects(api.removeRuntimeChild(parent,name),error=>error===original);
    assert.equal(f.allocator.get(f.ids[0]).closed,false);assert.deepEqual(f.events,[]);
    f.allocator.get(f.ids[0]).close();
  }
});

test('延迟临时文件close失败保留slot并报错，重试成功才释放与删除', async t => {
  const f=allocationFixture(t),id=f.ids[0],access=f.allocator.get(id),close=access.close;
  const original=new Error('close failed');let fail=true;
  access.close=function(){if(fail)throw original;return close.call(this);};
  await api.removeRuntimeChild(f.parent,'allocation.tmp');
  await assert.rejects(api.closeTrackedAccess(id,f.allocator),error=>error===original);
  assert.equal(f.allocator.get(id),access);assert.equal(f.parent.removeCalls,0);
  fail=false;await api.closeTrackedAccess(id,f.allocator);
  assert.equal(f.allocator.allocated[id],undefined);assert.equal(f.parent.removeCalls,1);
});

test('非延迟文件close失败仍按原loader释放slot，但原异常必须保留', async t => {
  const f=fixture(t,{name:'data',withFileHandles:true}),id=f.ids[0],access=f.allocator.get(id),close=access.close;
  const original=new Error('close failed');access.close=()=>{throw original;};
  await assert.rejects(api.closeTrackedAccess(id,f.allocator),error=>error===original);
  assert.equal(f.allocator.allocated[id],undefined);
  close.call(access);
});

test('延迟remove失败保留待删记录且close已释放，下一次删除能重试', async t => {
  const f=allocationFixture(t),id=f.ids[0],original=new Error('remove failed');
  await api.removeRuntimeChild(f.parent,'allocation.tmp');f.parent.removeError=original;
  await assert.rejects(api.closeTrackedAccess(id,f.allocator),error=>{
    assert.equal(error.accessClosed,true);assert.equal(error.cause,original);return true;
  });
  assert.equal(f.allocator.allocated[id],undefined);assert.equal(f.parent.current,f.file);
  f.parent.removeError=null;await api.removeRuntimeChild(f.parent,'allocation.tmp');
  assert.equal(f.parent.removeCalls,2);assert.equal(f.parent.current,null);
});

test('延迟期间同名条目被替代不能误删，身份比较失败也不能猜测删除', async t => {
  const f=allocationFixture(t),id=f.ids[0];
  await api.removeRuntimeChild(f.parent,'allocation.tmp');
  const replacement={name:'allocation.tmp',entry:++nextID};f.parent.current=replacement;
  await assert.rejects(api.closeTrackedAccess(id,f.allocator),error=>error.accessClosed===true);
  assert.equal(f.parent.current,replacement);assert.equal(f.parent.removeCalls,0);
  f.parent.current=f.file;await api.removeRuntimeChild(f.parent,'allocation.tmp');
  const broken=allocationFixture(t),original=new Error('identity failed');
  broken.file.isSameEntry=async()=>{throw original;};
  await assert.rejects(api.removeRuntimeChild(broken.parent,'allocation.tmp'),error=>error===original);
  assert.equal(broken.parent.removeCalls,0);assert.equal(broken.allocator.get(broken.ids[0]).closed,false);
  broken.file.isSameEntry=async function(other){return this.entry===other.entry;};
});

test('move失败后原文件句柄重开，抛出原move异常而不伪装成功', async t => {
  const f=fixture(t),original=new Error('move failed');f.file.moveError=original;
  await assert.rejects(api.moveWithLogHandles(f.fileID,f.file,{},'observer.log.old',f.allocator),error=>error===original);
  assert.equal(f.file.name,'observer.log');assert.equal(f.allocator.get(f.ids[0]).write('retry'),5);
  f.allocator.get(f.ids[0]).close();
});

test('非日志文件直接move，不触碰已登记handle或截获原异常', async t => {
  const f=fixture(t,{name:'clog_001'}),old=f.allocator.get(f.ids[0]);
  const original=new Error('CLOG move error');
  f.file.move=async()=>{f.events.push('direct-move');throw original;};
  await assert.rejects(api.moveWithLogHandles(f.fileID,f.file,{},'sstable_001',f.allocator),error=>error===original);
  assert.equal(old.closed,false);assert.deepEqual(f.events,['direct-move']);old.close();
});

test('按目标日志名识别，现代无参数createSyncAccessHandle使用原生无参形式', async t => {
  const f=fixture(t,{name:'temporary',noArgs:true});
  await api.moveWithLogHandles(f.fileID,f.file,{},'observer.log',f.allocator);
  assert.deepEqual(f.events.at(-1),{openArgs:[]});f.allocator.get(f.ids[0]).close();
});

test('同fileID所有handle恢复原slot，其他fileID和已untrack的slot不处理', async t => {
  const f=fixture(t,{count:2}),other=fixture(t,{name:'clog_002'});
  const removed=f.ids[1];f.allocator.get(removed).close();api.untrackLogAccess(removed);f.events.length=0;
  await api.moveWithLogHandles(f.fileID,f.file,{},'observer.log.1',f.allocator);
  assert.equal(f.events.filter(e=>e==='flush').length,1);
  assert.equal(other.events.length,0);assert.equal(other.allocator.get(other.ids[0]).closed,false);
  f.allocator.get(f.ids[0]).close();other.allocator.get(other.ids[0]).close();
  const multi=fixture(t,{count:2});
  await api.moveWithLogHandles(multi.fileID,multi.file,{},'observer.log.2',multi.allocator);
  for(const id of multi.ids){assert.equal(multi.allocator.get(id).write('x'),1);multi.allocator.get(id).close();}
});

test('重开失败明确抛错，move与重开同时失败时保留两条原因', async t => {
  for(const failMove of [false,true]){
    const f=fixture(t),reopenError=new Error('reopen failed'),moveError=new Error('move failed');
    f.file.reopenError=reopenError;if(failMove)f.file.moveError=moveError;
    await assert.rejects(api.moveWithLogHandles(f.fileID,f.file,{},'observer.log.3',f.allocator),error=>{
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.includes(reopenError));
      if(failMove){assert.equal(error.cause,moveError);assert.ok(error.errors.includes(moveError));}
      return true;
    });
    assert.equal(f.locks(),0);
  }
});

test('无已登记access的日志直接正常move，observer相似非日志名不误处理', async t => {
  const f=fixture(t,{count:0});
  await api.moveWithLogHandles(f.fileID,f.file,{},'observer.log.4',f.allocator);
  assert.equal(f.events.length,1);
  for(const name of ['observer.logbook','myobserver.log','observerXlog']){
    const other=fixture(t,{name});
    other.file.move=async()=>{other.events.push('move');};
    await api.moveWithLogHandles(other.fileID,other.file,{},'archive',other.allocator);
    assert.deepEqual(other.events,['move']);other.allocator.get(other.ids[0]).close();
  }
});

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}

// Emscripten的free允许清空已由轮转暂时腾空的slot；注册代次才表示该ID是否仍归原调用所有。
function raceFixture(t) {
  const f=fixture(t,{withFileHandles:true}),id=f.ids[0],old=f.allocator.get(id),close=old.close;
  old.close=function(){if(!this.closed)close.call(this);};
  f.allocator.free=function(slot){this.allocated[slot]=undefined;};
  function reuse(fileID=++nextID) {
    const replacement={name:'data',closed:false,write(value){assert.equal(this.closed,false);return value;},close(){this.closed=true;}};
    f.allocator.allocated[id]=replacement;
    api.trackLogAccess(id,fileID,{name:'data'});
    return replacement;
  }
  return {...f,id,old,reuse};
}

test('flush等待期间close并复用同ID，不清空新data句柄', async t => {
  const f=raceFixture(t),gate=deferred();f.old.flush=()=>gate.promise;
  const moving=api.moveWithLogHandles(f.fileID,f.file,{},'observer.log.flush-race',f.allocator);
  await api.closeTrackedAccess(f.id,f.allocator);
  const replacement=f.reuse();gate.resolve();await moving;
  assert.equal(f.allocator.allocated[f.id],replacement,'失去代次后不能清空新slot');
  assert.equal(replacement.write('kept'),'kept');replacement.close();
});

test('move等待期间close并复用同ID，不复活原日志slot', async t => {
  const f=raceFixture(t),entered=deferred(),gate=deferred(),move=f.file.move;
  f.file.move=async(...args)=>{await move(...args);entered.resolve();await gate.promise;};
  const moving=api.moveWithLogHandles(f.fileID,f.file,{},'observer.log.move-race',f.allocator);
  await entered.promise;await api.closeTrackedAccess(f.id,f.allocator);
  const replacement=f.reuse();gate.resolve();await moving;
  assert.equal(f.allocator.allocated[f.id],replacement,'move结束不能覆盖复用的slot');
  assert.equal(f.events.filter(e=>typeof e==='object'&&'openArgs' in e).length,0);replacement.close();
});

test('重开等待期间同ID及同fileID复用，关闭过期新句柄而不覆盖新slot', async t => {
  const f=raceFixture(t),entered=deferred(),gate=deferred();let stale;
  f.file.createSyncAccessHandle=async()=>{entered.resolve();await gate.promise;stale={closed:false,close(){this.closed=true;}};return stale;};
  const moving=api.moveWithLogHandles(f.fileID,f.file,{},'observer.log.reopen-race',f.allocator);
  await entered.promise;await api.closeTrackedAccess(f.id,f.allocator);
  const replacement=f.reuse(f.fileID);gate.resolve();await moving;
  assert.equal(f.allocator.allocated[f.id],replacement,'同fileID也必须区分注册代次');
  assert.equal(stale.closed,true,'失去所有权后新开的日志句柄必须关闭');replacement.close();
});

test('失去代次后新开的日志句柄关闭失败必须上抛，不能覆盖新data句柄', async t => {
  const f=raceFixture(t),entered=deferred(),gate=deferred(),original=new Error('stale reopen close failed');
  f.file.createSyncAccessHandle=async()=>{entered.resolve();await gate.promise;return{close(){throw original;}};};
  const moving=api.moveWithLogHandles(f.fileID,f.file,{},'observer.log.cleanup-race',f.allocator);
  const rejected=assert.rejects(moving,error=>error instanceof AggregateError&&error.errors.includes(original));
  await entered.promise;await api.closeTrackedAccess(f.id,f.allocator);
  const replacement=f.reuse();gate.resolve();await rejected;
  assert.equal(f.allocator.allocated[f.id],replacement);replacement.close();
});
