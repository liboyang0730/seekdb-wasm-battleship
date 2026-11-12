import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, createEnemyFleet, generateEvidence, buildQuery } from './海战规则.mjs';
import { createDetailEvidence, buildDetailQuery } from './细节检索.mjs';

let api = {};
try { api = await import('./检索任务.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const distance = (a, b) => Math.sqrt(a.reduce((sum, n, i) => sum + (n - b[i]) ** 2, 0));
const reliable = new Set(['岸基观察站', '舰载雷达站', 'COAST', 'RADAR']);

function matches(card, deal, level, round) {
  const p = card.payload;
  if (card.kind === 'range') return p.minRound === Math.max(1, round - 2) && p.maxRound === round;
  if (card.kind === 'keyword') return p.keyword === deal.callSign;
  if (card.kind === 'vector') {
    const row = deal.rows.find(r => r.mission_id === deal.missionId && r.call_sign === deal.callSign
      && r.ship_class === 'warship' && r.observed_round === round && reliable.has(r.source));
    return distance(p.vector, row.embedding) <= 0.42;
  }
  return p.missionId === deal.missionId && p.minConfidence >= 85 && p.sources.every(s => reliable.has(s))
    && p.minSources >= (level >= 6 ? 2 : 1);
}

test('六关逐方法两项仅一项匹配目标，目标字段完整且随机顺序可复现', () => {
  assert.equal(typeof api.createReconTask, 'function', '缺少逐方法定位任务生成器');
  for (const level of LEVELS) {
    const orders = new Map();
    for (let i = 0; i < 16; i++) {
      const seed = `recon-task-${i}`, round = 7;
      const deal = generateEvidence({ fleet: createEnemyFleet({ level, seed }), level, seed, round });
      const before = JSON.stringify(deal);
      const task = api.createReconTask({ deal, level, seed });
      assert.deepEqual(api.createReconTask({ deal: JSON.parse(before), level: level.id, seed }), task);
      assert.ok(task.title && task.goal);
      assert.deepEqual(task.groups.map(g => g.kind), ['range', 'keyword', 'vector', 'filter'].slice(0, Math.min(level.id, 4)));
      const selected = [];
      for (const group of task.groups) {
        assert.equal(group.choices.length, 2);
        const matched = group.choices.filter(c => matches(c, deal, level.id, round));
        assert.equal(matched.length, 1, '每种方法都需恰好一项符合公开目标');
        const card = matched[0]; selected.push(card);
        assert.equal(card.description, group.target, '目标与选项使用同一套字段和数值');
        assert.ok(task.goal.includes(group.target));
        assert.equal(card.mismatch, '');
        assert.equal(group.choices.find(c => c !== card).mismatch.length > 0, true);
        if (!orders.has(group.kind)) orders.set(group.kind, new Set());
        orders.get(group.kind).add(group.choices.indexOf(card));
        for (const choice of group.choices) {
          assert.ok(choice.description && choice.acquisition);
          assert.equal(Object.hasOwn(choice, 'isCorrect'), false);
          assert.deepEqual(choice.payload, deal.cards.find(c => c.id === choice.id).payload);
        }
        if (group.kind === 'range') assert.ok(group.target.includes('第5～7轮'));
        if (group.kind === 'keyword') assert.ok(group.target.includes(deal.callSign));
        if (group.kind === 'vector') assert.ok(group.target.includes('军用推进器回波'));
        if (group.kind === 'filter') {
          for (const field of ['任务：本次行动', '岸基观察站', '舰载雷达站', '可信度', '85', '独立来源数', level.id === 6 ? '2' : '1']) {
            assert.ok(group.target.includes(field), `条件目标缺少${field}`);
          }
          assert.equal(group.target.includes(deal.missionId), false, '玩家目标不要求核对技术任务ID');
        }
      }
      assert.equal(buildQuery({ selectedCards: selected, abilities: task.groups.map(g => g.ability),
        missionId: deal.missionId, round }).valid, true);
      assert.equal(JSON.stringify(deal), before);
    }
    for (const order of orders.values()) assert.equal(order.size, 2, '正确项不能固定在同一侧');
  }
});

test('追加侦察只提供唯一有效回波和监听，原始资料仍保留SQL干扰行', () => {
  assert.equal(typeof api.createDetailTask, 'function', '缺少逐方法详情任务生成器');
  for (const level of LEVELS) {
    for (let i = 0; i < 12; i++) {
      const seed = `detail-task-${i}`;
      const deal = generateEvidence({ fleet: createEnemyFleet({ level, seed }), level, seed });
      const evidence = createDetailEvidence({ evidence: deal, level, seed });
      const task = api.createDetailTask({ evidence, seed, level });
      assert.deepEqual(api.createDetailTask({ evidence: deal, seed, level: level.id }), task);
      assert.deepEqual(api.createDetailTask({ evidence: JSON.parse(JSON.stringify(evidence)), seed, level }), task);
      assert.deepEqual(task.groups.map(g => g.kind), ['echo', 'keyword']);
      for (const group of task.groups) {
        assert.equal(group.choices.length, 1);
        const correct = group.choices.filter(c => group.kind === 'echo'
          ? c.name === 'warship' && distance(c.vector, evidence.signalStory.echo.vector) <= 0.42
          : c.keyword === evidence.signalStory.listen.keyword);
        assert.equal(correct.length, 1);
        assert.equal(correct[0].mismatch, '');
        assert.ok(group.target.includes(group.kind === 'echo' ? evidence.signalStory.echo.label : evidence.signalStory.listen.keyword));
        assert.ok(task.goal.includes(group.target));
        for (const choice of group.choices) {
          assert.ok(choice.id && choice.source && choice.text && choice.acquisition);
          assert.equal(Object.hasOwn(choice, 'isCorrect'), false);
        }
      }
      const echo = task.groups[0], words = task.groups[1];
      for (const sample of echo.choices) for (const word of words.choices) {
        assert.equal(buildDetailQuery({ sectorId: deal.truth.targetSector, missionId: deal.missionId,
          vector: sample.vector, keyword: word.keyword }).valid, true);
      }
      assert.ok(evidence.rows.some(r => r.kind === 'non_tactical'), '不删真实SQL干扰资料，只简化玩家可选项');
    }
  }
});

test('六关定位任务标题与开场不同，详情标题沿用本次真实剧本', () => {
  const titles = new Set(), openings = new Set();
  for (const level of LEVELS) {
    const seed = 'mission-themes';
    const deal = generateEvidence({ fleet: createEnemyFleet({ level, seed }), level, seed });
    const recon = api.createReconTask({ deal, level, seed });
    titles.add(recon.title); openings.add(recon.goal.split('本次目标：')[0]);
    assert.ok(recon.groups.every(group => recon.goal.includes(group.target)));
    const detail = createDetailEvidence({ evidence: deal, level, seed });
    assert.ok(api.createDetailTask({ evidence: detail, level, seed }).title.includes(detail.signalStory.title));
  }
  assert.equal(titles.size, 6); assert.equal(openings.size, 6);
});

test('定位18个干扰渠道与30个正式渠道按槽去重，网站仅用于正确项且每关至多一次', () => {
  assert.equal(typeof api.createReconTask, 'function');
  assert.equal(typeof api.createDetailTask, 'function');
  const campaigns = [];
  const website = 'OceanBase 战舰队社区网站（https://open.oceanbase.com/）';
  for (const seed of ['channel-A', 'channel-B']) {
    const channels = [], formalChannels = [];
    for (const level of LEVELS) {
      const deal = generateEvidence({ fleet: createEnemyFleet({ level, seed }), level, seed });
      const detail = createDetailEvidence({ evidence: deal, level, seed });
      let websiteCount = 0;
      for (const task of [api.createReconTask({ deal, level, seed }), api.createDetailTask({ evidence: detail, level, seed })]) {
        for (const group of task.groups) for (const choice of group.choices) {
          if (choice.mismatch) {
            channels.push(choice.acquisition);
            assert.equal(choice.acquisition.includes('open.oceanbase.com'), false, '网站不能用于任何干扰项');
          } else {
            formalChannels.push(choice.acquisition);
            if (choice.acquisition === website) websiteCount++;
          }
        }
      }
      assert.ok(websiteCount <= 1);
    }
    assert.equal(channels.length, 18);
    assert.equal(new Set(channels).size, 18);
    assert.equal(formalChannels.length, 30);
    const otherFormal = formalChannels.filter(channel => channel !== website);
    assert.equal(new Set(otherFormal).size, otherFormal.length, '只有指定网站允许跨关重复');
    campaigns.push(channels);
  }
  assert.notDeepEqual(campaigns[0], campaigns[1]);
  assert.throws(() => api.createReconTask({}), /资料/);
  assert.throws(() => api.createDetailTask({}), /资料/);
  const seed = 'copy-task', level = 4;
  const deal = generateEvidence({ fleet: createEnemyFleet({ level, seed }), level, seed });
  const first = api.createReconTask({ deal, level, seed });
  const expected = JSON.parse(JSON.stringify(first));
  first.groups[0].choices[0].payload.minRound = -9;
  assert.deepEqual(api.createReconTask({ deal, level, seed }), expected);
  const detail = createDetailEvidence({ evidence: deal, level, seed });
  const second = api.createDetailTask({ evidence: detail, level, seed });
  const detailExpected = JSON.parse(JSON.stringify(second));
  second.groups[0].choices[0].vector[0] = -9;
  assert.deepEqual(api.createDetailTask({ evidence: detail, level, seed }), detailExpected);
});
