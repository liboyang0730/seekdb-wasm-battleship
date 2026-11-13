/** 纯代码像素图鉴：不读取图片文件，也不依赖DOM。 */
import { FORK_DESCRIPTION } from './作战流程.mjs';
export const ICON_SIZE = 24;

const COLORS = Object.freeze({ navy: '#173e52', blue: '#4f91a5', cream: '#f4ead2', coral: '#ed8c76', gold: '#f2c76d' });
const ICON_IDS = new Set(['normal', 'radar', 'dual', 'triple', 'distributed_i', 'distributed_ii', 'piercing',
  'lightweight', 'fork', 'mysql', 'distributed', 'ultimate', 'trophy', 'index_medal']);

function glyph(id, blink) {
  const pixels = [];
  const r = (x, y, w, h, color = 'navy') => pixels.push([x, y, w, h, COLORS[color]]);
  const missile = (x, y, height) => {
    r(x + 2, y, 2, 2); r(x, y + 2, 6, height);
    r(x + 2, y + 2, 2, height - 2, 'cream');
    r(x - 1, y + height - 1, 2, 4, 'blue'); r(x + 5, y + height - 1, 2, 4, 'blue');
    r(x + 2, y + height + 2, 2, 2, blink ? 'gold' : 'coral');
  };
  const blast = (x, y, color) => {
    r(x + 1, y, 3, 5, color); r(x, y + 1, 5, 3, color); r(x + 2, y + 2, 1, 1, 'cream');
  };
  switch (id) {
    case 'normal':
      r(11, 2, 2, 2); r(9, 4, 6, 2); r(8, 6, 8, 12); r(10, 5, 4, 11, 'cream');
      r(6, 15, 3, 5, 'blue'); r(15, 15, 3, 5, 'blue'); r(10, 18, 4, 4, blink ? 'gold' : 'coral');
      break;
    case 'radar':
      r(8, 2, 8, 2); r(4, 4, 16, 2); r(2, 6, 20, 12); r(4, 18, 16, 2); r(8, 20, 8, 2);
      r(6, 5, 12, 2, 'cream'); r(4, 7, 16, 10, 'cream'); r(6, 17, 12, 2, 'cream');
      r(10, 10, 4, 4, 'blue');
      if (blink) { r(12, 7, 2, 5, 'gold'); r(14, 6, 3, 2, 'gold'); }
      else { r(12, 12, 6, 2, 'coral'); r(17, 14, 2, 3, 'coral'); }
      break;
    case 'dual':
      missile(4, 2, 14); missile(14, 2, 14);
      break;
    case 'triple':
      missile(1, 7, 8); missile(9, 2, 8); missile(17, 7, 8);
      break;
    case 'distributed_i':
      r(4, 4, 16, 1, 'blue'); r(4, 19, 16, 1, 'blue'); r(4, 4, 1, 16, 'blue'); r(19, 4, 1, 16, 'blue');
      for (const y of [2, 18]) for (const x of [2, 18]) blast(x, y, blink ? 'gold' : 'coral');
      break;
    case 'distributed_ii':
      for (const y of [2, 10, 18]) for (const x of [2, 10, 18]) blast(x, y, blink ? 'gold' : 'coral');
      break;
    case 'piercing':
      for (const [x, y] of [[7, 7], [15, 7], [7, 15], [15, 15]]) r(x, y, 2, 2, 'blue');
      for (const [x, y] of [[2, 2], [17, 2], [9, 9], [2, 17], [17, 17]]) blast(x, y, blink ? 'gold' : 'coral');
      break;
    case 'lightweight':
      r(15, 2, 6, 2, 'gold'); r(11, 4, 10, 3, 'cream'); r(8, 7, 12, 3, 'cream');
      r(6, 10, 12, 3, 'cream'); r(5, 13, 10, 3, 'cream'); r(5, 16, 7, 2, 'cream');
      r(16, 5, 2, 2, 'blue'); r(13, 8, 2, 2, 'blue'); r(10, 11, 2, 2, 'blue');
      r(7, 14, 2, 3, 'blue'); r(5, 17, 2, 5, 'blue'); r(8, 18, 4, 2, 'gold');
      break;
    case 'fork':
      r(3, 3, 6, 2, 'cream'); r(3, 3, 2, 6, 'cream'); r(5, 6, 3, 3, 'blue'); r(7, 9, 3, 3, 'blue');
      r(15, 3, 6, 2, 'cream'); r(19, 3, 2, 6, 'cream'); r(16, 6, 3, 3, 'coral'); r(14, 9, 3, 3, 'coral');
      r(10, 11, 4, 5, 'gold'); r(11, 16, 2, 6, 'cream');
      break;
    case 'mysql':
      r(6, 2, 12, 2, 'cream'); r(4, 4, 16, 3); r(3, 7, 18, 11); r(4, 18, 16, 3);
      r(5, 6, 14, 2, 'cream'); r(5, 10, 14, 2, 'blue'); r(5, 15, 14, 2, 'cream');
      r(18, 11, 3, 2, 'gold'); r(20, 13, 3, 2, 'gold'); r(18, 15, 3, 2, 'gold');
      break;
    case 'distributed':
      r(5, 1, 5, 7, 'coral'); r(14, 1, 5, 7, 'blue'); r(6, 7, 12, 2); r(3, 9, 18, 10); r(6, 19, 12, 3);
      r(6, 10, 12, 8, 'gold');
      for (const y of [11, 15]) for (const x of [7, 14]) r(x, y, 3, 2, 'cream');
      break;
    case 'ultimate':
      r(10, 1, 4, 4, 'gold'); r(7, 5, 10, 3, 'gold'); r(2, 8, 20, 8, 'gold');
      r(5, 16, 14, 2, 'gold'); r(7, 18, 10, 2, 'gold'); r(10, 20, 4, 3, 'gold');
      for (const y of [7, 11, 15]) for (const x of [6, 11, 16]) r(x, y, 2, 2, 'blue');
      break;
    case 'index_medal':
      r(6, 2, 11, 2, 'blue'); r(4, 4, 16, 15); r(6, 5, 12, 12, 'cream');
      r(7, 7, 7, 2, 'blue'); r(7, 11, 7, 2, 'blue'); r(7, 15, 7, 1, 'blue');
      r(17, 6, 5, 3, 'gold'); r(17, 11, 5, 3, 'gold'); r(8, 19, 3, 4, 'coral'); r(14, 19, 3, 4, 'coral');
      break;
    case 'trophy':
      r(5, 2, 14, 3, 'gold'); r(6, 5, 12, 9, 'gold'); r(8, 5, 2, 8, 'cream');
      r(2, 5, 4, 3, 'gold'); r(18, 5, 4, 3, 'gold'); r(2, 8, 3, 5, 'gold'); r(19, 8, 3, 5, 'gold');
      r(4, 12, 3, 3, 'gold'); r(17, 12, 3, 3, 'gold'); r(10, 14, 4, 5, 'blue'); r(6, 20, 12, 3, 'gold');
      break;
  }
  return pixels;
}

