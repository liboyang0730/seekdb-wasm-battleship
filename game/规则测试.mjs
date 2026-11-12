// 浏览器可导入下方 fixtures；只有 Node 环境才注册单元测试。
const inNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
const test = inNode ? (await import('node:test')).default : () => {};
const assert = inNode ? (await import('node:assert/strict')).default : null;

const rules = await import('./海战规则.mjs');
const {
  LEVELS, createRng, createFleet, validateFleet, applyShot, createKnowledge,
  recordShot, chooseEnemyShots, validateSalvo, generateEvidence, buildQuery,
  sectorBounds, boundsFromCells,
  targetingAccuracy, resolveAim, placementBlockedCells,
  weaponPattern, weaponPatternAtAnchor, validateNewBombs,
} = rules;

function fixtureFleet() {
  return {
    size: 8, noTouch: true, shots: {},
    ships: [{ id: 's1', originalLength: 3, length: 2, sunk: false,
      cells: [{ x: 1, y: 1, hp: 1, maxHp: 1 }, { x: 2, y: 1, hp: 1, maxHp: 1 }] }],
  };
}

test('相同种子可复现、不同种子会改变随机序列', () => {
  assert.equal(typeof createRng, 'function', '缺少可播种随机函数');
  const sample = seed => Array.from({ length: 12 }, createRng(seed));
  assert.deepEqual(sample('naval-17'), sample('naval-17'));
  assert.notDeepEqual(sample('naval-17'), sample('naval-18'));
  assert.ok(sample(0).every(value => value >= 0 && value < 1));
});

test('勋章下一关生效，首两关单炮，第三关四轮双炮且后关三轮双炮', () => {
  assert.equal(LEVELS?.length, 6);
  assert.equal(LEVELS[0].reward, 'lightweight');
  assert.equal(LEVELS[1].reward, 'fork');
  assert.deepEqual(LEVELS.map(level => level.enemyDoubleEvery), [0, 0, 4, 3, 3, 2]);
  assert.equal(LEVELS[2].playerDoubleEvery, 0);
  assert.deepEqual(LEVELS.map(level => level.playerDoubleEvery), [0, 0, 0, 4, 4, 4]);
  assert.equal(LEVELS[3].reward, 'distributed');
  assert.equal(LEVELS[4].reward, 'piercing');
  assert.equal(LEVELS[4].rewardName, '异步索引');
  assert.deepEqual(LEVELS[4].extraRewards, ['ultimate']);
});

test('正确观测固定返回半盘32/50/72格，至少含一个开局舰格，不随轮次和舰损缩小', () => {
  for (const level of LEVELS) {
    for (let seed = 0; seed < 12; seed += 1) {
      const fleet = createFleet(level.enemyShips, { size: level.size, seed });
      const evidence = generateEvidence({ fleet, level: level.id, round: 1, seed });
      const coast = evidence.rows.find(row => row.id.endsWith('-coast') && row.id === `l${level.id}-r1-coast`);
      const radar = evidence.rows.find(row => row.id === `l${level.id}-r1-radar`);
      assert.equal(coast.tactical_cells, radar.tactical_cells);
      assert.equal(coast.tactical_hint, radar.tactical_hint);
      for (const row of evidence.rows) {
        const band = JSON.parse(row.tactical_cells);
        assert.equal(band.length, level.size * level.size / 2);
        const bounds = boundsFromCells(band);
        assert.ok((bounds.width === level.size / 2 && bounds.height === level.size)
          || (bounds.width === level.size && bounds.height === level.size / 2));
        const window = sectorBounds(row.sector_id, level.size);
        assert.ok(band.every(cell => cell.x >= window.minX && cell.x <= window.maxX
          && cell.y >= window.minY && cell.y <= window.maxY));
        assert.equal(typeof row.tactical_hint, 'string');
      }
      const bandKeys = new Set(JSON.parse(coast.tactical_cells).map(cell => `${cell.x},${cell.y}`));
      const bounds = evidence.truth.targetBounds;
      assert.ok(fleet.ships.some(ship => ship.cells.some(cell => bandKeys.has(`${cell.x + bounds.minX},${cell.y + bounds.minY}`))));
      const damaged = JSON.parse(JSON.stringify(fleet));
      damaged.ships.forEach(ship => { ship.sunk = true; ship.cells.forEach(cell => { cell.hp = 0; }); });
      const later = generateEvidence({ fleet: damaged, level: level.id, round: 50, seed });
      assert.equal(later.rows.find(row => row.id === `l${level.id}-r50-coast`).tactical_cells, coast.tactical_cells);
      assert.equal(later.tacticalCount, level.size * level.size / 2);
    }
  }
});

