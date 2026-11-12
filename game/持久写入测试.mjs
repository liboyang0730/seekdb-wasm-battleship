import test from 'node:test';
import assert from 'node:assert/strict';

let persistentWrite;
try {
  ({persistentWrite} = await import('./持久写入.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

function ready() {
  assert.equal(typeof persistentWrite, 'function', '应实现持久写入模块');
}

const pressure = (code = 4030) => Object.assign(new Error('Server runtime memory limit exceeded'), {code});

function fixture() {
  ready();
  const events = [];
  return {
    events,
    db: {async exec(sql) { events.push({type: 'sql', sql}); return {rows: []}; }},
    async wait(ms) { events.push({type: 'wait', ms}); },
  };
}

test('直接成功原样返回，不刷盘、不等待、不报告重试', async () => {
  const {db, wait, events} = fixture();
  const value = {revision: 9};
  assert.equal(await persistentWrite(db, async () => value, {wait, onRetry() {assert.fail('不应重试');}}), value);
  assert.deepEqual(events, []);
});

test('数字和字符串4030各触发一次真实MINOR FREEZE，然后等候重试', async () => {
  for (const code of [4030, '4030']) {
    const {db, wait, events} = fixture();
    const original = pressure(code);
    const retries = [];
    let calls = 0;
    const result = await persistentWrite(db, async () => {
      events.push({type: 'work'});
      if (++calls === 1) throw original;
      return 'saved';
    }, {wait, onRetry: entry => retries.push(entry)});
    assert.equal(result, 'saved');
    assert.deepEqual(events, [{type:'work'}, {type:'sql',sql:'ALTER SYSTEM MINOR FREEZE'}, {type:'wait',ms:250}, {type:'work'}]);
    assert.deepEqual(retries, [{attempt: 1, lastError: original}]);
  }
});

test('默认15秒预算最多60次重试，耗尽抛首次原错误且只刷盘一次', async () => {
  const {db, wait, events} = fixture();
  const original = pressure();
  let calls = 0;
  const retries = [];
  await assert.rejects(persistentWrite(db, async () => {
    if (++calls === 1) throw original;
    throw pressure('4030');
  }, {wait, onRetry: entry => retries.push(entry)}), error => error === original);
  assert.equal(calls, 61);
  assert.equal(events.filter(event => event.type === 'sql').length, 1);
  assert.equal(events.filter(event => event.type === 'wait').reduce((sum,event) => sum + event.ms, 0), 15000);
  assert.equal(retries.length, 60);
  assert.equal(retries.at(-1).attempt, 60);
  assert.notEqual(retries.at(-1).lastError, original);
});

test('不足完整间隔时仅等待剩余预算，不越界多试', async () => {
  const {db, wait, events} = fixture();
  let calls = 0;
  await assert.rejects(persistentWrite(db, async () => {calls++; throw pressure();}, {wait, maxWaitMs:600, intervalMs:250}));
  assert.equal(calls, 4);
  assert.deepEqual(events.filter(event => event.type === 'wait').map(event => event.ms), [250,250,100]);
});

test('非4030原样抛出，不对权限、语法或其他错误自动重放', async () => {
  for (const code of [1064, '40300', -4030, '04030', undefined]) {
    const {db, wait, events} = fixture();
    const error = Object.assign(new Error('其他错误'), {code});
    let calls = 0;
    await assert.rejects(persistentWrite(db, async () => {calls++; throw error;}, {wait}), caught => caught === error);
    assert.equal(calls, 1);
    assert.deepEqual(events, []);
  }
});

test('刷盘失败立即结束，同时保留首次4030和刷盘错误', async () => {
  const {db, wait, events} = fixture();
  const original = pressure();
  const freezeError = new Error('minor freeze failed');
  db.exec = async sql => {events.push({type:'sql',sql}); throw freezeError;};
  let calls = 0;
  await assert.rejects(persistentWrite(db, async () => {calls++; throw original;}, {wait}), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, freezeError]);
    assert.equal(error.cause, freezeError);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(events.some(event => event.type === 'wait'), false);
});

test('重试遇到非4030立即抛新错误，不继续等到预算耗尽', async () => {
  const {db, wait, events} = fixture();
  const other = Object.assign(new Error('statement error'), {code:1064});
  let calls = 0;
  await assert.rejects(persistentWrite(db, async () => {if (++calls === 1) throw pressure(); throw other;}, {wait}), error => error === other);
  assert.equal(calls, 2);
  assert.equal(events.filter(event => event.type === 'wait').length, 1);
});

test('同步和异步提示回调报错均不改变重试结果', async () => {
  for (const onRetry of [() => {throw new Error('UI failed');}, async () => {throw new Error('async UI failed');}]) {
    const {db, wait} = fixture();
    let calls = 0;
    assert.equal(await persistentWrite(db, async () => {if (++calls === 1) throw pressure(); return 42;}, {wait, onRetry}), 42);
  }
});

test('无效预算或连接在执行work之前拒绝', async () => {
  const {db, wait, events} = fixture();
  let calls = 0;
  const work = async () => {calls++;};
  for (const options of [{maxWaitMs:0},{maxWaitMs:-1},{maxWaitMs:Infinity},{maxWaitMs:'15000'},
    {intervalMs:0},{intervalMs:NaN},{intervalMs:-1},{intervalMs:'250'}]) {
    await assert.rejects(persistentWrite(db, work, {...options,wait}));
  }
  await assert.rejects(persistentWrite({}, work, {wait}));
  await assert.rejects(persistentWrite(db, null, {wait}));
  assert.equal(calls, 0);
  assert.deepEqual(events, []);
});
