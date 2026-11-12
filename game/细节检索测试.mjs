// Node注册测试，浏览器只导出真实seekdb可执行的fixtures。
const inNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
const test = inNode ? (await import('node:test')).default : () => {};
const assert = inNode ? (await import('node:assert/strict')).default : null;
const { createDetailEvidence, buildDetailQuery, isTacticalClueKind, TACTICAL_CLUE_KINDS } = await import('./细节检索.mjs');
const { LEVELS, createEnemyFleet, generateEvidence } = await import('./海战规则.mjs');

function setup(level, seed = `detail-test-${level}`, round = 1) {
  const fleet = createEnemyFleet({ level, seed });
  const evidence = generateEvidence({ fleet, level, seed, round });
  const detail = createDetailEvidence({ evidence, level, seed });
  return { evidence, detail };
}
const distance = (a, b) => Math.sqrt(a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0));

test('共享kind覆盖六关真实extra，非战术目录不进入手册且无需新增表字段', () => {
  assert.deepEqual(TACTICAL_CLUE_KINDS, ['dense_half', 'full_ship_band', 'empty_patch', 'ship_orientation', 'ship_crossline', 'submarine_region']);
  assert.equal(isTacticalClueKind('non_tactical'), false);
  assert.equal(isTacticalClueKind(undefined), false);
  const expected = [['full_ship_band'], ['empty_patch'], ['ship_orientation'], ['ship_crossline'],
    ['submarine_region', 'empty_patch'], ['submarine_region', 'empty_patch']];
  for (const level of LEVELS) {
    const { detail } = setup(level.id);
    const targets = detail.rows.filter(row => isTacticalClueKind(row.kind));
    assert.deepEqual(targets.map(row => row.kind), expected[level.id - 1]);
    assert.ok(targets.every(row => !Object.hasOwn(row, 'cells') && !Object.hasOwn(row, 'proof')));
  }
});

test('仅投影既有可靠额外线索：不复制dense_half/cells/舰体，也不改输入', () => {
  for (const level of LEVELS) {
    const { evidence, detail } = setup(level.id);
    const before = JSON.stringify(evidence);
    const row = evidence.rows.find(item => evidence.truth.reliableRowIds.includes(item.id));
    const extras = JSON.parse(row.tactical_clues).slice(1);
    const targets = detail.rows.filter(item => extras.some(clue => clue.id === item.clue_id));
    assert.equal(targets.length, level.size === 12 ? 2 : 1);
    for (const target of targets) {
      const clue = extras.find(item => item.id === target.clue_id);
      assert.equal(target.kind, clue.kind);
      assert.equal(target.clue_text, clue.text);
      assert.deepEqual(Object.keys(target).sort(), ['id', 'sector_id', 'mission_id', 'observed_round', 'clue_id', 'kind', 'clue_text', 'body', 'source', 'embedding', 'payload_json'].sort());
      assert.equal(target.observed_round, 1);
      assert.equal(target.sector_id, row.sector_id);
      assert.equal(target.mission_id, evidence.missionId);
    }
    assert.ok(detail.rows.every(item => item.kind !== 'dense_half'));
    assert.doesNotMatch(JSON.stringify(detail), /"hp"|"ships"|"fleet"|ship_id/);
    assert.equal(JSON.stringify(evidence), before);
  }
});

test('同seed、JSON快照、资料轮次变化与排列变化不会改变细节资料', () => {
  for (const level of LEVELS) {
    const seed = `fixed-detail-${level.id}`;
    const { evidence, detail } = setup(level.id, seed);
    assert.deepEqual(createDetailEvidence({ evidence: JSON.parse(JSON.stringify(evidence)), level, seed }), detail);
    const shuffled = { ...evidence, rows: [...evidence.rows].reverse() };
    assert.deepEqual(createDetailEvidence({ evidence: shuffled, level, seed }), detail);
    assert.deepEqual(setup(level.id, seed, 50).detail, detail);
  }
});