test('多种种子下均能生成不重叠、不相邻的合法横竖舰队', () => {
  for (let seed = 0; seed < 80; seed += 1) {
    const fleet = createFleet([4, 3, 3, 2], { size: 8, seed });
    assert.equal(validateFleet(fleet).ok, true, `种子 ${seed}`);
    assert.equal(fleet.ships.flatMap(ship => ship.cells).length, 12);
    assert.deepEqual(fleet, createFleet([4, 3, 3, 2], { size: 8, seed }));
  }
});

test('布阵校验拒绝越界、斜放和重叠；间距模式另可拒绝接壤', () => {
  const fleet = fixtureFleet();
  fleet.ships[0].cells[1].x = 8;
  assert.equal(validateFleet(fleet).ok, false);
  const diagonal = fixtureFleet();
  diagonal.ships[0].cells[1].y = 2;
  assert.equal(validateFleet(diagonal).ok, false);
  const adjacent = fixtureFleet();
  adjacent.ships.push({ id: 's2', originalLength: 1, length: 1, sunk: false,
    cells: [{ x: 3, y: 2, hp: 1, maxHp: 1 }] });
  assert.equal(validateFleet(adjacent).ok, false);
  assert.throws(() => createFleet([9], { size: 8, seed: 1 }));
});

test('本作改编规则拒绝边及斜角接壤，禁放提示指出截图中的A7与B8',()=>{
  const ship=(id,cells)=>({id,originalLength:cells.length,length:cells.length,sunk:false,cells:cells.map(([x,y])=>({x,y,hp:1,maxHp:1}))});
  const base={size:8,noTouch:true,shots:{},ships:[ship('a',[[0,4],[0,5],[0,6]]),ship('b',[[2,7],[3,7]])]};
  assert.equal(validateFleet(base).ok,true);
  const moved=structuredClone(base);moved.ships[1]=ship('b',[[1,7],[2,7]]);
  assert.equal(validateFleet(moved).ok,false);assert.match(validateFleet(moved).errors.join(' '),/A7.*B8.*斜角|B8.*A7.*斜角/);
  const touching=structuredClone(base);touching.ships[1]=ship('b',[[1,6],[2,6]]);
  assert.equal(validateFleet(touching).ok,false,'本作双方边相邻也禁止');
  const overlap=structuredClone(base);overlap.ships[1]=ship('b',[[0,6],[1,6]]);
  assert.equal(validateFleet(overlap).ok,false);assert.match(validateFleet(overlap).errors.join(' '),/A7.*重叠/);
  const blocked=placementBlockedCells(base,1);
  assert.ok(blocked.some(c=>c.x===1&&c.y===7),'固定A7周围应标B8');
  assert.ok(!blocked.some(c=>c.x===0&&c.y===6),'固定舰体自身不涂禁放X');
  assert.ok(!blocked.some(c=>c.x===2&&c.y===7),'选中舰原位置不涂X');
  const generated=createFleet([5,3,2,1],{size:8,seed:'naval-spacing',noTouch:true});
  assert.equal(generated.noTouch,true);assert.equal(validateFleet(generated).ok,true);
});

test('轻量仅缩短最长舰一格，每格单HP，实际总HP随之减少一格', () => {
  const fleet = createFleet([3, 2, 2], { size: 8, seed: 21, lightweight: true });
  assert.equal(fleet.ships.flatMap(ship => ship.cells).length, 6);
  assert.equal(fleet.ships.flatMap(ship => ship.cells).reduce((sum, cell) => sum + cell.maxHp, 0), 6);
  assert.equal(fleet.ships.filter(ship => ship.length < ship.originalLength).length, 1);
  assert.equal(validateFleet(fleet).ok, true);
});

