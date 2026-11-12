import test from 'node:test';
import assert from 'node:assert/strict';
import { createFleet, createEnemyFleet, validateFleet, LEVELS, applyShot, generateEvidence, enemyFirePlan, buildQuery } from './海战规则.mjs';
import { generateTacticalClues, isTacticalClueKind } from './战术线索.mjs';

const key = cell => `${cell.x},${cell.y}`;

function assertOpeningStats(fleet, clue) {
  const { size } = fleet;
  const occupied = fleet.ships.flatMap(ship => ship.cells);
  const area = new Set(clue.cells.map(key));
  const count = occupied.filter(cell => area.has(key(cell))).length;
  const oppositeCount = occupied.length - count;
  const xs = new Set(clue.cells.map(cell => cell.x));
  const axis = xs.size === size / 2 ? 'x' : 'y';
  const start = Math.min(...clue.cells.map(cell => cell[axis]));
  const oppositeStart = start === 0 ? size / 2 : 0;
  const name = from => axis === 'x' ? `${String.fromCharCode(65 + from)}～${String.fromCharCode(64 + from + size / 2)}列` : `${from + 1}～${from + size / 2}行`;
  assert.deepEqual(clue.basis, { axis, area: name(start), oppositeArea: name(oppositeStart), count, oppositeCount, asOf: '开局' });
  const text = count === oppositeCount
    ? `开局统计：${name(start)}和${name(oppositeStart)}各有${count}个舰格。`
    : `开局统计：${name(start)}有${count}个舰格，${name(oppositeStart)}有${oppositeCount}个舰格。`;
  assert.equal(clue.text, text);
  assert.doesNotMatch(clue.text, /较多|四个半盘/);
}

function geometryOnly(fleet) {
  const cells = fleet.ships.map(ship => new Proxy({ cells: ship.cells.map(cell => new Proxy({ x: cell.x, y: cell.y },
    { get(target, field) { assert.ok(['x', 'y'].includes(field), `禁止读取舰格私有属性${String(field)}`); return target[field]; } })) },
  { get(target, field) { assert.equal(field, 'cells', '不读取血量、舰ID或击沉状态'); return target[field]; } }));
  return new Proxy({ size: fleet.size, ships: cells }, { get(target, field) {
    assert.ok(['size', 'ships'].includes(field), '不读取炮击或血量状态'); return target[field];
  } });
}

function assertExtraTruth(fleet, clues, level, allowFallback = false) {
  const n = fleet.size, occupied = new Set(fleet.ships.flatMap(ship => ship.cells.map(key)));
  const expected = [['full_ship_band'], ['empty_patch'], ['ship_orientation'], ['ship_crossline'],
    ['submarine_region', 'empty_patch'], ['submarine_region', 'empty_patch']][level.id - 1];
  if (!allowFallback) assert.deepEqual(clues.slice(1).map(clue => clue.kind), expected);
  const emptyKeys = new Set(clues.filter(clue => clue.kind === 'empty_patch').flatMap(clue => clue.cells.map(key)));
  for (const clue of clues.slice(1)) {
    assert.equal(isTacticalClueKind(clue.kind), true);
    assert.match(clue.text, /^开局/);
    assert.doesNotMatch(JSON.stringify(clue), /ship-\d+|ship_id|"hp"|"sunk"|"occupied"/);
    if (clue.proof) assert.equal(clue.proof.asOf, '开局');
    const cells = new Set((clue.cells ?? []).map(key));
    assert.equal(cells.size, clue.cells?.length ?? 0);
    if (clue.kind === 'full_ship_band') {
      assert.ok(cells.size >= n * n / 2);
      assert.ok(fleet.ships.some(ship => ship.cells.every(cell => cells.has(key(cell)))));
      let placements = 0;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (Array.from({ length: 3 }, (_, i) => ({ x: x + dx * i, y: y + dy * i })).every(cell => cells.has(key(cell)))) placements++;
      }
      assert.ok(placements > 4, '宽带不能唯一定位整舰');
    } else if (clue.kind === 'empty_patch') {
      const span = level.id === 6 ? 3 : 2;
      assert.equal(clue.proof.span, span);
      assert.equal(cells.size, span * span);
      assert.ok(clue.cells.every(cell => !occupied.has(key(cell))), '空区必须实际全空');
      assert.equal(new Set(clue.cells.map(cell => cell.x)).size, span);
      assert.equal(new Set(clue.cells.map(cell => cell.y)).size, span);
    } else if (clue.kind === 'ship_orientation') {
      const longest = Math.max(...fleet.ships.map(ship => ship.length));
      assert.equal(clue.proof.length, longest);
      assert.ok(fleet.ships.some(ship => ship.length === longest &&
        (ship.cells[0].y === ship.cells[1].y) === (clue.proof.orientation === 'horizontal')));
      assert.equal(clue.cells, undefined);
      assert.ok(clue.proof.candidatePlacementCount >= n * n / 3);
    } else if (clue.kind === 'ship_crossline') {
      const { axis, boundaries, minLength } = clue.proof;
      assert.equal(minLength, 4);
      assert.ok(boundaries.length >= 1 && boundaries.length <= 2);
      assert.ok(boundaries.every(line => line >= 1 && line < n));
      const crosses = ship => boundaries.some(line => Math.min(...ship.cells.map(cell => cell[axis])) < line
        && Math.max(...ship.cells.map(cell => cell[axis])) >= line);
      assert.ok(fleet.ships.some(ship => ship.length >= minLength && crosses(ship)));
      assert.equal(clue.proof.candidateCellCount, cells.size);
      assert.ok(cells.size >= Math.ceil(n * n / 3));
      assert.ok(clue.proof.candidatePlacementCount >= Math.ceil(n * n / 3));
      // 向外框所有行/列展开的候选应含全盘横向或纵向，不可只给真实船格。
      assert.ok(new Set(clue.cells.map(cell => cell[axis === 'x' ? 'y' : 'x'])).size === n);
    } else if (clue.kind === 'submarine_region') {
      assert.ok(fleet.ships.some(ship => ship.length === 1 && cells.has(key(ship.cells[0]))));
      assert.equal(cells.size, level.id === 5 ? 72 : 60);
      const remaining = clue.cells.filter(cell => !emptyKeys.has(key(cell))).length;
      assert.equal(clue.proof.candidateCellCount, remaining);
      assert.ok(remaining >= (level.id === 5 ? 64 : 48));
      assert.equal(clue.proof.targetLength, 1);
      assert.match(clue.text, /1格潜艇/);
    } else assert.fail(`未测试线索类型${clue.kind}`);
  }
}

