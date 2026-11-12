import test from 'node:test';
import assert from 'node:assert/strict';
import {checkRecon, canUseFork, locatePin, chartColumn, canEnterSea} from './作战流程.mjs';

test('必须确认部署、查询成功和读完结果才能进入航海图', () => {
  const ready={deploymentConfirmed:true,reconLocked:true,briefingAccepted:true};
  assert.equal(canEnterSea(ready),true);
  for(const key of Object.keys(ready)) assert.equal(canEnterSea({...ready,[key]:false}),false);
  assert.equal(canEnterSea(null),false);
});

test('查询必须包含本关全部能力且只返回目标海区', () => {
  const rows = [{sector_id: 'S5'}];
  assert.equal(checkRecon(rows, {level: 3, targetSector: 'S5', abilities: ['range']}).ok, false);
  assert.equal(checkRecon(rows, {level: 3, targetSector: 'S5', abilities: ['range','fulltext','vector']}).ok, true);
  assert.equal(checkRecon([...rows, {sector_id: 'S6'}], {level: 1, targetSector: 'S5', abilities: ['range']}).ok, false);
  assert.equal(checkRecon([], {level: 1, targetSector: 'S5', abilities: ['range']}).ok, false);
});
test('海图必须实际点位且只能接受小误差', () => {
  const row = {map_x: 12, map_y: 8};
  assert.equal(locatePin(null, row, 8).ok, false);
  assert.equal(locatePin({x: 12.4,y: 8.3}, row, 8).ok, true);
  assert.equal(locatePin({x: 15,y: 8}, row, 8).ok, false);
  assert.equal(locatePin({x: NaN,y: 8}, row, 8).ok, false);
});
test('Fork无需先受击，同关一次，随后两关冷却，第四关恢复', () => {
  assert.equal(canUseFork({owned: true, level: 3, lastUse: null, used: false, wasHit: false}), true);
  assert.equal(canUseFork({owned: false, level: 2, lastUse: null, used: false, wasHit: false}), false);
  assert.equal(canUseFork({owned: true, level: 3, lastUse: null, used: false, wasHit: true}), true);
  assert.equal(canUseFork({owned: true, level: 3, lastUse: 3, used: true, wasHit: true}), false);
  for (const level of [4,5]) assert.equal(canUseFork({owned: true, level, lastUse: 3, used: false, wasHit: true}), false);
  assert.equal(canUseFork({owned: true, level: 6, lastUse: 3, used: false, wasHit: true}), true);
  assert.equal(canUseFork({owned: true, level: 6, lastUse: 3, used: false, wasHit: false}), true);
});
test('列坐标为字母，超出Z继续AA', () => {
  assert.equal(chartColumn(0), 'A'); assert.equal(chartColumn(7), 'H');
  assert.equal(chartColumn(11), 'L'); assert.equal(chartColumn(26), 'AA');
});