test('命中一格即清除且不能再打，全舰HP归零才击沉', () => {
  const fleet = fixtureFleet();
  const first = applyShot(fleet, { x: 1, y: 1 });
  assert.equal(first.kind, 'hit');
  assert.equal(first.cellCleared, true);
  assert.equal(first.cellHp, 0);
  assert.equal(first.shipId, null);
  assert.deepEqual(first.sunkCells, []);
  assert.equal(applyShot(fleet, { x: 1, y: 1 }).valid, false);
  const last = applyShot(fleet, { x: 2, y: 1 });
  assert.equal(last.kind, 'sunk');
  assert.equal(last.defeated, true);
  assert.equal(last.sunkCells.length, 2);
  assert.equal(last.remainingHp, 0);
});

test('重复空炮、越界与非整数炮击不改变舰队状态', () => {
  const fleet = fixtureFleet();
  assert.equal(applyShot(fleet, { x: 0, y: 0 }).kind, 'miss');
  const before = JSON.stringify(fleet);
  assert.equal(applyShot(fleet, { x: 0, y: 0 }).valid, false);
  assert.equal(applyShot(fleet, { x: 8, y: 0 }).valid, false);
  assert.equal(applyShot(fleet, { x: 0.5, y: 0 }).valid, false);
  assert.equal(JSON.stringify(fleet), before);
});

test('双炮和范围齐射禁止同一次齐射中重复坐标', () => {
  assert.equal(validateSalvo([{ x: 0, y: 0 }, { x: 0, y: 0 }], 2).ok, false);
  assert.equal(validateSalvo([{ x: 0, y: 0 }, { x: 1, y: 0 }], 2).ok, true);
  assert.equal(validateSalvo([{ x: 0, y: 0 }, { x: 1, y: 0 }], 1).ok, false);
  assert.equal(validateSalvo([], 2).ok, false);
  assert.equal(validateNewBombs([{ x: 0, y: 0 }], { '0,0': { state: 'hit' } }).ok, false);
  assert.equal(validateNewBombs([{ x: 1, y: 0 }], new Set(['0,0'])).ok, true);
  // 特殊模板可覆盖旧格：调用方只把新格交给applyShot，而非validateNewBombs整模板。
  const history = { '2,2': { state: 'miss' } };
  const pattern = weaponPattern('piercing', { x: 3, y: 3 }, 8);
  assert.equal(pattern.filter(cell => !history[`${cell.x},${cell.y}`]).length, 4);
});

