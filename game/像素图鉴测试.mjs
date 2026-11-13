import test from 'node:test';
import assert from 'node:assert/strict';
import { ICON_SIZE, drawPixelIcon, getLevelRewards, WEAPON_INFO } from './像素图鉴.mjs';
import * as rewardCatalog from './像素图鉴.mjs';

test('所有关卡奖励展示去重，保留不同武器用法和技能名称且不改原奖励', () => {
  assert.equal(typeof rewardCatalog.getRewardDisplayCards, 'function', '奖励展示需要独立去重');
  const rewards = [1, 2, 3, 4, 5, 6].map(getLevelRewards);
  const before = structuredClone(rewards);
  const display = rewards.map(rewardCatalog.getRewardDisplayCards);
  assert.deepEqual(display.map(cards => cards.length), [2, 1, 2, 2, 4, 0]);
  assert.deepEqual(display.map(cards => cards.filter(card => card.featureDescription).length), [2, 1, 1, 1, 2, 0]);
  assert.deepEqual(display[1][0].relatedUnlocks, [{kind: 'skill', title: '试错机会'}]);
  for (const cards of display) for (const field of ['description', 'featureDescription']) {
    const values = cards.map(card => card[field]).filter(Boolean);
    assert.equal(new Set(values).size, values.length, `${field}不重复`);
  }
  assert.equal(display[0][1].title, '嵌入式三联炮');
  assert.match(display[0][1].description, /三个不同坐标/);
  assert.match(display[2][1].description, /每四轮/);
  for (const card of display[4].filter(card => card.kind === 'weapon')) {
    assert.ok(card.description && card.pattern && card.icon, `${card.title}保留独立玩法`);
  }
  assert.deepEqual(rewards, before, '旧存档和解锁记录不能被展示去重修改');
  assert.deepEqual(rewards.map(rewardCatalog.getRewardDisplayCards), display, '重复渲染结果一致');
});

function context() {
  const calls = [];
  return { calls, fillStyle: '#original', fillRect(x, y, w, h) { calls.push({ x, y, w, h, color: this.fillStyle }); } };
}

test('所有图标可在24格内整像素绘制，主武器轮廓可区分，未知ID降级', () => {
  assert.equal(ICON_SIZE, 24);
  const ids = ['normal', 'radar', 'dual', 'triple', 'distributed_i', 'distributed_ii', 'piercing', 'lightweight', 'fork', 'mysql', 'distributed', 'ultimate', 'trophy', 'index_medal'];
  const outlines = new Set();
  for (const id of ids) {
    const ctx = context();
    drawPixelIcon(ctx, id, 10, 20, 2, 0);
    assert.ok(ctx.calls.length > 0, id);
    assert.equal(ctx.fillStyle, '#original');
    const coverage = new Set();
    for (const call of ctx.calls) {
      assert.ok([call.x, call.y, call.w, call.h].every(Number.isInteger));
      assert.ok(call.x >= 10 && call.y >= 20 && call.x + call.w <= 10 + 48 && call.y + call.h <= 20 + 48, id);
      assert.ok(call.w > 0 && call.h > 0);
      assert.equal((call.x - 10) % 2, 0);
      assert.equal((call.y - 20) % 2, 0);
      for (let y = call.y; y < call.y + call.h; y += 2) for (let x = call.x; x < call.x + call.w; x += 2) coverage.add(`${x},${y}`);
    }
    outlines.add([...coverage].sort().join('|'));
  }
  assert.equal(outlines.size, ids.length, '图标不能只换颜色而沿用同一轮廓');
  const normal = context(), unknown = context();
  drawPixelIcon(normal, 'normal', 0, 0);
  assert.doesNotThrow(() => drawPixelIcon(unknown, 'unknown-weapon', 0, 0));
  assert.deepEqual(unknown.calls, normal.calls);
  assert.doesNotThrow(() => drawPixelIcon(context(), null, 0, 0));
});

test('帧变化可呈现武器像素闪动，仍不越界或依赖DOM', () => {
  for (const id of Object.keys(WEAPON_INFO)) {
    const first = context(), second = context();
    drawPixelIcon(first, id, 0, 0, 1, 0);
    drawPixelIcon(second, id, 0, 0, 1, 1);
    assert.notDeepEqual(first.calls, second.calls, id);
    assert.ok(second.calls.every(call => call.x >= 0 && call.y >= 0 && call.x + call.w <= ICON_SIZE && call.y + call.h <= ICON_SIZE));
  }
});

