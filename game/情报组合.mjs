/** 只编排可点击的两套资料；成败仍由真实SQL结果及流程裁判判断。 */
import { createDetailEvidence } from './细节检索.mjs';

const METHODS = [
  { ability: 'range', kind: 'range' }, { ability: 'fulltext', kind: 'keyword' },
  { ability: 'vector', kind: 'vector' }, { ability: 'filter', kind: 'filter' },
];
const RELIABLE_SOURCES = new Set(['岸基观察站', '舰载雷达站', 'COAST', 'RADAR']);
const TITLES = ['岸台整理稿', '巡航抄录稿', '值更台联单', '航海图附件', '联合监听单', '护航队备忘'];
const clone = value => JSON.parse(JSON.stringify(value));
const finiteVector = vector => Array.isArray(vector) && vector.length === 8
  && Array.from({ length: 8 }, (_, i) => vector[i]).every(Number.isFinite);
const distance = (a, b) => Math.sqrt(a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0));

function hash(value) {
  let n = 2166136261;
  for (const char of String(value)) n = Math.imul(n ^ char.charCodeAt(0), 16777619);
  n = Math.imul(n ^ n >>> 16, 0x85ebca6b);
  return (n ^ n >>> 13) >>> 0;
}

function levelId(level) {
  const id = typeof level === 'number' ? level : level?.id;
  if (!Number.isInteger(id) || id < 1 || id > 6) throw new RangeError('资料组合关卡无效');
  return id;
}

function orderedPair(items, seed) {
  const pair = hash(`${seed}|order`) % 2 ? [...items].reverse() : [...items];
  const firstTitle = hash(`${seed}|titles`) % TITLES.length;
  return pair.map((item, index) => ({ ...item, title: TITLES[(firstTitle + index) % TITLES.length] }));
}

function currentFilter(payload, missionId, level) {
  return payload?.missionId === missionId && payload.minConfidence >= 85 && Array.isArray(payload.sources)
    && payload.sources.length > 0 && payload.sources.every(source => RELIABLE_SOURCES.has(source))
    && payload.minSources >= (level >= 6 ? 2 : 1);
}

function reconDescription(cards, deal, military) {
  const pieces = [];
  for (const card of cards) {
    const p = card.payload;
    if (card.kind === 'range') pieces.push(`时间：第${p.minRound}～${p.maxRound}轮`);
    if (card.kind === 'keyword') pieces.push(`口令：${p.keyword}`);
    if (card.kind === 'vector') pieces.push(`回波：${distance(p.vector, military) <= 0.42 ? '军用推进器' : '民船运输样本'}`);
    if (card.kind === 'filter') pieces.push(`任务：${p.missionId === deal.missionId ? '本次行动' : '历史行动'}；来源：${p.sources.join('＋')}`);
  }
  return pieces.join('；') + '。';
}