test('人工回波有八维可解释向量，专用英文词与舰队呼号不同', () => {
  for (const level of LEVELS) {
    const { evidence, detail } = setup(level.id);
    assert.deepEqual(detail.samples.map(sample => sample.name).sort(), ['civil', 'noise', 'warship']);
    for (const sample of detail.samples) {
      assert.equal(typeof sample.label, 'string');
      assert.equal(sample.vector.length, 8);
      assert.ok(sample.vector.every(Number.isFinite));
    }
    assert.match(detail.keyword, /^[A-Z]{4,16}$/);
    assert.notEqual(detail.keyword, evidence.callSign);
    assert.equal(detail.keywordOptions.length, 3);
    assert.equal(new Set(detail.keywordOptions.map(option => option.keyword)).size, 3);
    assert.ok(detail.keywordOptions.some(option => option.keyword === detail.keyword));
    assert.ok(detail.keywordOptions.every(option => option.keyword !== evidence.callSign));
  }
});

test('有效输入来自单张剧本卡，实际body含关键词/回波来源/观测文字且不改原几何', () => {
  for (const level of LEVELS) for (let index = 0; index < 12; index++) {
    const { evidence, detail } = setup(level.id, `story-evidence-${index}`);
    const { signalStory } = detail;
    assert.ok(signalStory);
    assert.equal(detail.keyword, signalStory.listen.keyword);
    assert.deepEqual(detail.samples.find(sample => sample.name === 'warship').vector, signalStory.echo.vector);
    const targets = detail.rows.filter(row => isTacticalClueKind(row.kind));
    const original = JSON.parse(evidence.rows.find(row => evidence.truth.reliableRowIds.includes(row.id)).tactical_clues).slice(1);
    for (const row of targets) {
      assert.ok(row.body.includes(signalStory.listen.keyword));
      assert.ok(row.body.includes(signalStory.echo.source));
      assert.ok(row.body.includes(signalStory.echo.text));
      assert.equal(row.clue_text, original.find(clue => clue.id === row.clue_id).text);
      assert.deepEqual(row.embedding, signalStory.echo.vector);
    }
  }
});

test('全文和向量单模可各自生成SQL，混合模式默认兼容且保留任务海区边界', () => {
  const good = { sectorId: 'S1', missionId: 'mission', vector: Array(8).fill(0.5), keyword: 'ANCHOR' };
  const vector = buildDetailQuery({ ...good, keyword: undefined, mode: 'vector' });
  assert.equal(vector.valid, true); assert.ok(!vector.sql.includes('MATCH(body)'));
  assert.match(vector.sql, /l2_distance/);
  const fulltext = buildDetailQuery({ ...good, vector: undefined, mode: 'fulltext' });
  assert.equal(fulltext.valid, true); assert.ok(!fulltext.sql.includes('l2_distance'));
  assert.match(fulltext.sql, /MATCH\(body\)/); assert.match(fulltext.sql, /NULL AS distance/);
  for (const query of [vector, fulltext, buildDetailQuery(good)]) {
    assert.match(query.sql, /source, body, payload_json,/);
    assert.match(query.sql, /mission_id = 'mission'/);
    assert.match(query.sql, /sector_id = 'S1'/);
    assert.match(query.sql, /observed_round >= 1/);
  }
  assert.deepEqual(buildDetailQuery(good), buildDetailQuery({ ...good, mode: 'hybrid' }));
  assert.equal(buildDetailQuery({ ...good, mode: 'unknown' }).valid, false);
  assert.equal(buildDetailQuery({ ...good, vector: undefined }).valid, false);
  assert.equal(buildDetailQuery({ ...good, keyword: undefined }).valid, false);
});