test('异步索引导弹参照HARPOON，为3×3四角加中心五点X形', () => {
  assert.deepEqual(weaponPattern('piercing', { x: 3, y: 3 }, 8), [
    { x: 2, y: 2 }, { x: 4, y: 2 }, { x: 3, y: 3 }, { x: 2, y: 4 }, { x: 4, y: 4 },
  ]);
  assert.deepEqual(weaponPattern('piercing', { x: 0, y: 0 }, 8), [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  assert.deepEqual(weaponPattern('piercing', { x: 7, y: 7 }, 8), [{ x: 6, y: 6 }, { x: 7, y: 7 }]);
});

test('分布式扩展参照TRIDENT D9，为5×5内间隔一格的九点，边界裁剪', () => {
  assert.deepEqual(weaponPattern('distributed', { x: 3, y: 3 }, 8), [
    { x: 1, y: 1 }, { x: 3, y: 1 }, { x: 5, y: 1 },
    { x: 1, y: 3 }, { x: 3, y: 3 }, { x: 5, y: 3 },
    { x: 1, y: 5 }, { x: 3, y: 5 }, { x: 5, y: 5 },
  ]);
  assert.deepEqual(weaponPattern('distributed', { x: 0, y: 0 }, 8), [
    { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 2 },
  ]);
  assert.deepEqual(weaponPattern('distributed_ii', { x: 3, y: 3 }, 8), weaponPattern('distributed', { x: 3, y: 3 }, 8));
});

test('分布式扩展弹为4×4四角，靠边裁剪且不存在第三型号', () => {
  assert.deepEqual(weaponPattern('distributed_i', { x: 3, y: 3 }, 8), [
    { x: 2, y: 2 }, { x: 5, y: 2 }, { x: 2, y: 5 }, { x: 5, y: 5 },
  ]);
  assert.deepEqual(weaponPattern('distributed_i', { x: 0, y: 0 }, 8), [{ x: 2, y: 2 }]);
  assert.throws(() => weaponPattern('distributed_iii', { x: 3, y: 3 }, 8));
});

test('左上角锚点：分布式扩展弹为完整4×4四角四点', () => {
  assert.deepEqual(weaponPatternAtAnchor('distributed_i', { x: 0, y: 0 }, 8), [
    { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 }, { x: 3, y: 3 },
  ]);
  assert.deepEqual(weaponPatternAtAnchor('distributed_i', { x: 4, y: 4 }, 8), [
    { x: 4, y: 4 }, { x: 7, y: 4 }, { x: 4, y: 7 }, { x: 7, y: 7 },
  ]);
});

test('左上角锚点：究极分布式扩展弹为完整5×5隔格九点', () => {
  assert.deepEqual(weaponPatternAtAnchor('distributed_ii', { x: 0, y: 0 }, 8), [
    { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 },
    { x: 0, y: 2 }, { x: 2, y: 2 }, { x: 4, y: 2 },
    { x: 0, y: 4 }, { x: 2, y: 4 }, { x: 4, y: 4 },
  ]);
  assert.equal(weaponPatternAtAnchor('distributed_ii', { x: 3, y: 3 }, 8).length, 9);
  assert.deepEqual(weaponPatternAtAnchor('distributed', { x: 0, y: 0 }, 8), weaponPatternAtAnchor('distributed_ii', { x: 0, y: 0 }, 8));
});

test('左上角锚点：异步索引导弹为完整3×3五点X', () => {
  assert.deepEqual(weaponPatternAtAnchor('piercing', { x: 0, y: 0 }, 8), [
    { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: 2, y: 2 },
  ]);
  assert.deepEqual(weaponPatternAtAnchor('piercing', { x: 5, y: 5 }, 8), [
    { x: 5, y: 5 }, { x: 7, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 7 }, { x: 7, y: 7 },
  ]);
});

test('完整模板放不下返回空数组，不允许裁掉边缘点', () => {
  for (const [kind, span] of [['distributed_i', 4], ['distributed_ii', 5], ['piercing', 3]]) {
    assert.deepEqual(weaponPatternAtAnchor(kind, { x: 8 - span + 1, y: 0 }, 8), []);
    assert.deepEqual(weaponPatternAtAnchor(kind, { x: 0, y: 8 - span + 1 }, 8), []);
    assert.deepEqual(weaponPatternAtAnchor(kind, { x: -1, y: 0 }, 8), []);
    assert.deepEqual(weaponPatternAtAnchor(kind, { x: 0.5, y: 0 }, 8), []);
    assert.deepEqual(weaponPatternAtAnchor(kind, { x: 0, y: 0 }, 2), []);
  }
  assert.throws(() => weaponPatternAtAnchor('unknown', { x: 0, y: 0 }, 8), RangeError);
  assert.throws(() => weaponPatternAtAnchor('piercing', { x: 0, y: 0 }, 1), RangeError);
});

test('AI只从公开知识沿命中追击，任何曾投弹格都不重打', () => {
  const knowledge = createKnowledge(8);
  recordShot(knowledge, { valid: true, x: 2, y: 2, kind: 'hit', cellCleared: false, cellHp: 1, sunkCells: [] });
  recordShot(knowledge, { valid: true, x: 3, y: 2, kind: 'hit', cellCleared: true, cellHp: 0, sunkCells: [] });
  const before = JSON.stringify(knowledge);
  const guarded = new Proxy(knowledge, { get(target, key) {
    assert.ok(['size', 'shots', 'sunkShips'].includes(key), `AI不应读取私有属性 ${String(key)}`);
    return target[key];
  } });
  const salvo = chooseEnemyShots(guarded, 2, createRng(7));
  assert.ok(salvo.every(cell => cell.y === 2 && [1, 4].includes(cell.x)));
  assert.equal(new Set(salvo.map(cell => `${cell.x},${cell.y}`)).size, 2);
  assert.equal(JSON.stringify(knowledge), before);
});

test('AI不会重打已落空或击穿的格，击沉后不再追击旧命中', () => {
  const knowledge = createKnowledge(2);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1]]) {
    recordShot(knowledge, { valid: true, x, y, kind: 'miss', cellCleared: true, sunkCells: [] });
  }
  assert.deepEqual(chooseEnemyShots(knowledge, 2, createRng(2)), [{ x: 1, y: 1 }]);
  recordShot(knowledge, { valid: true, x: 1, y: 1, kind: 'sunk', cellCleared: true,
    shipId: 's1', sunkCells: [{ x: 1, y: 1 }] });
  assert.deepEqual(chooseEnemyShots(knowledge, 2, createRng(2)), []);
});