/** x/y对齐整数，scale向下取整为正整数；frame交替绘制闪光，未知ID画普通炮弹。 */
export function drawPixelIcon(ctx, id, x, y, scale = 1, frame = 0) {
  const resolved = typeof id === 'string' && ICON_IDS.has(id) ? id : 'normal';
  const unit = Number.isFinite(scale) ? Math.max(1, Math.floor(scale)) : 1;
  const left = Number.isFinite(x) ? Math.round(x) : 0, top = Number.isFinite(y) ? Math.round(y) : 0;
  const blink = Number.isFinite(frame) ? Math.abs(Math.floor(frame)) % 2 : 0;
  if (ctx && typeof ctx.fillRect === 'function') {
    const previous = ctx.fillStyle;
    for (const [px, py, width, height, color] of glyph(resolved, blink)) {
      ctx.fillStyle = color; ctx.fillRect(left + px * unit, top + py * unit, width * unit, height * unit);
    }
    ctx.fillStyle = previous;
  }
  return { id: resolved, width: ICON_SIZE * unit, height: ICON_SIZE * unit };
}

function pattern(size, cells) {
  return Object.freeze({ size, cells: Object.freeze(cells.map(([x, y]) => Object.freeze({ x, y }))) });
}

// 官方事实与游戏效果分开；部署/可见性边界按链接中的版本说明理解。
const SQL_FEATURE = Object.freeze({
  featureTitle: 'SQL条件与批量坐标查询',
  featureDescription: '支持用WHERE、IN和OR组合多行筛选条件，也能与向量、全文和其他标量条件一起组织查询，方便按多个坐标或属性获取所需记录。',
  featureUrl: 'https://github.com/oceanbase/seekdb/blob/master/README.md#-hybrid-search-in-a-single-sql',
});
const HTAP_FEATURE = Object.freeze({
  featureTitle: 'OceanBase HTAP',
  featureDescription: 'HTAP将事务处理与分析放在同一系统。OceanBase以同一套引擎和同一份数据同时支持交易更新、查询和实时分析，减少两套系统间的数据搬运。',
  featureUrl: 'https://oceanbase.github.io/docs/user_manual/operation_and_maintenance/en-US/scenario_best_practices/chapter_03_htap/introduction',
});
const MULTIMODAL_FEATURE = Object.freeze({
  featureTitle: '多模态与统一检索',
  featureDescription: 'seekdb在同一引擎中管理关系、向量、文本、JSON与地理空间等数据，支持全文、向量与关系条件组合查询，便于将不同类型的信息放进统一检索流程。',
  featureUrl: 'https://github.com/oceanbase/seekdb-doc#seekdb-documentation',
});
const ULTIMATE_FEATURE = Object.freeze({
  featureTitle: 'OceanBase分布式扩展',
  featureDescription: 'seekdb在浏览器本地执行范围SQL；OceanBase提供分布式扩展能力。更多坐标可用同一查询中的条件组合表达，展示统一SQL处理范围数据的方式。',
  featureUrl: 'https://docs.seekdb.ai/seekdb/seekdb-overview/#capability-matrix',
});
const FEATURE_INFO = Object.freeze({
  normal: SQL_FEATURE, dual: HTAP_FEATURE,
  radar: Object.freeze({
    featureTitle: '混合检索',
    featureDescription: '把全文匹配、向量相似度和关系条件放在同一条SQL中执行；既能按关键词找记录，也能按特征筛选相近内容，再用任务和时间等条件缩小范围。',
    featureUrl: 'https://docs.seekdb.ai/seekdb/experience-client-server-mode-seekdb-with-SQL/',
  }),
  triple: Object.freeze({
    featureTitle: '嵌入式部署',
    featureDescription: '支持由应用启动并访问本地数据库，通过开发接口管理数据和执行SQL，适合桌面应用、本地开发与边缘场景，也便于将数据能力放在应用附近。',
    featureUrl: 'https://docs.seekdb.ai/seekdb/deploy-embedded-seekdb/',
  }),
  lightweight: Object.freeze({
    featureTitle: '轻量部署',
    featureDescription: '针对本地、边缘和低规格设备优化二进制体积、常驻内存及线程等资源开销，支持轻量部署，便于在有限资源环境中使用SQL、索引与混合检索。',
    featureUrl: 'https://github.com/oceanbase/seekdb/releases/tag/v1.4.0#significant-reduction-in-resource-overhead',
  }),
  fork: Object.freeze({
    featureTitle: '写时复制分支与合并',
    featureDescription: '以写时复制方式从一致性快照创建独立数据分支，各分支可分别读写；再通过比较与合并策略接纳修改，适合隔离试验、并行探索和版本管理。',
    featureUrl: 'https://github.com/oceanbase/seekdb/blob/master/README_CN.md#-写时复制沙箱agent-自由探索',
  }),
  mysql: Object.freeze({
    featureTitle: 'MySQL兼容',
    featureDescription: '兼容MySQL协议并提供熟悉的SQL访问方式，可连接常用客户端和驱动；利用关系表、查询、插入等能力组织数据处理，方便现有生态接入。',
    featureUrl: 'https://github.com/oceanbase/seekdb/blob/master/README.md#-mysql-compatible-acid-embeddable',
  }),
  distributed: MULTIMODAL_FEATURE, distributed_i: MULTIMODAL_FEATURE,
  ultimate: ULTIMATE_FEATURE, distributed_ii: ULTIMATE_FEATURE,
  piercing: Object.freeze({
    featureTitle: '异步向量索引',
    featureDescription: '将主表写入与后台向量索引维护解耦，后台持续消费增量变更并更新索引；通过同步或异步模式及刷新策略，组织持续写入与相似检索的更新过程。',
    featureUrl: 'https://github.com/oceanbase/seekdb/releases/tag/v1.3.0#async-indexes',
  }),
});

