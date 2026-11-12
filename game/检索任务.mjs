/** 只生成目标与选项；选择后仍执行真实SQL，不在此判定查询成败。 */
import { createDetailEvidence } from './细节检索.mjs';

const METHODS = [
  { kind: 'range', ability: 'range', label: '时间范围' },
  { kind: 'keyword', ability: 'fulltext', label: '全文关键词' },
  { kind: 'vector', ability: 'vector', label: '回波样本' },
  { kind: 'filter', ability: 'filter', label: '条件过滤' },
];
const RELIABLE = new Set(['岸基观察站', '舰载雷达站', 'COAST', 'RADAR']);
const MISSION_THEMES = [
  { title: '时效核对：消息别过夜', opening: '先核对监听时间，昨天的消息今天不顶班。' },
  { title: '追口令：别跟着渡轮跑', opening: '海上代号多，先找本次作战口令。' },
  { title: '军民回波：认准推进器', opening: '民船也有发动机，军用回波另有特征。' },
  { title: '清旧任务：档案先归档', opening: '同名记录未必同次行动，任务与信源一起核对。' },
  { title: '潜艇补给追踪', opening: '潜艇小，资料不能马虎；先锁定可靠观测。' },
  { title: '终局双站会签', opening: '两站都签字，传闻别来凑数。' },
];
const WEBSITE = 'OceanBase 战舰队社区网站（https://open.oceanbase.com/）';
const FORMAL_CHANNELS = [
  '舰队电视新闻（主播领带歪了，口令没念歪）', '军港日报（头版，不是包鱼的旧报纸）',
  '官方电台（船长点歌前插播）', '军港公告（盖了章，没盖泡面）',
  '海军新闻发布会（记者先问完午饭）', '航务局公报（附件比船票还齐）',
  '海事气象专报（只报天气，不报心情）', '海防观察简报（望远镜擦过了）',
  '护航司令部通告（咖啡印不影响正文）', '联合舰队值班纪要（值班员终于没打哈欠）',
  '海军通信处通知（这次没串到点歌台）', '航道管理处公告（标点比航标还全）',
  '前沿观测站日报（海鸥没代笔）', '军港调度中心通报（喇叭先修好了）',
  '舰载雷达值班记录（屏幕不是在播球赛）', '岸基监听站公报（耳机线终于理顺）',
  '海军测绘中心简报（尺子没拿反）', '水文监测中心日报（没有拿汤勺量海）',
  '海事安全委员会公告（救生圈不负责签字）', '联合侦察组周报（组长先收起了自拍杆）',
  '巡航分队任务快讯（快艇慢点也会送到）', '舰队情报科摘要（不是食堂菜单摘要）',
  '港口安保中心通告（门卫这次没夹私货）', '海军训练中心通讯（教官没夹带俯卧撑）',
  '护航协调处公函（纸飞机已改回文件）', '海面监测中心快报（浪大，字没糊）',
  '舰队技术处设备报告（螺丝数也对上了）', '军用航标管理通报（灯泡不是气氛灯）',
  '海事搜救中心广播（先广播，再找饭盒）', '远洋补给舰队通报（没夹带罐头广告）',
  '舰队新闻编辑部专刊（错别字先下船）', '通信校准中心报告（杂音不算背景音乐）',
  '海防指挥部晨报（比起床号晚一分钟）', '海军档案馆核验件（管理员掸过灰了）',
  '联合指挥部发布稿（印章终于找到盖子）', '战区信息发布平台（不是船员相亲版）',
];
const RUMOR_CHANNELS = [
  '贿赂海盗（收钱时说自己从不骗人）', '酒馆小道消息（隔壁桌隔了三张桌）',
  '船长吹牛大会（鱼有航母那么大）', '码头大爷口述（眼镜忘在家里）',
  '半袋饼干换情报（对方先挑走夹心）', '坊间传言（坊也不知道谁先说的）',
  '鹦鹉复读现场（只学会最后半句）', '漂流瓶留言（瓶盖比内容新）',
  '海盗二手群（群主刚改名诚信船长）', '渔具店闲聊（买钩子送坐标）',
  '海鸥代送纸条（先啄掉一角）', '藏宝图背面（画图的人已晕船）',
  '澡堂战术讨论（蒸汽太大看不清）', '水手梦话（枕头说可以作证）',
  '港口算命摊（罗盘兼职算姻缘）', '修船工茶歇（扳手听完都摇头）',
  '旧船票背面涂鸦（日期被墨鱼盖住）', '跳蚤市场秘本（第二本半价）',
  '走私商友情价（友情另收手续费）', '甲板麻将桌（东风被当成方位）',
  '船员亲戚转述（亲戚的亲戚开过船）', '神秘热线来电（接通先卖保险）',
  '码头棋摊分析（将军和军舰没分清）', '章鱼占卜结果（八只手各指一边）',
  '海盗匿名投稿（署名是绝非海盗）', '锚链上捡的便签（字迹跟浪一样弯）',
  '船厨午饭预言（盐放多了才有灵感）', '救生圈留言板（留言者正在转圈）',
  '水族馆志愿者爆料（海豚拒绝背书）', '港口快递代收点（收件人写着随便）',
  '旧收音机串台（先听到半段广告）', '夜钓群语音（风声比人声坚定）',
  '船模店老板保证（比例尺忘乘一百）', '兜售捷径的向导（自己先迷了路）',
  '漂浮木板刻字（刻字时船已经开走）', '海边许愿池回音（硬币没找零）',
];
const clone = value => JSON.parse(JSON.stringify(value));
const finiteVector = vector => Array.isArray(vector) && vector.length === 8
  && Array.from({ length: 8 }, (_, i) => vector[i]).every(Number.isFinite);