test('SQL payload仅含本地粗几何与幂等支持协议，noise没有协议或舰位', () => {
  const codes = ['radar_recommend', 'safe_mark', 'relay_target', 'radar_sweep', 'radar_filter', 'pattern_plan'];
  for (const level of LEVELS) {
    const { evidence, detail } = setup(level.id);
    const row = evidence.rows.find(item => evidence.truth.reliableRowIds.includes(item.id));
    const whole = JSON.parse(row.cells), minX = Math.min(...whole.map(cell => cell.x)), minY = Math.min(...whole.map(cell => cell.y));
    const originals = JSON.parse(row.tactical_clues).slice(1);
    for (const target of detail.rows) {
      assert.equal(typeof target.payload_json, 'string');
      const payload = JSON.parse(target.payload_json);
      if (!isTacticalClueKind(target.kind)) { assert.deepEqual(payload, {}); continue; }
      assert.equal(payload.protocol.id, `level-${level.id}-support`);
      assert.equal(payload.protocol.code, codes[level.id - 1]);
      assert.ok(!Object.hasOwn(payload.protocol, 'ammo'));
      const original = originals.find(clue => clue.id === target.clue_id);
      assert.equal(payload.clue.kind, original.kind);
      assert.deepEqual(payload.clue.cells, (original.cells ?? []).map(cell => ({ x: cell.x - minX, y: cell.y - minY })));
      assert.ok(payload.clue.cells.every(cell => cell.x >= 0 && cell.x < level.size && cell.y >= 0 && cell.y < level.size));
      assert.doesNotMatch(target.payload_json, /"hp"|"ships"|"fleet"|ship_id|occupied/);
      if (level.id === 3) { assert.equal(payload.protocol.target_length, 5); assert.equal(payload.protocol.period, 4); }
      if (level.id === 4) { assert.equal(payload.protocol.enemy_period, 3); assert.equal(payload.protocol.max_enemy_shots, 1); }
    }
  }
});

test('实际资料正交：漏全文或向量均增加干扰；跨任务、跨区、档案噪声确实存在', () => {
  for (const level of LEVELS) {
    const { evidence, detail } = setup(level.id);
    const sector = evidence.rows.find(row => evidence.truth.reliableRowIds.includes(row.id)).sector_id;
    const current = detail.rows.filter(row => row.mission_id === evidence.missionId && row.sector_id === sector && row.observed_round >= 1);
    const warship = detail.samples.find(sample => sample.name === 'warship').vector;
    const target = current.filter(row => row.body.split(/[^A-Z]+/).includes(detail.keyword) && distance(row.embedding, warship) <= 0.42);
    assert.equal(target.length, level.size === 12 ? 2 : 1);
    assert.ok(current.filter(row => distance(row.embedding, warship) <= 0.42).length > target.length);
    assert.ok(current.filter(row => row.body.split(/[^A-Z]+/).includes(detail.keyword)).length > target.length);
    assert.ok(detail.rows.some(row => row.mission_id !== evidence.missionId && distance(row.embedding, warship) <= 0.42));
    assert.ok(detail.rows.some(row => row.sector_id !== sector && distance(row.embedding, warship) <= 0.42));
    assert.ok(detail.rows.some(row => row.observed_round === 0 && distance(row.embedding, warship) <= 0.42));
    for (const sample of detail.samples.filter(item => item.name !== 'warship')) {
      assert.ok(target.every(row => distance(row.embedding, sample.vector) > 0.42));
    }
  }
});

test('缺失或非法输入不生成SQL', () => {
  const good = { sectorId: 'S1', missionId: 'mission', vector: Array(8).fill(0.5), keyword: 'ANCHOR' };
  for (const patch of [{ sectorId: '' }, { missionId: '' }, { keyword: '' }, { vector: [] }, { vector: Array(7).fill(0) },
    { vector: [NaN, ...Array(7).fill(0)] }, { vector: [Infinity, ...Array(7).fill(0)] }, { vector: Array(8).fill('1') }]) {
    const result = buildDetailQuery({ ...good, ...patch });
    assert.equal(result.valid, false);
    assert.equal(result.sql, '');
    assert.equal(typeof result.error, 'string');
  }
  assert.equal(buildDetailQuery().valid, false);
  assert.equal(buildDetailQuery(null).valid, false);
  assert.equal(buildDetailQuery([]).valid, false);
  assert.throws(() => createDetailEvidence(), /资料|可靠/);
  const { evidence } = setup(1);
  assert.throws(() => createDetailEvidence({ evidence: { ...evidence, rows: [] }, level: 1 }), /可靠/);
});