test('资料只返回完整交战窗口的全球坐标，窗口不随回合或舰损缩小', () => {
  const fleet = createFleet([3, 3, 2], { size: 10, seed: 'evidence' });
  const evidence = generateEvidence({ fleet, level: 3, round: 4, seed: 'evidence' });
  assert.ok(evidence.rows.length >= 8);
  assert.equal(evidence.cards.length >= 8, true);
  assert.equal(evidence.phase, 2);
  assert.deepEqual(evidence, generateEvidence({ fleet, level: 3, round: 4, seed: 'evidence' }));
  for (const row of evidence.rows) {
    const cells = JSON.parse(row.cells);
    assert.equal(cells.length, 100);
    assert.equal(new Set(cells.map(cell => cell.x)).size, 10);
    assert.equal(new Set(cells.map(cell => cell.y)).size, 10);
    assert.ok(cells.every(cell => cell.x >= 0 && cell.x < 25 && cell.y >= 0 && cell.y < 25));
    assert.deepEqual(boundsFromCells(row.cells), sectorBounds(row.sector_id, 10));
    assert.equal(row.signature.length, 8);
    assert.equal('shipCells' in row, false);
    assert.equal('true_x' in row, false);
  }
  for (const card of evidence.cards) {
    assert.equal('sector_id' in card, false);
    assert.equal('cells' in card.payload, false);
    assert.equal('sectorId' in card.payload, false);
  }
  assert.ok(evidence.rows.some(row => row.mission_id !== evidence.missionId));
  assert.ok(evidence.rows.some(row => row.source === 'RUMOR'));
  const later = JSON.parse(JSON.stringify(fleet));
  later.ships.forEach(ship => { ship.sunk = true; ship.cells.forEach(cell => { cell.hp = 0; }); });
  const afterDamage = generateEvidence({ fleet: later, level: 3, round: 40, seed: 'evidence' });
  assert.equal(afterDamage.truth.targetSector, evidence.truth.targetSector);
  assert.equal(evidence.windowSize, 10);
  assert.equal(evidence.worldSize, 25);
});

test('十六个全球交战窗口以半盘步长重叠，边界计算允许空结果', () => {
  assert.deepEqual(LEVELS.map(level => level.size), [8, 8, 10, 10, 12, 12]);
  assert.deepEqual(sectorBounds('S1', 8), { minX: 0, minY: 0, maxX: 7, maxY: 7, width: 8, height: 8 });
  assert.deepEqual(sectorBounds('S16', 12), { minX: 18, minY: 18, maxX: 29, maxY: 29, width: 12, height: 12 });
  assert.equal(boundsFromCells([]), null);
  assert.equal(boundsFromCells([{ x: 0, y: 0 }, { x: 2, y: 0 }]), null);
});

test('正确选区不引入随机误差，邻区命中效率下降，远区始终打偏', () => {
  const targetBounds = sectorBounds('S1', 8);
  assert.equal(targetingAccuracy(targetBounds, targetBounds), 1);
  assert.equal(targetingAccuracy(sectorBounds('S2', 8), targetBounds), 0.55);
  assert.equal(targetingAccuracy(sectorBounds('S3', 8), targetBounds), 0);
  const aimed = resolveAim({ selectedBounds: targetBounds, targetBounds, cell: { x: 7, y: 7 }, rng: () => { throw new Error('准确瞄准不能消耗随机数'); } });
  assert.deepEqual(aimed, { drift: false, target: { x: 7, y: 7 }, accuracy: 1 });
  assert.deepEqual(resolveAim({ selectedBounds: sectorBounds('S2', 8), targetBounds, cell: { x: 1, y: 1 }, rng: () => 0.9 }),
    { drift: true, target: null, accuracy: 0.55 });
  assert.deepEqual(resolveAim({ selectedBounds: sectorBounds('S2', 8), targetBounds, cell: { x: 1, y: 1 }, rng: () => 0.1 }),
    { drift: false, target: { x: 5, y: 1 }, accuracy: 0.55 });
  assert.deepEqual(resolveAim({ selectedBounds: sectorBounds('S2', 8), targetBounds, cell: { x: 7, y: 1 }, rng: () => 0.1 }),
    { drift: false, target: null, accuracy: 0.55 });
  assert.equal(resolveAim({ selectedBounds: sectorBounds('S3', 8), targetBounds, cell: { x: 1, y: 1 }, rng: () => 0 }).drift, true);
});