test('6:6平局必须明确各有6格，不暗示任一侧较多', () => {
  // D3～D7五格+A8潜艇在左，G1～G4及G6～G7六格在右；上下也为6:6。
  const groups = [Array.from({ length: 5 }, (_, i) => ({ x: 3, y: i + 2 })),
    Array.from({ length: 4 }, (_, i) => ({ x: 6, y: i })), [{ x: 6, y: 5 }, { x: 6, y: 6 }], [{ x: 0, y: 7 }]];
  const fleet = { size: 8, noTouch: true, shots: {}, ships: groups.map((cells, i) => ({ id: `ship-${i + 1}`, originalLength: cells.length,
    length: cells.length, sunk: false, cells: cells.map(cell => ({ ...cell, hp: 1, maxHp: 1 })) })) };
  assert.equal(validateFleet(fleet).ok, true);
  for (let seed = 0; seed < 12; seed += 1) {
    const clue = generateTacticalClues({ fleet, level: 2, seed })[0];
    assertOpeningStats(fleet, clue);
    assert.match(clue.text, /各有6个舰格/);
    assert.equal(clue.basis.count, 6);
    assert.equal(clue.basis.oppositeCount, 6);
  }
  const opening = generateTacticalClues({ fleet, level: 2, seed: 0 });
  for (const cell of groups.flat().filter(cell => cell.x === 6)) applyShot(fleet, cell);
  assert.equal(fleet.ships.flatMap(ship => ship.cells).filter(cell => cell.hp > 0).length, 6);
  assert.deepEqual(generateTacticalClues({ fleet, level: 2, seed: 0 }), opening);
});

test('全部768个预设布局的开局统计文案和basis逐格核对一致', () => {
  let checked = 0;
  const kinds = {}, fallbacks = {};
  for (const level of LEVELS) {
    const layouts = new Set();
    for (let seed = 0; seed < 4000 && layouts.size < 128; seed += 1) {
      const fleet = createEnemyFleet({ level, seed });
      if (layouts.has(fleet.layoutIndex)) continue;
      layouts.add(fleet.layoutIndex);
      const clues = generateTacticalClues({ fleet, level, seed: `stats-${level.id}-${fleet.layoutIndex}` });
      assertOpeningStats(fleet, clues[0]);
      assertExtraTruth(fleet, clues, level);
      assert.deepEqual(generateTacticalClues({ fleet: geometryOnly(fleet), level, seed: `stats-${level.id}-${fleet.layoutIndex}` }), clues);
      assert.deepEqual(generateTacticalClues({ fleet, level: level.id, seed: `stats-${level.id}-${fleet.layoutIndex}` }), clues);
      for (const clue of clues.slice(1)) {
        kinds[clue.kind] = (kinds[clue.kind] ?? 0) + 1;
        if (clue.proof?.fallback) fallbacks[level.id] = (fallbacks[level.id] ?? 0) + 1;
      }
      for (const clue of clues) {
        assert.match(clue.text, /^开局/);
        assert.doesNotMatch(clue.text, /四个半盘/);
      }
      for (const ship of fleet.ships) for (const cell of ship.cells) applyShot(fleet, cell);
      assert.deepEqual(generateTacticalClues({ fleet, level, seed: `stats-${level.id}-${fleet.layoutIndex}` }), clues);
      checked += 1;
    }
    assert.equal(layouts.size, 128);
  }
  assert.equal(checked, 768);
  assert.deepEqual(fallbacks, {});
  console.log('768布局额外模板与fallback：' + JSON.stringify({ kinds, fallbacks }));
});

