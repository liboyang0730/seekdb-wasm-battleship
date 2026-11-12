import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconChoices, createDetailChoices } from './情报组合.mjs';
import { LEVELS, createEnemyFleet, generateEvidence, buildQuery } from './海战规则.mjs';
import { createDetailEvidence, buildDetailQuery } from './细节检索.mjs';

const distance = (a, b) => Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
const sources = new Set(['岸基观察站', '舰载雷达站', 'COAST', 'RADAR']);
const abilityKinds = { range: 'range', fulltext: 'keyword', vector: 'vector', filter: 'filter' };

function parametersMatch(choice, deal, level, round) {
  const card = kind => choice.cards.find(c => c.kind === kind)?.payload;
  const range = card('range');
  if (range?.minRound !== Math.max(1, round - 2) || range.maxRound !== round) return false;
  if (level >= 2 && card('keyword')?.keyword !== deal.callSign) return false;
  if (level >= 3) {
    const army = deal.rows.find(r => r.mission_id === deal.missionId && r.call_sign === deal.callSign
      && r.ship_class === 'warship' && r.observed_round === round && sources.has(r.source));
    if (distance(card('vector').vector, army.embedding) > 0.42) return false;
  }
  if (level >= 4) {
    const filter = card('filter');
    if (filter?.missionId !== deal.missionId || filter.minConfidence < 85 || !filter.sources.every(s => sources.has(s))
      || filter.minSources < (level >= 6 ? 2 : 1)) return false;
  }
  return true;
}

test('六关各16seed定位恰有两套且一套匹配真实任务，仅替错一类，顺序可变且稳定', () => {
  for (const level of LEVELS) {
    const goodIndices = new Set();
    for (let i = 0; i < 16; i++) {
      const seed = `combo-${i}`, round = 7;
      const deal = generateEvidence({ fleet: createEnemyFleet({ level, seed }), level, seed, round });
      const before = JSON.stringify(deal);
      const choices = createReconChoices({ deal, level });
      assert.equal(choices.length, 2);
      assert.equal(new Set(choices.map(c => c.id)).size, 2);
      assert.deepEqual(createReconChoices({ deal: JSON.parse(JSON.stringify(deal)), level: level.id }), choices);
      const matches = choices.map(c => parametersMatch(c, deal, level.id, round));
      assert.equal(matches.filter(Boolean).length, 1);
      goodIndices.add(matches.indexOf(true));
      const changedKinds = choices[0].cards.filter(card => JSON.stringify(card.payload) !== JSON.stringify(choices[1].cards.find(c => c.kind === card.kind).payload));
      assert.equal(changedKinds.length, 1);
      for (const choice of choices) {
        const plan = buildQuery({ selectedCards: choice.cards, abilities: choice.abilities, missionId: deal.missionId, round });
        assert.equal(plan.valid, true, '干扰必须是可实际执行但条件错误的SQL，不是非法输入');
        assert.equal(Object.hasOwn(choice, 'isCorrect'), false);
        assert.doesNotMatch(choice.id, /correct|wrong|good|bad|true|false/i);
        assert.ok(choice.title && choice.description && choice.rejectionHint);
        assert.deepEqual(choice.abilities, ['range', 'fulltext', 'vector', 'filter'].slice(0, Math.min(level.id, 4)));
        assert.ok(choice.cards.every(c => choice.abilities.some(a => abilityKinds[a] === c.kind)));
      }
      assert.equal(JSON.stringify(deal), before);
    }
    assert.equal(goodIndices.size, 2, '有效套不可永远位于同一位置');
  }
});

test('详情两套监听词相同，仅回波不同，恰有一套可匹配目标额外观测', () => {
  for (const level of LEVELS) for (let i = 0; i < 12; i++) {
    const seed = `detail-combo-${i}`;
    const deal = generateEvidence({ fleet: createEnemyFleet({ level, seed }), level, seed });
    const evidence = createDetailEvidence({ evidence: deal, level, seed });
    const choices = createDetailChoices({ evidence, level, seed });
    assert.equal(choices.length, 2);
    assert.deepEqual(createDetailChoices({ evidence: deal, level: level.id, seed }), choices);
    assert.deepEqual(createDetailChoices({ evidence: JSON.parse(JSON.stringify(evidence)), level, seed }), choices);
    const matches = choices.filter(c => distance(c.sample.vector, evidence.signalStory.echo.vector) <= 0.42
      && c.keyword === evidence.signalStory.listen.keyword);
    assert.equal(matches.length, 1);
    assert.equal(choices[0].keyword, choices[1].keyword);
    assert.notEqual(choices[0].sample.name, choices[1].sample.name);
    for (const choice of choices) {
      assert.equal(Object.hasOwn(choice, 'isCorrect'), false);
      assert.doesNotMatch(choice.id, /correct|wrong|good|bad|true|false/i);
      assert.ok(choice.title && choice.description && choice.rejectionHint);
      assert.equal(buildDetailQuery({ sectorId: deal.truth.targetSector, missionId: deal.missionId,
        vector: choice.sample.vector, keyword: choice.keyword }).valid, true);
    }
  }
});

test('不完整资料明确拒绝生成组合，返回副本不污染后续选项', () => {
  assert.throws(() => createReconChoices({}), /资料/);
  assert.throws(() => createDetailChoices({}), /资料/);
  const deal = generateEvidence({ fleet: createEnemyFleet({ level: 4, seed: 'copy' }), level: 4, seed: 'copy' });
  const first = createReconChoices({ deal, level: 4 }), expected = JSON.parse(JSON.stringify(first));
  first[0].cards[0].payload.minRound = -99;
  assert.deepEqual(createReconChoices({ deal, level: 4 }), expected);
  assert.throws(() => createReconChoices({ deal: { ...deal, cards: [] }, level: 4 }), /资料/);
});