test('噪声按范围、全文、向量、条件逐关激活，未来能力不影响早关可解性', () => {
  for (const level of LEVELS) {
    const fleet = createFleet(level.enemyShips, { size: level.size, seed: 'orthogonal-noise' });
    const evidence = generateEvidence({ fleet, level: level.id, round: 7, seed: 'orthogonal-noise' });
    const sameCall = evidence.rows.filter(row => row.call_sign === evidence.callSign);
    const pairs = [
      sameCall.filter(row => row.mission_id !== evidence.missionId),
      sameCall.filter(row => row.mission_id === evidence.missionId && row.observed_round < 5),
      sameCall.filter(row => row.ship_class === 'merchant'),
    ];
    for (const pair of pairs) {
      assert.ok(pair.length >= 2, `L${level.id}缺少正交双源噪声`);
      assert.equal(new Set(pair.map(row => row.source)).size >= 2, true);
      assert.ok(pair.every(row => row.sector_id !== evidence.truth.targetSector));
    }
    assert.ok(sameCall.some(row => row.source === 'RUMOR' && row.observed_round === (level.id >= 4 ? 7 : 0)));
    const otherCalls = evidence.rows.filter(row => row.call_sign !== evidence.callSign
      && row.ship_class === 'warship' && row.mission_id === evidence.missionId
      && row.observed_round === (level.id >= 2 ? 7 : 0));
    assert.ok(new Set(otherCalls.map(row => row.sector_id)).size >= 2);
    assert.ok(sameCall.filter(row => row.ship_class === 'merchant')
      .every(row => row.observed_round === (level.id >= 3 ? 7 : 0)));
  }
});

test('组合所需资料缺失或重复同类卡时，SQL无效且不应消耗查询', () => {
  const missing = buildQuery({ selectedCards: [], abilities: ['vector'], missionId: 'm1', round: 1 });
  assert.equal(missing.valid, false);
  assert.equal(missing.sql, '');
  const duplicate = buildQuery({ selectedCards: [
    { id: 'a', kind: 'keyword', payload: { keyword: 'TERN' } },
    { id: 'b', kind: 'keyword', payload: { keyword: 'COD' } },
  ], abilities: ['fulltext'], missionId: 'm1', round: 1 });
  assert.equal(duplicate.valid, false);
});