test('SQL直接组合全文与l2，并安全转义字符串字面量', () => {
  const result = buildDetailQuery({ sectorId: 'S1', missionId: "task'\\archive", vector: Array(8).fill(0.5), keyword: "ANCHOR'\\BEACON" });
  assert.equal(result.valid, true);
  assert.equal(result.error, null);
  assert.match(result.sql, /^SELECT clue_id, kind, clue_text, source, body, payload_json,\n  l2_distance\(embedding, '\[0\.5/);
  assert.ok(result.sql.includes("mission_id = 'task''\\\\archive'"));
  assert.ok(result.sql.includes("AGAINST ('ANCHOR''\\\\BEACON' IN NATURAL LANGUAGE MODE)"));
  assert.match(result.sql, /FROM tactical_observations/);
  assert.match(result.sql, /observed_round >= 1/);
  assert.match(result.sql, /l2_distance\(embedding,[^\n]+\) <= 0\.42/);
  assert.match(result.sql, /ORDER BY distance, id\nLIMIT 6$/);
  assert.ok(!result.sql.includes('?'));
});

/** 交给真实seekdb执行；expectedClueIds来自已知资料身份，不在此实现SQL替身。 */
export function browserDetailFixtures() {
  return LEVELS.map(level => {
    const { evidence, detail } = setup(level.id, `browser-detail-${level.id}`);
    const row = evidence.rows.find(item => evidence.truth.reliableRowIds.includes(item.id));
    const warship = detail.samples.find(sample => sample.name === 'warship');
    const civil = detail.samples.find(sample => sample.name === 'civil');
    const otherKeyword = detail.keywordOptions.find(option => option.keyword !== detail.keyword).keyword;
    const input = { sectorId: row.sector_id, missionId: evidence.missionId, vector: warship.vector, keyword: detail.keyword };
    const good = buildDetailQuery(input);
    const extras = JSON.parse(row.tactical_clues).slice(1).map(clue => clue.id);
    const byKind = suffix => detail.rows.filter(item => item.id.endsWith(suffix)).map(item => item.clue_id);
    const wrongWordRows = detail.rows.filter(item => item.body.split(/[^A-Z]+/).includes(otherKeyword) && item.mission_id === evidence.missionId && item.sector_id === row.sector_id && item.observed_round >= 1 && item.source === '信号校准站').map(item => item.clue_id);
    return { level: level.id, rows: detail.rows, keyword: detail.keyword, samples: detail.samples, keywordOptions: detail.keywordOptions,
      sectorId: row.sector_id, missionId: evidence.missionId, cases: [
        { name: 'correct', sql: good.sql, expectedClueIds: extras },
        { name: 'wrong-keyword', sql: buildDetailQuery({ ...input, keyword: otherKeyword }).sql, expectedClueIds: wrongWordRows },
        { name: 'wrong-vector', sql: buildDetailQuery({ ...input, vector: civil.vector }).sql, expectedClueIds: byKind('-civil') },
        { name: 'both-wrong', sql: buildDetailQuery({ ...input, keyword: otherKeyword, vector: civil.vector }).sql, expectedClueIds: [] },
        { name: 'without-fulltext', sql: buildDetailQuery({ ...input, keyword: undefined, mode: 'vector' }).sql, expectedClueIds: [...extras, ...byKind('-word-a'), ...byKind('-word-b')] },
        { name: 'without-vector', sql: buildDetailQuery({ ...input, vector: undefined, mode: 'fulltext' }).sql, expectedClueIds: [...extras, ...byKind('-civil'), ...byKind('-noise')] },
      ] };
  });
}

test('浏览器fixture覆盖六关36个真实SQL用例，删子句确实改变SQL', () => {
  const fixtures = browserDetailFixtures();
  assert.equal(fixtures.length, 6);
  for (const fixture of fixtures) {
    assert.equal(fixture.cases.length, 6);
    assert.ok(fixture.cases.every(item => item.sql));
    assert.ok(fixture.cases.find(item => item.name === 'correct').expectedClueIds.length >= 1);
    assert.ok(!fixture.cases.find(item => item.name === 'without-fulltext').sql.includes('MATCH(body)'));
    assert.ok(!fixture.cases.find(item => item.name === 'without-vector').sql.includes('<= 0.42'));
  }
});