test('固定128阵形池由seed选索引，返回独立副本且全部可复现合法', () => {
  for (const level of LEVELS) {
    const layouts = new Map();
    for (let seed = 0; seed < 4000 && layouts.size < 128; seed += 1) {
      const fleet = createEnemyFleet({ level, seed });
      assert.equal(validateFleet(fleet).ok, true);
      assert.equal(fleet.layoutPoolSize, 128);
      assert.ok(fleet.layoutIndex >= 0 && fleet.layoutIndex < 128);
      const layout = JSON.stringify(fleet.ships);
      if (layouts.has(fleet.layoutIndex)) assert.equal(layouts.get(fleet.layoutIndex), layout);
      layouts.set(fleet.layoutIndex, layout);
      assert.deepEqual(createEnemyFleet({ level, seed }), fleet);
      fleet.ships[0].cells[0].hp = 0;
      assert.equal(createEnemyFleet({ level, seed }).ships[0].cells[0].hp, 1);
    }
    assert.equal(layouts.size, 128);
    assert.equal(new Set(layouts.values()).size, 128);
  }
});

test('六关舰队密度、递增侦察与单炮教学配置一致', () => {
  assert.deepEqual(LEVELS.map(level => level.size), [8, 8, 10, 10, 12, 12]);
  assert.deepEqual(LEVELS[0].enemyShips, [5, 3, 2, 2]);
  assert.deepEqual(LEVELS[0].playerShips, [5, 3, 2, 1]);
  assert.ok(LEVELS.slice(0, 2).every(level => !level.enemyShips.includes(1) && level.playerShips.includes(1)));
  assert.ok(LEVELS.slice(4).every(level => level.enemyShips.filter(length => length === 1).length === 1));
  assert.deepEqual(LEVELS.map(level => level.radarCharges), [2, 2, 3, 3, 5, 5]);
  assert.equal(createFleet(LEVELS[1].playerShips, { size: 8, lightweight: true }).ships.flatMap(ship => ship.cells).length, 10);
  assert.deepEqual(LEVELS.map(level => level.enemyDoubleEvery), [0, 0, 4, 3, 3, 2]);
  assert.deepEqual(LEVELS.map(level => level.clueLimit), [2, 2, 2, 2, 3, 3]);
  for (const level of LEVELS) {
    assert.ok(level.playerShips.length >= 4);
    assert.equal(level.defaultClues, 1);
    assert.ok(level.radarCharges >= 2);
  }
  assert.deepEqual(enemyFirePlan(1, 3), { shots: 1, nextShots: 1, warning: false });
  assert.deepEqual(enemyFirePlan(3, 3), { shots: 1, nextShots: 2, warning: true });
  assert.deepEqual(enemyFirePlan(4, 3), { shots: 2, nextShots: 1, warning: false });
  assert.deepEqual(enemyFirePlan(6, 1), { shots: 1, nextShots: 2, warning: true });
});

test('线索固定且真实：最大密度半盘与六关不同extra，不返回舰格表', () => {
  for (const level of LEVELS) for (let seed = 0; seed < 40; seed += 1) {
    const fleet = createFleet(level.enemyShips, { size: level.size, seed: `${level.id}-${seed}` });
    const clues = generateTacticalClues({ fleet, level, seed });
    assert.equal(clues.length, level.clueLimit);
    const occupied = fleet.ships.flatMap(ship => ship.cells);
    const dense = clues.find(clue => clue.kind === 'dense_half');
    const denseSet = new Set(dense.cells.map(key));
    const maxDensity = Math.max(...['x', 'y'].flatMap(axis => [false, true].map(high =>
      occupied.filter(cell => high ? cell[axis] >= level.size / 2 : cell[axis] < level.size / 2).length)));
    assert.equal(occupied.filter(cell => denseSet.has(key(cell))).length, maxDensity);
    assert.equal(dense.cells.length, level.size ** 2 / 2);
    assert.match(dense.text, /[A-L]|\d+～\d+行/);
    assertExtraTruth(fleet, clues, level, true);
    for (const clue of clues) {
      const fields = ['id', 'kind', 'text', ...(clue.cells ? ['cells'] : []), ...(clue.kind === 'dense_half' ? ['basis'] : []), ...(clue.proof ? ['proof'] : [])];
      assert.deepEqual(Object.keys(clue).sort(), fields.sort());
      assert.doesNotMatch(JSON.stringify(clue), /ship-\d+/);
      assert.ok(!JSON.stringify(clue).includes('hp'));
    }
    for (const cell of occupied) applyShot(fleet, cell);
    assert.deepEqual(generateTacticalClues({ fleet, level, seed }), clues);
    assert.deepEqual(generateTacticalClues({ fleet: JSON.parse(JSON.stringify(fleet)), level, seed }), clues);
  }
});