export const WEAPON_INFO = Object.freeze(Object.fromEntries([
  { id: 'normal', title: '普通炮弹', description: '选择未攻击过的一格投弹；普通双响回合可选两格。', icon: 'normal' },
  { id: 'radar', title: '混合检索雷达', description: '扫描完整2×2四格，消耗一次行动；不投弹，回波可保留作笔记。', icon: 'radar',
    pattern: pattern(2, [[0, 0], [1, 0], [0, 1], [1, 1]]) },
  { id: 'dual', title: 'HTAP 双响炮', description: '同一次行动选择两个不同坐标投弹，消耗一次双响炮库存。', icon: 'dual' },
  { id: 'triple', title: '嵌入式三联炮', description: '同一次行动选择三个不同坐标投弹，消耗一次三联库存。', icon: 'triple' },
  { id: 'distributed_i', title: '多模态扩展弹', description: '攻击完整4×4范围四角4点；与OceanBase 分布式火力支援共享本关一次弹包。', icon: 'distributed_i',
    pattern: pattern(4, [[0, 0], [3, 0], [0, 3], [3, 3]]) },
  { id: 'piercing', title: '异步向量索引导弹', description: '攻击完整3×3范围五点X，每关一枚，使用独立弹包。', icon: 'piercing',
    pattern: pattern(3, [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]]) },
  { id: 'distributed_ii', title: 'OceanBase 分布式火力支援', description: '攻击完整5×5范围隔格9点；与多模态扩展弹共享本关一次弹包。', icon: 'distributed_ii',
    pattern: pattern(5, [[0, 0], [2, 0], [4, 0], [0, 2], [2, 2], [4, 2], [0, 4], [2, 4], [4, 4]]) },
].map(info => [info.id, Object.freeze({ ...info, ...FEATURE_INFO[info.id] })])));