test('SQL直接包含真实全文、向量、条件与范围运算并转义字面量', () => {
  const selectedCards = [
    { id: 'k', kind: 'keyword', payload: { keyword: "TERN' OR 1=1" } },
    { id: 'v', kind: 'vector', payload: { vector: [1, 0, 0, 0, 0, 0, 0, 0] } },
    { id: 'f', kind: 'filter', payload: { missionId: "m'1", minConfidence: 80, sources: ['岸基观察站', '舰载雷达站'] } },
    { id: 'r', kind: 'range', payload: { minRound: 3, maxRound: 6 } },
  ];
  const query = buildQuery({ selectedCards, abilities: ['fulltext', 'vector', 'filter', 'range'], missionId: "m'1", round: 4 });
  assert.equal(query.valid, true);
  assert.match(query.sql, /MATCH\s*\(body\)\s*AGAINST/i);
  assert.match(query.sql, /l2_distance\(embedding,/i);
  assert.match(query.sql, /mission_id = 'm''1'/);
  assert.match(query.sql, /observed_round BETWEEN 3 AND 6/);
  assert.match(query.sql, /confidence >= 80/);
  assert.match(query.sql, /TERN'' OR 1=1/);
  assert.match(query.sql, /LIMIT 8/);
  assert.match(query.sql, /SELECT[^\n]*tactical_cells[^\n]*tactical_hint/);
  assert.equal(query.sql.includes('?'), false);
});

test('向量维度错误与非有限范围不能生成可执行SQL', () => {
  assert.equal(buildQuery({ selectedCards: [{ kind: 'vector', payload: { vector: [1, 2] } }], abilities: ['vector'] }).valid, false);
  assert.equal(buildQuery({ selectedCards: [{ kind: 'range', payload: { minRound: NaN, maxRound: 4 } }], abilities: ['range'] }).valid, false);
});

test('JSON回档后坐标键和射击知识仍可继续结算且不重打旧点', () => {
  const fleet = JSON.parse(JSON.stringify(fixtureFleet()));
  const knowledge = JSON.parse(JSON.stringify(createKnowledge(8)));
  recordShot(knowledge, applyShot(fleet, { x: 1, y: 1 }));
  assert.equal(knowledge.shots['1,1'].state, 'hit');
  assert.equal(fleet.shots['1,1'].attempts, 1);
  assert.notDeepEqual(chooseEnemyShots(knowledge, 1, createRng('after-fork')), [{ x: 1, y: 1 }]);
  assert.equal(applyShot(fleet, { x: 1, y: 1 }).valid, false);
});

/**
 * 供真实浏览器 seekdb 集成测试使用：插入 rows，再执行每个 case.sql，
 * 将返回 id 集合与 expectedIds 对比。这里不实现任何 JS 查询替身。
 */
export function browserQueryFixtures() {
  const fixtures = [];
  const kinds = { fulltext: 'keyword', vector: 'vector', filter: 'filter', range: 'range' };
  for (const level of [1, 2, 3, 4, 5, 6]) {
    const seed = `browser-query-${level}`;
    const fleet = createFleet(LEVELS[level - 1].enemyShips, { size: LEVELS[level - 1].size, seed });
    const round = 7;
    const evidence = generateEvidence({ fleet, level, round, seed });
    const prefix = `l${level}-r${round}`;
    const chosen = kind => evidence.cards.find(item => item.id === `${prefix}-${kind}`);
    const unlocked = level === 1 ? ['range'] : level === 2 ? ['range', 'fulltext']
      : level === 3 ? ['range', 'fulltext', 'vector'] : ['range', 'fulltext', 'vector', 'filter'];
    const query = (abilities, replacement = {}) => buildQuery({
      selectedCards: abilities.map(ability => chosen(replacement[ability] ?? kinds[ability])),
      abilities, missionId: evidence.missionId, round,
    });
    const correct = query(unlocked);
    const cases = [{ key: 'unlocked', name: `L${level}本关已解锁能力组合`, sql: correct.sql,
      expectedIds: [...evidence.truth.reliableRowIds].sort(), expectedSectors: 1 }];
    for (const omitted of unlocked) {
      const subset = unlocked.filter(ability => ability !== omitted);
      if (!subset.length) continue;
      const partial = query(subset);
      cases.push({ key: `minus_${omitted}`, name: `L${level}缺少${omitted}条件`, sql: partial.sql,
        expectedMinSectors: 2, expectedIncludesNoise: true });
    }
    const oldRange = query(unlocked, { range: 'old-range' });
    cases.push({ key: 'wrong_range', name: `L${level}采用旧时间窗`, sql: oldRange.sql,
      expectedMinSectors: 1, excludedIds: evidence.truth.reliableRowIds });
    if (level >= 3) {
      const civil = query(unlocked, { vector: 'civil-vector' });
      cases.push({ key: 'wrong_vector', name: `L${level}采用民船向量`, sql: civil.sql,
        expectedIds: [`${prefix}-civil`, `${prefix}-civil-coast`].sort(), expectedSectors: 1 });
    }
    if (level >= 4) {
      const oldMission = query(unlocked, { filter: 'old-filter' });
      cases.push({ key: 'wrong_filter', name: `L${level}采用旧任务`, sql: oldMission.sql,
        expectedIds: [`${prefix}-old`, `${prefix}-archive-echo`].sort(), expectedSectors: 1 });
      const textOnly = query(['fulltext']);
      cases.push({ key: 'fulltext_only', name: `L${level}只做全文`, sql: textOnly.sql,
        expectedMinSectors: 4, expectedIncludesNoise: true });
    }
    fixtures.push({ level, rows: evidence.rows, unlocked, targetSector: evidence.truth.targetSector,
      reliableIds: evidence.truth.reliableRowIds, cases });
  }
  return fixtures;
}