/** 每关提供两套完整资料，只让其中一套替换一个语义条件；不标记正误。 */
export function createReconChoices({ deal, level = 1 } = {}) {
  const id = levelId(level);
  if (!deal || !Array.isArray(deal.cards) || !deal.cards.length || !Array.isArray(deal.rows)
    || !deal.missionId || !deal.callSign) throw new RangeError('缺少完整定位资料');
  const methods = METHODS.slice(0, Math.min(id, 4));
  const rangeCards = deal.cards.filter(card => card.kind === 'range' && Number.isFinite(card.payload?.maxRound));
  const round = Math.max(...rangeCards.map(card => card.payload.maxRound));
  if (!Number.isInteger(round) || round < 1) throw new RangeError('定位资料没有当前监听时间');
  const start = Math.max(1, round - 2);
  const armyRows = deal.rows.filter(row => row.mission_id === deal.missionId && row.call_sign === deal.callSign
    && row.ship_class === 'warship' && row.observed_round === round && RELIABLE_SOURCES.has(row.source)
    && finiteVector(row.embedding)).sort((a, b) => a.id.localeCompare(b.id));
  if (!armyRows.length) throw new RangeError('定位资料没有当前军用参考回波');
  const military = Array.from({ length: 8 }, (_, i) => armyRows.reduce((sum, row) => sum + row.embedding[i], 0) / armyRows.length);
  const chosen = methods.map(method => {
    const candidates = deal.cards.filter(card => card.kind === method.kind);
    let card;
    if (method.kind === 'range') card = candidates.find(c => c.payload?.minRound === start && c.payload.maxRound === round);
    if (method.kind === 'keyword') card = candidates.find(c => c.payload?.keyword === deal.callSign);
    if (method.kind === 'vector') card = candidates.filter(c => finiteVector(c.payload?.vector))
      .sort((a, b) => distance(a.payload.vector, military) - distance(b.payload.vector, military))
      .find(c => distance(c.payload.vector, military) <= 0.42);
    if (method.kind === 'filter') card = candidates.find(c => currentFilter(c.payload, deal.missionId, id));
    if (!card) throw new RangeError(`定位资料缺少当前${method.kind}证据`);
    return clone(card);
  });
  const kind = id === 1 ? 'range' : id === 2 ? 'keyword' : id === 3 ? 'vector' : 'filter';
  const wrongCandidates = deal.cards.filter(card => {
    if (card.kind !== kind) return false;
    const p = card.payload;
    if (kind === 'range') return Number.isInteger(p?.minRound) && Number.isInteger(p.maxRound)
      && p.minRound <= p.maxRound && (p.minRound === 0 || p.maxRound < start);
    if (kind === 'keyword') return typeof p?.keyword === 'string' && p.keyword !== deal.callSign;
    if (kind === 'vector') return finiteVector(p?.vector) && distance(p.vector, military) > 0.42;
    return p?.missionId && Array.isArray(p.sources) && p.sources.length
      && (p.missionId !== deal.missionId || p.sources.some(source => !RELIABLE_SOURCES.has(source)));
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!wrongCandidates.length) throw new RangeError(`定位资料缺少可对照的${kind}证据`);
  const seed = `${deal.missionId}|${deal.phase}|${round}|${deal.callSign}`;
  const replacement = clone(wrongCandidates[hash(`${seed}|replacement`) % wrongCandidates.length]);
  const alternative = chosen.map(card => card.kind === kind ? replacement : clone(card));
  let rejectionHint;
  if (kind === 'range') rejectionHint = `这套用了第${replacement.payload.minRound}～${replacement.payload.maxRound}轮档案；本轮有效窗口是第${start}～${round}轮。`;
  if (kind === 'keyword') rejectionHint = `这套口令是${replacement.payload.keyword}，本次要找的编队口令是${deal.callSign}；时间正确也会查到别的记录。`;
  if (kind === 'vector') rejectionHint = '这套用了民船运输回波，军用推进器特征没有匹配；口令相同也不能把民船当敌舰。';
  if (kind === 'filter') rejectionHint = replacement.payload.missionId !== deal.missionId
    ? '这套任务编号属于历史行动；同名回波不能替代当前任务记录。'
    : '这套只收传闻或未确认来源，缺少当前任务的可靠站点；转载次数不等于独立互证。';
  const make = (cards, hint) => ({ id: `combo-${hash(JSON.stringify([seed, cards.map(card => [card.kind, card.payload])]))}`,
    description: reconDescription(cards, deal, military), cards, abilities: methods.map(method => method.ability), rejectionHint: hint });
  return orderedPair([make(chosen, '这套尚未锁定目标，请对照实际结果复核任务、时间和来源。'), make(alternative, rejectionHint)], seed);
}

/** 接受详情资料或原始定位deal；两套只改变回波，监听词相同，实际SQL决定是否得到extra。 */
export function createDetailChoices({ evidence, seed = 1, level = 1 } = {}) {
  const id = levelId(level);
  if (!evidence) throw new RangeError('缺少详情资料');
  const detail = evidence.signalStory && Array.isArray(evidence.samples) ? evidence
    : createDetailEvidence({ evidence, level: id, seed });
  const sample = detail.samples.find(item => item.name === 'warship' && finiteVector(item.vector));
  const alternatives = detail.samples.filter(item => ['civil', 'noise'].includes(item.name) && finiteVector(item.vector));
  const keyword = detail.signalStory?.listen?.keyword;
  if (!sample || !alternatives.length || !keyword) throw new RangeError('详情资料缺少有效回波或监听卡');
  const tag = `${seed}|${id}|${detail.signalStory.id}`;
  const other = alternatives[hash(`${tag}|echo`) % alternatives.length];
  const make = (selected, hint) => ({ id: `combo-${hash(JSON.stringify([tag, selected.vector, keyword]))}`,
    description: `回波：${selected.label}；来源：${selected.name === 'warship' ? detail.signalStory.echo.source : selected.name === 'civil' ? '民船电台' : '气象浮标'}；监听：${keyword}（${detail.signalStory.listen.source}）。`,
    sample: clone(selected), keyword, rejectionHint: hint });
  return orderedPair([make(sample, '尚未取得战术观测，请核对实际查询返回的任务与海区。'),
    make(other, `这套用了${other.label}，与本任务的${sample.label}不相符；监听词虽然相同，还需要匹配正确回波。`)], tag);
}