test('generateEvidence六关48种子含synthetic资料均可生成且轮次不改线索', () => {
  let rows = 0, fallbackCount = 0;
  for (const level of LEVELS) for (let index = 0; index < 48; index++) {
    const seed = `synthetic-smoke-${level.id}-${index}`;
    const fleet = createEnemyFleet({ level, seed });
    const first = generateEvidence({ fleet, level, seed });
    const later = generateEvidence({ fleet, level, seed, round: 50 });
    const bySector = new Map(later.rows.map(row => [row.sector_id, row.tactical_clues]));
    for (const row of first.rows) {
      const clues = JSON.parse(row.tactical_clues);
      assert.equal(clues.length, level.clueLimit);
      assert.equal(row.tactical_hint, clues[0].text);
      assert.ok(clues.every(clue => isTacticalClueKind(clue.kind)));
      if (bySector.has(row.sector_id)) assert.equal(row.tactical_clues, bySector.get(row.sector_id));
      rows++;
      fallbackCount += clues.filter(clue => clue.proof?.fallback).length;
    }
  }
  console.log('真实调用synthetic烟测：' + JSON.stringify({ cases: 288, rows, fallbackCount }));
});

test('非预设布局不存在空3×3时显式回退到真宽带，不编造空海或崩溃', () => {
  const ships = [];
  for (const y of [1, 4, 7, 10]) for (const x of [1, 4, 7, 10]) ships.push({
    id: `s${ships.length}`, length: 1, originalLength: 1, sunk: false, cells: [{ x, y, hp: 1, maxHp: 1 }],
  });
  const fleet = { size: 12, noTouch: true, shots: {}, ships };
  assert.equal(validateFleet(fleet).ok, true);
  const clues = generateTacticalClues({ fleet: geometryOnly(fleet), level: 6, seed: 'no-empty-3' });
  assert.equal(clues.length, 3);
  assert.ok(clues.some(clue => clue.kind === 'submarine_region'));
  assert.ok(clues.some(clue => clue.kind === 'full_ship_band' && clue.proof?.fallback));
  assert.ok(!clues.some(clue => clue.kind === 'empty_patch'));
  const evidence = generateEvidence({ fleet, level: 6, seed: 'no-empty-3' });
  const reliable = evidence.rows.find(row => evidence.truth.reliableRowIds.includes(row.id));
  assert.ok(JSON.parse(reliable.tactical_clues).some(clue => clue.kind === 'full_ship_band' && clue.proof?.fallback));
});

test('真实SQL行携带相同global线索，噪声仍是格式可信的独立观测，轮次不收窄', () => {
  for (const level of LEVELS) {
    const seed = `clue-${level.id}`;
    const fleet = createFleet(level.enemyShips, { size: level.size, seed });
    const first = generateEvidence({ fleet, level, seed });
    const later = generateEvidence({ fleet, level, seed, round: 50 });
    const reliable = first.rows.filter(row => first.truth.reliableRowIds.includes(row.id));
    assert.equal(reliable[0].tactical_clues, reliable[1].tactical_clues);
    assert.equal(reliable[0].tactical_clues, later.rows.find(row => later.truth.reliableRowIds.includes(row.id)).tactical_clues);
    for (const row of first.rows) {
      const clues = JSON.parse(row.tactical_clues);
      assert.equal(clues.length, level.clueLimit);
      const cells = new Set(JSON.parse(row.cells).map(key));
      for (const clue of clues) if (clue.cells) assert.ok(clue.cells.every(cell => cells.has(key(cell))));
      assert.deepEqual(clues[0].cells, JSON.parse(row.tactical_cells));
      assert.equal(row.tactical_hint, clues[0].text);
      assert.equal(clues[0].basis.asOf, '开局');
    }
    const selectedCards = [{ kind: 'range', payload: { minRound: 1, maxRound: 1 } }];
    const query = buildQuery({ selectedCards, abilities: ['range'], missionId: first.missionId, round: 1 });
    assert.equal(query.valid, true);
    assert.match(query.sql, /SELECT[^\n]*tactical_clues/);
    assert.match(query.sql, /fleet_manifest, map_x, map_y, enemy_fire_every/);
  }
});
