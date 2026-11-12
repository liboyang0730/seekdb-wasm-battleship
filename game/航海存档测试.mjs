import test from 'node:test';
import assert from 'node:assert/strict';

let api;
try {
  api = await import('./航海存档.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

function exportsReady() {
  assert.ok(api, '航海存档模块应已实现');
  return api;
}

// 仅记录数据库边界，真实 SQL 由浏览器集成测试执行。
class RecordingDB {
  calls = [];
  queryRows = [];
  fail = null;
  archive = null;
  async call(method, sql) {
    assert.equal(this.archive.writing, true, '包括查询和回滚在内都应屏蔽存档自身的 SQL trace');
    this.calls.push({method, sql});
    const failure = this.fail?.(sql);
    if (failure) throw failure;
    await Promise.resolve();
    return {rows: method === 'query' ? (this.queryRows.shift() ?? []) : []};
  }
  exec(sql) { return this.call('exec', sql); }
  query(sql) { return this.call('query', sql); }
}

function fixture() {
  const {NavalArchive} = exportsReady();
  const db = new RecordingDB();
  const archive = new NavalArchive(db);
  db.archive = archive;
  return {db, archive};
}

const NAME = 'seekdb_naval_123';
const NEXT = 'seekdb_naval_124';
const currentRow = (overrides = {}) => ({
  schema_version: 1, revision: '7', payload_json: '{"phase":"defeat","usedFork":true}',
  pending_json: '{"kind":"enemy-response","round":4}', ...overrides,
});

test('数据库名严格白名单，同毫秒和时钟回拨仍生成递增名称', () => {
  const {isGameDatabaseName, makeGameDatabaseName} = exportsReady();
  for (const name of [NAME, 'seekdb_naval_0', 'seekdb_naval_0001']) assert.equal(isGameDatabaseName(name), true);
  for (const name of [null, 123, 'seekdb_naval_1;DROP DATABASE x', 'seekdb_naval_-1', 'other_1', `${NAME}\n`]) {
    assert.equal(isGameDatabaseName(name), false);
  }
  const first = makeGameDatabaseName(1000);
  const second = makeGameDatabaseName(1000);
  const third = makeGameDatabaseName(1, 'seekdb_naval_9999999999999');
  const number = name => BigInt(name.slice('seekdb_naval_'.length));
  assert.ok(number(second) > number(first));
  assert.ok(number(third) > 9999999999999n);
  for (const now of [-1, 1.5, NaN, Infinity, '1']) assert.throws(() => makeGameDatabaseName(now));
  assert.throws(() => makeGameDatabaseName(1, 'not_a_game'));
});

test('目录初始化使用全限定表，读取当前指针与未完成重置意图', async () => {
  const {db, archive} = fixture();
  assert.deepEqual(await archive.initCatalog(), {databaseName: null, reset: null});
  assert.match(db.calls[0].sql, /^CREATE DATABASE IF NOT EXISTS `seekdb_naval_catalog`/i);
  assert.ok(db.calls.some(call => /CREATE TABLE IF NOT EXISTS `seekdb_naval_catalog`\.`active_game`/i.test(call.sql)));
  db.queryRows.push([{database_name: NAME, reset_json: JSON.stringify({oldDatabase: NAME, newDatabase: NEXT})}]);
  assert.deepEqual(await archive.initCatalog(), {databaseName: NAME, reset: {oldDatabase: NAME, newDatabase: NEXT}});
  assert.equal(archive.writing, false);
  assert.equal(db.calls.some(call => /^\s*USE\s/i.test(call.sql)), false);
});

test('重置先保存旧指针和意图，完成后切换指针，拒绝非法名称', async () => {
  const {db, archive} = fixture();
  await archive.beginReset(NAME, NEXT);
  assert.match(db.calls.at(-1).sql, /REPLACE INTO `seekdb_naval_catalog`\.`active_game`/i);
  assert.ok(db.calls.at(-1).sql.includes(`'${NAME}'`));
  assert.ok(db.calls.at(-1).sql.includes('oldDatabase'));
  assert.ok(db.calls.at(-1).sql.includes(NEXT));
  await archive.finishReset(NEXT);
  assert.match(db.calls.at(-1).sql, /NULL\s*\)$/i);
  await archive.beginReset(null, NAME);
  assert.ok(db.calls.at(-1).sql.includes('NULL'));
  const count = db.calls.length;
  await assert.rejects(archive.beginReset(NAME, NAME));
  await assert.rejects(archive.beginReset('system', NEXT));
  await assert.rejects(archive.finishReset(`${NEXT};DROP DATABASE x`));
  assert.equal(db.calls.length, count);
  assert.equal(archive.writing, false);
});

test('游戏表包含完整快照与逐步历史字段，不更改当前 USE', async () => {
  const {db, archive} = fixture();
  await archive.initGame(NAME);
  const current = db.calls.find(call => /CREATE TABLE.*naval_current/i.test(call.sql))?.sql;
  const history = db.calls.find(call => /CREATE TABLE.*naval_history/i.test(call.sql))?.sql;
  assert.ok(current?.includes('`seekdb_naval_123`.`naval_current`'));
  for (const field of ['slot', 'schema_version', 'revision', 'payload_json', 'pending_json', 'updated_at']) assert.ok(current.includes(field));
  for (const field of ['revision', 'label', 'payload_json', 'pending_json', 'sql_json', 'created_at']) assert.ok(history?.includes(field));
  assert.equal(db.calls.some(call => /^\s*USE\s/i.test(call.sql)), false);
  assert.equal(archive.writing, false);
});

test('读档恢复失败与待结算状态和 revision，无行明确返回 null', async () => {
  const {db, archive} = fixture();
  db.queryRows.push([currentRow()]);
  assert.deepEqual(await archive.load(NAME), {
    payload: {phase: 'defeat', usedFork: true}, pending: {kind: 'enemy-response', round: 4}, revision: 7,
  });
  assert.equal(archive.revision, 7);
  db.queryRows.push([currentRow({pending_json: null})]);
  assert.equal((await archive.load(NAME)).pending, null);
  assert.equal(await archive.load(NEXT), null);
  assert.equal(archive.revision, 0);
  assert.equal(archive.writing, false);
});

test('版本、JSON 和 revision 异常明确报错，不静默新开局', async () => {
  const {db, archive} = fixture();
  archive.revision = 5;
  for (const row of [currentRow({schema_version: 2}), currentRow({payload_json: '{bad'}),
    currentRow({pending_json: 'undefined'}), currentRow({revision: '-1'}), currentRow({revision: '9007199254740992'})]) {
    db.queryRows.push([row]);
    await assert.rejects(archive.load(NAME));
    assert.equal(archive.revision, 5);
    assert.equal(archive.writing, false);
  }
  for (const row of [{database_name: 'mysql', reset_json: null}, {database_name: NAME, reset_json: '{bad'},
    {database_name: NAME, reset_json: '{"oldDatabase":"mysql","newDatabase":"seekdb_naval_124"}'}]) {
    db.queryRows.push([row]);
    await assert.rejects(archive.initCatalog());
  }
});

test('存档事务原子保存快照、pending 与 SQL 历史，并串行分配 revision', async () => {
  const {db, archive} = fixture();
  const payload = {note: "舰长 O'Brien\\bridge", phase: 'defeat'};
  const result = await archive.save(NAME, payload, {
    pending: {kind: 'fire', cell: {x: 1, y: 2}}, label: "自动'); DELETE FROM t; --", sql: ["SELECT '雷达'"],
  });
  assert.deepEqual(result, {revision: 1});
  assert.deepEqual(db.calls.map(call => call.sql.split(/\s/)[0]), ['BEGIN', 'REPLACE', 'INSERT', 'COMMIT']);
  assert.ok(db.calls[1].sql.includes("O''Brien"));
  assert.ok(db.calls[2].sql.includes("自动''); DELETE FROM t; --"));
  assert.ok(db.calls[2].sql.includes('SELECT'));
  assert.ok(db.calls[1].sql.includes('pending_json'));
  assert.equal(archive.revision, 1);
  db.calls.length = 0;
  const saves = await Promise.all([archive.save(NAME, {step: 2}), archive.save(NAME, {step: 3})]);
  assert.deepEqual(saves, [{revision: 2}, {revision: 3}]);
  assert.deepEqual(db.calls.map(call => call.sql.split(/\s/)[0]), ['BEGIN', 'REPLACE', 'INSERT', 'COMMIT', 'BEGIN', 'REPLACE', 'INSERT', 'COMMIT']);
  assert.equal(archive.writing, false);
});

test('写入或提交失败都回滚且不增 revision，回滚失败不掩盖原错误', async () => {
  for (const failedStep of ['BEGIN', 'REPLACE', 'INSERT', 'COMMIT']) {
    const {db, archive} = fixture();
    db.queryRows.push([currentRow()]);
    await archive.load(NAME);
    db.calls.length = 0;
    const original = new Error(`${failedStep} failed`);
    db.fail = sql => sql.startsWith(failedStep) ? original : sql === 'ROLLBACK' ? new Error('rollback failed') : null;
    await assert.rejects(archive.save(NAME, {phase: 'player'}), error => error === original);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(archive.revision, 7);
    assert.equal(archive.writing, false);
  }
  const {db, archive} = fixture();
  await assert.rejects(archive.save(NAME, undefined));
  await assert.rejects(archive.save(NAME, {}, {sql: 'SELECT 1'}));
  assert.equal(db.calls.length, 0, '格式校验应在 BEGIN 前完成');
});

test('历史原样返回，limit 与数据库名称不能注入 SQL', async () => {
  const {db, archive} = fixture();
  const rows = [{revision: 4, label: '命中', payload_json: '{"round":2}'}];
  db.queryRows.push(rows);
  assert.equal(await archive.history(NAME, 3), rows);
  assert.match(db.calls.at(-1).sql, /FROM `seekdb_naval_123`\.`naval_history` ORDER BY revision DESC LIMIT 3$/i);
  const count = db.calls.length;
  for (const limit of [0, -1, 1.5, '1;DROP TABLE t', Infinity]) await assert.rejects(archive.history(NAME, limit));
  for (const method of ['initGame', 'load', 'history']) await assert.rejects(archive[method]('mysql'));
  await assert.rejects(archive.save('mysql', {}));
  assert.equal(db.calls.length, count);
  assert.equal(archive.writing, false);
});