test('过关领取卡与已确认勋章/技能时机一致，第六关无虚构奖励', () => {
  assert.deepEqual(Object.keys(WEAPON_INFO), ['normal', 'radar', 'dual', 'triple', 'distributed_i', 'piercing', 'distributed_ii']);
  assert.deepEqual(['dual', 'distributed_i', 'piercing', 'distributed_ii'].map(id => WEAPON_INFO[id].title),
    ['HTAP 双响炮', '多模态扩展弹', '异步向量索引导弹', 'OceanBase 分布式火力支援']);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(level => getLevelRewards(level).length), [2, 2, 2, 2, 4, 0]);
  assert.deepEqual(getLevelRewards(1).map(card => [card.kind, card.id, card.title]), [
    ['medal', 'lightweight', '极致轻量'], ['weapon', 'triple', '嵌入式三联炮'],
  ]);
  assert.deepEqual(getLevelRewards(2).map(card => [card.kind, card.id]), [['medal', 'fork'], ['skill', 'fork']]);
  assert.equal(getLevelRewards(2).find(card => card.kind === 'skill').title, '试错机会');
  assert.equal(getLevelRewards(2).find(card => card.kind === 'skill').description,
    '在关卡内或关卡失败后，可重开本关一次；敌位和重开前一致，随后需要两关冷却时间。');
  assert.match(getLevelRewards(2).find(card => card.kind === 'skill').description, /本关.*一次.*两关冷却/);
  assert.deepEqual(getLevelRewards(3).map(card => [card.kind, card.id]), [['medal', 'mysql'], ['skill', 'mysql']]);
  assert.equal(getLevelRewards(3).find(card => card.kind === 'skill').title, 'MySQL兼容双响炮');
  assert.match(getLevelRewards(3).find(card => card.kind === 'skill').description, /每四轮/);
  assert.deepEqual(getLevelRewards(4).map(card => [card.kind, card.id]), [['medal', 'distributed'], ['weapon', 'distributed_i']]);
  assert.match(getLevelRewards(4)[0].description, /多模态扩展弹/);
  assert.deepEqual(getLevelRewards(5).filter(card => card.kind === 'medal').map(card => card.title), ['异步索引', '究极分布式扩展']);
  assert.deepEqual(getLevelRewards(5).filter(card => card.kind === 'weapon').map(card => card.id), ['piercing', 'distributed_ii']);
  assert.match(getLevelRewards(5)[0].description, /异步向量索引导弹/);
  assert.match(getLevelRewards(5)[2].description, /OceanBase 分布式火力支援/);
  for (const level of [1, 2, 3, 4, 5]) for (const card of getLevelRewards(level)) {
    assert.ok(['medal', 'weapon', 'skill'].includes(card.kind));
    assert.ok(card.icon && card.description);
    const ctx = context();
    drawPixelIcon(ctx, card.icon, 0, 0);
    assert.ok(ctx.calls.length);
  }
  assert.deepEqual(getLevelRewards(0), []);
  assert.deepEqual(getLevelRewards(7), []);
  assert.deepEqual(getLevelRewards('toString'), []);
});

test('全部12奖励卡与7武器都有独立seekdb特性说明及官方链接', () => {
  const cards = [1, 2, 3, 4, 5, 6].flatMap(getLevelRewards);
  assert.equal(cards.length, 12);
  assert.equal(Object.keys(WEAPON_INFO).length, 7);
  for (const item of [...cards, ...Object.values(WEAPON_INFO)]) {
    assert.ok(item.featureTitle);
    assert.equal(typeof item.featureDescription, 'string');
    assert.ok([...item.featureDescription].length >= 40 && [...item.featureDescription].length <= 80,
      `${item.id}特性说明长度${[...item.featureDescription].length}`);
    const url = new URL(item.featureUrl);
    assert.ok(url.protocol === 'https:' && (url.hostname === 'docs.seekdb.ai' || url.hostname === 'www.seekdb.ai'
      || url.hostname === 'seekdb.ai' || url.hostname === 'oceanbase.github.io' || url.hostname === 'docs.oceanbase.com'
      || url.hostname === 'github.com' && url.pathname.startsWith('/oceanbase/seekdb')));
    assert.notEqual(item.featureDescription, item.description, '真实特性与游戏效果分开');
  }
  assert.match(WEAPON_INFO.dual.featureTitle, /HTAP/);
  assert.match(WEAPON_INFO.dual.featureDescription, /OceanBase.*同一.*引擎.*同一.*数据/);
  assert.match(WEAPON_INFO.distributed_i.featureTitle, /多模态/);
  assert.match(WEAPON_INFO.distributed_i.featureDescription, /关系.*向量.*文本.*JSON/);
  assert.match(WEAPON_INFO.distributed_ii.featureDescription, /seekdb在浏览器本地执行范围SQL；OceanBase提供分布式扩展能力/);
  assert.doesNotMatch(WEAPON_INFO.distributed_ii.featureDescription, /seekdb支持分布式|不代表|不是.*测试|不能据此/);
  assert.match(WEAPON_INFO.piercing.featureTitle, /异步.*索引/);
  assert.match(WEAPON_INFO.piercing.featureDescription, /索引.*维护|维护.*索引/);
  assert.match(WEAPON_INFO.normal.featureTitle, /SQL条件与批量坐标查询/);
});

test('武器图案是原作四角4点、隔格9点和HARPOON五点X，弹包关系清晰', () => {
  assert.deepEqual(WEAPON_INFO.distributed_i.pattern, { size: 4, cells: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 }, { x: 3, y: 3 }] });
  assert.deepEqual(WEAPON_INFO.piercing.pattern, { size: 3, cells: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: 2, y: 2 }] });
  assert.equal(WEAPON_INFO.distributed_ii.pattern.size, 5);
  assert.deepEqual(WEAPON_INFO.distributed_ii.pattern.cells.map(cell => `${cell.x},${cell.y}`).sort(), ['0,0', '2,0', '4,0', '0,2', '2,2', '4,2', '0,4', '2,4', '4,4'].sort());
  assert.match(WEAPON_INFO.distributed_i.description, /共享.*一次/);
  assert.match(WEAPON_INFO.distributed_ii.description, /共享.*一次/);
  assert.match(WEAPON_INFO.piercing.description, /独立/);
  assert.equal(WEAPON_INFO.dual.pattern, undefined);
  assert.equal(WEAPON_INFO.triple.pattern, undefined);
  const first = getLevelRewards(4), second = getLevelRewards(4);
  first[1].pattern.cells[0].x = 99;
  assert.equal(second[1].pattern.cells[0].x, 0, 'UI修改返回卡片不得污染字典或下次领取');
});
