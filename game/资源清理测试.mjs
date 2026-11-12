import test from 'node:test';
import assert from 'node:assert/strict';

let api = {};
try { api = await import('./资源清理.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

function resources() {
  assert.equal(typeof api.DynamicTableResources, 'function', '缺少动态表资源登记与清理模块');
  return new api.DynamicTableResources();
}
const created = async () => ({ ok: true });
async function session(r, campaign, serial = campaign) {
  const names = { main: `notes_main_${campaign}`, live: `live_${campaign}_1_${serial}`,
    checkpoint: `checkpoint_${campaign}_1_${serial}`, notes: `notes_work_${campaign}_1_${serial}` };
  await r.create(names.main, created);
  await r.create(names.live, created);
  await r.create(names.checkpoint, created, names.live);
  await r.create(names.notes, created, names.main);
  return names;
}

test('只有成功CREATE/FORK才登记，SQL失败不留下虚构资源', async () => {
  const r = resources();
  await assert.rejects(r.create('notes_main_1', async () => { throw new Error('CREATE失败'); }), /CREATE失败/);
  assert.equal(r.size, 0);
  const result = { rows: [{ value: 1 }] };
  assert.equal(await r.create('notes_main_2', async () => result), result);
  await assert.rejects(r.create('notes_after_2_1_3', async () => { throw new Error('FORK失败'); }, 'notes_main_2'), /FORK失败/);
  assert.deepEqual(r.entries(), [{ name: 'notes_main_2', parent: null }]);
});

test('固定业务表与非生成名称不能登记，未知父源不能执行创建', async () => {
  const r = resources(); let calls = 0;
  const create = async () => { calls++; };
  for (const name of ['intelligence', 'sea_cells', 'capabilities', 'tactical_observations', 'radar_echoes',
    'naval_tactic_cells', 'naval_public_shots', 'naval_pattern_offsets', 'live_1;DROP TABLE intelligence', '`notes_main_1`']) {
    await assert.rejects(r.create(name, create), /动态表/);
  }
  await assert.rejects(r.create('checkpoint_1_1_2', create, 'live_1_1_2'), /父/);
  assert.equal(calls, 0);
  await r.create('notes_main_1', create);
  await assert.rejects(r.create('notes_main_1', create), /重复/);
  assert.equal(calls, 1);
});

test('活跃Fork的全部祖先都保留，废弃分支从叶子向父源删除', async () => {
  const r = resources(), current = await session(r, 2);
  await r.create('live_1_1_1', created);
  await r.create('checkpoint_1_1_1', created, 'live_1_1_1');
  await r.create('live_restore_1_1_3', created, 'checkpoint_1_1_1');
  const dropped = [];
  await r.cleanup({ keep: [current.checkpoint, current.notes], drop: async name => dropped.push(name) });
  assert.deepEqual(dropped, ['live_restore_1_1_3', 'checkpoint_1_1_1', 'live_1_1_1']);
  assert.equal(r.size, 4);
  assert.ok(r.entries().some(row => row.name === current.live));
  assert.ok(r.entries().some(row => row.name === current.main));
});

test('连续新战役替换后只保留当前四表，不累积旧战役', async () => {
  const r = resources(); let drops = 0;
  for (const campaign of [1, 2, 3]) {
    const current = await session(r, campaign);
    await r.cleanup({ keep: Object.values(current), drop: async () => { drops++; } });
    assert.equal(r.size, 4);
    assert.deepEqual(new Set(r.entries().map(row => row.name)), new Set(Object.values(current)));
  }
  assert.equal(drops, 8);
});

test('重新确认部署只替换旧checkpoint，保留当前live与笔记', async () => {
  const r = resources(), current = await session(r, 1), dropped = [];
  for (const serial of [2, 3, 4]) {
    const old = current.checkpoint;
    current.checkpoint = `checkpoint_edit_1_1_${serial}`;
    await r.create(current.checkpoint, created, current.live);
    await r.cleanup({ keep: Object.values(current), drop: async name => dropped.push(name) });
    assert.equal(r.size, 4);
    assert.equal(dropped.at(-1), old);
  }
  assert.deepEqual(dropped, ['checkpoint_1_1_1', 'checkpoint_edit_1_1_2', 'checkpoint_edit_1_1_3']);
});

test('重开保留checkpoint祖先，Merge后旧工作笔记可回收，跨关保留主笔记', async () => {
  const r = resources(), current = await session(r, 1), oldNotes = current.notes, dropped = [];
  current.live = 'live_restore_1_1_2'; current.notes = 'notes_after_1_1_2';
  await r.create(current.live, created, current.checkpoint);
  await r.create(current.notes, created, current.main);
  await r.cleanup({ keep: Object.values(current), drop: async name => dropped.push(name) });
  assert.deepEqual(dropped, [oldNotes]);
  assert.equal(r.size, 5);
  assert.ok(r.entries().some(row => row.name === 'live_1_1_1'));
  await r.cleanup({ keep: [current.main], drop: async name => dropped.push(name) });
  assert.deepEqual(r.entries(), [{ name: current.main, parent: null }]);
  assert.ok(dropped.indexOf(current.live) < dropped.indexOf(current.checkpoint));
  assert.ok(dropped.indexOf(current.checkpoint) < dropped.indexOf('live_1_1_1'));
});

test('动作失败恢复旧引用后，只清理已创建的孤立分支', async () => {
  const r = resources(), backup = await session(r, 1), dropped = [];
  await r.create('live_restore_1_1_2', created, backup.checkpoint);
  await r.create('notes_after_1_1_2', created, backup.main);
  await r.create('notes_main_3', created);
  await r.cleanup({ keep: Object.values(backup), drop: async name => dropped.push(name) });
  assert.deepEqual(new Set(dropped), new Set(['live_restore_1_1_2', 'notes_after_1_1_2', 'notes_main_3']));
  assert.deepEqual(new Set(r.entries().map(row => row.name)), new Set(Object.values(backup)));
});

test('DROP失败不抛回动作，父源也保留；下一动作可按依赖顺序重试', async () => {
  const r = resources(), old = await session(r, 1), attempted = [], warnings = [];
  const first = await r.cleanup({ keep: [], drop: async name => {
    attempted.push(name); if (name === old.checkpoint) throw new Error('暂时无法删除');
  }, warn: (name, error) => { warnings.push([name, error.message]); throw new Error('警告回调也不能影响动作'); } });
  assert.deepEqual(warnings, [[old.checkpoint, '暂时无法删除']]);
  assert.equal(attempted.filter(name => name === old.checkpoint).length, 1);
  assert.equal(attempted.includes(old.live), false, '失败子分支存在时不可删父源');
  assert.deepEqual(new Set(first.remaining), new Set([old.live, old.checkpoint]));
  const retried = [];
  await r.cleanup({ keep: [], drop: async name => retried.push(name) });
  assert.deepEqual(retried, [old.checkpoint, old.live]);
  assert.equal(r.size, 0);
});