const distance = (a, b) => Math.sqrt(a.reduce((sum, n, i) => sum + (n - b[i]) ** 2, 0));

function hash(value) {
  const text = String(value);
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return n >>> 0;
}

function shuffled(items, seed) {
  const result = [...items];
  let state = hash(seed);
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function levelId(level) {
  const id = typeof level === 'number' ? level : level?.id;
  if (!Number.isInteger(id) || id < 1 || id > 6) throw new RangeError('检索任务关卡无效');
  return id;
}

function campaignKey(seed, missionId) {
  if (seed !== undefined) return hash(seed).toString(16);
  return /^mission-\d+-(.+)$/.exec(missionId)?.[1] ?? String(missionId);
}

function acquisition(key, level, slot, formal) {
  const index = (level - 1) * 6 + slot;
  if (formal && hash(`${key}|website|${level}`) % 6 === slot) return WEBSITE;
  return shuffled(formal ? FORMAL_CHANNELS : RUMOR_CHANNELS, `${key}|${formal ? 'formal' : 'rumor'}`)[index];
}

function filterMatches(p, mission, level) {
  return p?.missionId === mission && Number.isFinite(p.minConfidence) && p.minConfidence >= 85
    && Array.isArray(p.sources) && p.sources.length > 0 && p.sources.every(source => RELIABLE.has(source))
    && p.minSources >= (level >= 6 ? 2 : 1);
}

function describeCard(card, military, missionId) {
  const p = card.payload;
  if (card.kind === 'range') return `时间：第${p.minRound}～${p.maxRound}轮`;
  if (card.kind === 'keyword') return `口令：${p.keyword}`;
  if (card.kind === 'vector') return `回波：${distance(p.vector, military) <= 0.42 ? '军用推进器回波' : '民船运输回波'}`;
  const sources = p.sources.map(source => ({ COAST: '岸基观察站', RADAR: '舰载雷达站', RUMOR: '港口传闻' })[source] ?? source);
  return `任务：${p.missionId === missionId ? '本次行动' : '历史行动'}；来源：${sources.join('、')}；可信度：至少${p.minConfidence}；独立来源数：至少${p.minSources}`;
}

/** 每种已解锁方法各两项；goal和target明确给出需要匹配的值，mismatch只供失败后解释。 */
export function createReconTask({ deal, level = 1, seed } = {}) {
  const id = levelId(level);
  if (!deal || !Array.isArray(deal.cards) || !deal.cards.length || !Array.isArray(deal.rows)
    || !deal.missionId || !deal.callSign) throw new RangeError('缺少完整定位资料');
  const ranges = deal.cards.filter(card => card.kind === 'range' && Number.isInteger(card.payload?.maxRound));
  const round = Math.max(...ranges.map(card => card.payload.maxRound)), start = Math.max(1, round - 2);
  if (!Number.isInteger(round) || round < 1) throw new RangeError('定位资料缺少当前时间');
  const references = deal.rows.filter(row => row.mission_id === deal.missionId && row.call_sign === deal.callSign
    && row.ship_class === 'warship' && row.observed_round === round && RELIABLE.has(row.source) && finiteVector(row.embedding));
  if (!references.length) throw new RangeError('定位资料缺少当前军用回波');
  const military = Array.from({ length: 8 }, (_, i) => references.reduce((sum, row) => sum + row.embedding[i], 0) / references.length);
  const key = campaignKey(seed, deal.missionId);
  const groups = METHODS.slice(0, Math.min(id, 4)).map((method, slot) => {
    const cards = deal.cards.filter(card => card.kind === method.kind).sort((a, b) => a.id.localeCompare(b.id));
    const match = card => {
      const p = card.payload;
      if (method.kind === 'range') return p?.minRound === start && p.maxRound === round;
      if (method.kind === 'keyword') return p?.keyword === deal.callSign;
      if (method.kind === 'vector') return finiteVector(p?.vector) && distance(p.vector, military) <= 0.42;
      return filterMatches(p, deal.missionId, id);
    };
    const good = cards.find(match);
    const wrong = cards.filter(card => {
      const p = card.payload;
      if (method.kind === 'range') return Number.isInteger(p?.minRound) && Number.isInteger(p.maxRound)
        && p.minRound <= p.maxRound && (p.minRound === 0 || p.maxRound < start) && !match(card);
      if (method.kind === 'keyword') return typeof p?.keyword === 'string' && p.keyword && !match(card);
      if (method.kind === 'vector') return finiteVector(p?.vector) && distance(p.vector, military) > 0.42;
      return p?.missionId && Array.isArray(p.sources) && p.sources.length
        && (p.missionId !== deal.missionId || p.sources.some(source => !RELIABLE.has(source)));
    });
    if (!good || !wrong.length) throw new RangeError(`定位资料缺少可对照的${method.kind}选项`);
    const bad = wrong[hash(`${key}|${id}|${method.kind}|alternative`) % wrong.length];
    const target = describeCard(good, military, deal.missionId);
    let mismatch;
    if (method.kind === 'range') mismatch = `时间不符：需要第${start}～${round}轮，这张是第${bad.payload.minRound}～${bad.payload.maxRound}轮旧档案。`;
    if (method.kind === 'keyword') mismatch = `口令不符：需要${deal.callSign}，这张是${bad.payload.keyword}。`;
    if (method.kind === 'vector') mismatch = '回波不符：需要军用推进器回波，这张是民船运输回波。';
    if (method.kind === 'filter') mismatch = bad.payload.missionId !== deal.missionId
      ? '任务不符：需要本次行动，这张属于历史行动。'
      : `来源和可信度不符：需要岸基观察站、舰载雷达站，可信度至少85${id === 6 ? '且至少2个独立来源' : ''}；这张是港口传闻。`;
    const make = (card, hint, formal) => ({ ...clone(card), description: describeCard(card, military, deal.missionId),
      acquisition: acquisition(key, id, slot, formal), mismatch: hint });
    return { ...method, target, choices: shuffled([make(good, '', true), make(bad, mismatch, false)], `${key}|${id}|recon|${method.kind}|${round}`) };
  });
  const theme = MISSION_THEMES[id - 1];
  return { title: theme.title, goal: `${theme.opening}本次目标：${groups.map(group => group.target).join('；')}。`, groups };
}

/** 追加侦察各提供唯一有效回波和监听，仍需玩家点击加入实际SQL。 */
export function createDetailTask({ evidence, seed, level = 1 } = {}) {
  const id = levelId(level);
  if (!evidence) throw new RangeError('缺少详情资料');
  const detail = evidence.signalStory && Array.isArray(evidence.samples) ? evidence
    : createDetailEvidence({ evidence, level: id, seed: seed ?? 1 });
  const story = detail.signalStory;
  const sample = detail.samples.find(item => item.name === 'warship' && finiteVector(item.vector));
  const keyword = story?.listen?.keyword;
  if (!sample || !keyword || !story.echo?.source || !story.listen.source) {
    throw new RangeError('详情资料缺少有效回波或监听选项');
  }
  const mission = detail.rows?.[0]?.mission_id ?? evidence.missionId ?? story.id;
  const key = campaignKey(seed, mission), tag = `${key}|${id}|${story.id}`;
  const echo = { id: `echo-${hash(`${tag}|${sample.name}`)}`, name: sample.name,
    label: sample.label, vector: [...sample.vector], source: story.echo.source, text: story.echo.text,
    acquisition: acquisition(key, id, 4, true), mismatch: '' };
  const listen = { id: `listen-${hash(`${tag}|${keyword}`)}`, keyword, label: story.listen.label,
    source: story.listen.source, text: story.listen.text, acquisition: acquisition(key, id, 5, true), mismatch: '' };
  const groups = [
    { kind: 'echo', label: '回波样本', target: `回波：${sample.label}`,
      choices: [echo] },
    { kind: 'keyword', label: '全文关键词', target: `监听词：${keyword}（${story.listen.label}）`,
      choices: [listen] },
  ];
  return { title: story.title, goal: `本次目标：${groups.map(group => group.target).join('；')}。`, groups };
}