const medal = (id, title, description, icon = id) => ({ kind: 'medal', id, title, description, icon });
const weapon = id => ({ kind: 'weapon', ...WEAPON_INFO[id] });
const REWARDS = {
  1: [medal('lightweight', '极致轻量', '下一关起可启用轻量舰体：最长舰缩短一格。'), weapon('triple')],
  2: [medal('fork', 'Fork / Merge', FORK_DESCRIPTION),
    { kind: 'skill', id: 'fork', title: '试错机会', description: FORK_DESCRIPTION, icon: 'fork' }],
  3: [medal('mysql', 'MySQL 兼容', '复制敌军的双炮协议，下一关起生效。'),
    { kind: 'skill', id: 'mysql', title: 'MySQL兼容双响炮', description: '每四轮普通攻击可同时选择两格，不与其他武器叠加。', icon: 'dual' }],
  4: [medal('distributed', '分布式扩展', '下一关解锁四角四点的多模态扩展弹。'), weapon('distributed_i')],
  5: [medal('piercing', '异步索引', '下一关解锁独立弹包的异步向量索引导弹（五点X）。', 'index_medal'), weapon('piercing'),
    medal('ultimate', '究极分布式扩展', '下一关解锁OceanBase 分布式火力支援，与多模态扩展弹共享一次弹包。'), weapon('distributed_ii')],
};

/** 返回独立卡片供UI使用；同概念的勋章/技能可同id，界面key请组合kind与id。 */
export function getLevelRewards(level) {
  const id = typeof level === 'number' ? level : level?.id;
  if (!Number.isInteger(id) || id < 1 || id > 6) return [];
  return (REWARDS[id] ?? []).map(card => ({ ...card, ...FEATURE_INFO[card.id],
    ...(card.pattern ? { pattern: { size: card.pattern.size, cells: card.pattern.cells.map(cell => ({ ...cell })) } } : {}) }));
}

/** 仅整理展示副本；旧存档和实际奖励列表仍保持完整。 */
export function getRewardDisplayCards(rewards) {
  const cards = [], identical = new Map(), effects = new Set(), features = new Set();
  for (const reward of rewards) {
    const identity = JSON.stringify([reward.id, reward.description, reward.featureDescription]);
    const previous = identical.get(identity);
    if (previous) {
      if (reward.title !== previous.title) previous.relatedUnlocks.push({kind: reward.kind, title: reward.title});
      continue;
    }
    const card = {...reward, relatedUnlocks: []};
    identical.set(identity, card);
    if (card.description) {
      if (effects.has(card.description)) delete card.description;
      else effects.add(card.description);
    }
    if (card.featureDescription) {
      if (features.has(card.featureDescription)) {
        delete card.featureDescription; delete card.featureTitle; delete card.featureUrl;
      } else features.add(card.featureDescription);
    }
    cards.push(card);
  }
  return cards;
}
