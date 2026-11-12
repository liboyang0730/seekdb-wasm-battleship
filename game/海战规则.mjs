/**
 * 海战的裁判与资料生成规则。舰队对象只供裁判使用，不得写入 intelligence。
 * 本模块不模拟 SQL 结果；buildQuery 只拼查询，由真实 seekdb 执行。
 */
import { generateTacticalClues } from './战术线索.mjs';
export { generateTacticalClues } from './战术线索.mjs';

export const LEVELS = Object.freeze([
  { id: 1, title: '初航 · 静海监听', size: 8, playerShips: [5, 3, 2, 1], enemyShips: [5, 3, 2, 2],
    enemyDoubleEvery: 0, playerDoubleEvery: 0, evidenceEpochEvery: 0,
    radarCharges: 2, dualCharges: 1, tripleCharges: 0, clueLimit: 2, defaultClues: 1, enemyPursuit: 'random',
    reward: 'lightweight', rewardName: '极致轻量',
    briefing: '核对资料时间，查询8×8战场与坐标粗线索；双方普通攻击每轮一发，开局可用雷达和双点炮。极致轻量缩短旗舰一格，还解锁嵌入式三联炮。' },
  { id: 2, title: '迷雾 · 信源甄别', size: 8, playerShips: [5, 3, 2, 1], enemyShips: [5, 4, 2, 2],
    enemyDoubleEvery: 0, playerDoubleEvery: 0, evidenceEpochEvery: 0,
    radarCharges: 2, dualCharges: 1, tripleCharges: 1, clueLimit: 2, defaultClues: 1, enemyPursuit: 'random',
    reward: 'fork', rewardName: 'Fork / Merge',
    briefing: '轻量舰体已启用，双方普通攻击仍每轮一发。结合时间范围与全文检索排除同名干扰；雷达与多点炮均为有限库存。' },
  { id: 3, title: '分支 · 变化的口令', size: 10, playerShips: [5, 4, 4, 3, 2], enemyShips: [5, 4, 4, 3, 2],
    enemyDoubleEvery: 4, playerDoubleEvery: 0, evidenceEpochEvery: 3,
    radarCharges: 3, dualCharges: 2, tripleCharges: 1, clueLimit: 2, defaultClues: 1, enemyPursuit: 'adjacent',
    reward: 'mysql', rewardName: 'MySQL 兼容',
    briefing: '10×10海域增配侦察资源，敌军每四轮双炮，前一轮预告。Fork重开保留敌位与公开笔记，使用后两关冷却，第三关恢复。' },
  { id: 4, title: '混合 · 同名异舰', size: 10, playerShips: [5, 5, 4, 3, 2], enemyShips: [5, 5, 4, 4, 2],
    enemyDoubleEvery: 3, playerDoubleEvery: 4, evidenceEpochEvery: 3,
    radarCharges: 3, dualCharges: 2, tripleCharges: 1, clueLimit: 2, defaultClues: 1, enemyPursuit: 'linear',
    reward: 'distributed', rewardName: '分布式扩展',
    briefing: 'MySQL兼容双响炮复制每四轮双响协议；敌军升级为每三轮双炮并提前一轮预告。混合检索带回固定坐标线索，不返回单舰位置。' },
  { id: 5, title: '扩展 · 旧日回声', size: 12, playerShips: [6, 5, 5, 4, 3, 2], enemyShips: [6, 5, 5, 4, 3, 2, 1],
    enemyDoubleEvery: 3, playerDoubleEvery: 4, evidenceEpochEvery: 3,
    radarCharges: 5, dualCharges: 3, tripleCharges: 2, clueLimit: 3, defaultClues: 1, enemyPursuit: 'linear',
    reward: 'piercing', rewardName: '异步索引', extraRewards: ['ultimate'],
    briefing: '分布式扩展弹参照TARTAR，攻击4×4范围四角4点，每关一次，由真实SQL选格；特殊弹占用整次炮击，不叠加普通双炮。敌方潜艇仅1格，建议预留雷达。' },
  { id: 6, title: '终战 · 双源确认', size: 12, playerShips: [6, 6, 5, 4, 3, 2], enemyShips: [6, 6, 5, 5, 4, 3, 1],
    enemyDoubleEvery: 2, playerDoubleEvery: 4, evidenceEpochEvery: 3,
    radarCharges: 5, dualCharges: 3, tripleCharges: 2, clueLimit: 3, defaultClues: 1, enemyPursuit: 'linear',
    reward: null, rewardName: '战役完成',
    briefing: '终战敌军每两轮双炮并提前一轮预告。究极分布式扩展弹参照TRIDENT D9隔格九点，与分布式扩展弹共享一次弹包；异步索引导弹另有一次HARPOON五点X攻击。敌方潜艇仅1格，建议预留雷达。' },
].map(level => Object.freeze({ ...level, playerShips: Object.freeze(level.playerShips), enemyShips: Object.freeze(level.enemyShips),
  ...(level.extraRewards ? { extraRewards: Object.freeze(level.extraRewards) } : {}) })));

// 保留普通海战的扫格时间；SQL提供战场和固定半盘带，仍需靠公开炮击寻找舰船。
export const ROUND_LIMITS = Object.freeze([48, 48, 70, 70, 96, 100]);

/** 预告只依赖关卡与轮次，不读取布局或受击信息。 */
export function enemyFirePlan(level = 1, round = 1) {
  const definition = typeof level === 'number' ? LEVELS.find(item => item.id === level) : level;
  if (!definition || !Number.isInteger(round) || round < 1) throw new RangeError('关卡或轮次无效');
  const every = definition.enemyDoubleEvery;
  const shots = every && round % every === 0 ? 2 : 1;
  const nextShots = every && (round + 1) % every === 0 ? 2 : 1;
  return { shots, nextShots, warning: nextShots === 2 };
}

export const TACTICAL_FEATURES = Object.freeze([
  '军用特征', '发动机低频', '航速', '舰体尺度', '雷达强度', '热源', '金属回波', '编队规律',
]);

const WARSHIP_VECTOR = Object.freeze([0.96, 0.86, 0.72, 0.78, 0.9, 0.82, 0.93, 0.86]);
const CIVIL_VECTOR = Object.freeze([0.12, 0.42, 0.36, 0.82, 0.28, 0.54, 0.64, 0.08]);
const BUOY_VECTOR = Object.freeze([0.06, 0.04, 0.01, 0.08, 0.45, 0.03, 0.18, 0.02]);
const CALL_SIGNS = ['TERN', 'KITE', 'PETREL', 'GULL', 'HERON', 'KESTREL', 'OSPREY', 'SWIFT'];

function hashSeed(seed) {
  const text = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 返回 [0, 1) 的可复现随机数函数，种子支持数字和字符串。 */
export function createRng(seed = 1) {
  let state = hashSeed(seed);
  return function random() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, rng) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const next = Math.floor(rng() * (index + 1));
    [result[index], result[next]] = [result[next], result[index]];
  }
  return result;
}

const coordinateKey = cell => `${cell.x},${cell.y}`;
const inBounds = (cell, size) => Number.isInteger(cell?.x) && Number.isInteger(cell?.y)
  && cell.x >= 0 && cell.x < size && cell.y >= 0 && cell.y < size;

/** 本作双方明确采用含对角的间距规则；这是用户确认的改编，GBC原作允许邻接。 */
export function createFleet(lengths, { size = 8, seed = 1, lightweight = false, noTouch = true } = {}) {
  if (!Number.isInteger(size) || size < 2 || size > 16 || !Array.isArray(lengths)
    || lengths.length === 0 || lengths.length > size * size
    || lengths.some(length => !Number.isInteger(length) || length < 1 || length > size)) {
    throw new RangeError('舰长或棋盘尺寸无效');
  }
  const rng = createRng(seed);
  const lightIndex = lightweight ? lengths.indexOf(Math.max(...lengths)) : -1;
  const specs = lengths.map((originalLength, index) => ({
    id: `ship-${index + 1}`, originalLength,
    length: index === lightIndex && originalLength > 2 ? originalLength - 1 : originalLength,
    index,
  }));
  const ordered = [...specs].sort((a, b) => b.length - a.length);
  const occupied = [];
  const placed = [];
  let searchSteps = 0;

  function place(depth) {
    if (depth === ordered.length) return true;
    if (searchSteps > 200000) return false;
    const spec = ordered[depth];
    const candidates = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        for (const horizontal of spec.length === 1 ? [true] : [true, false]) {
          const cells = Array.from({ length: spec.length }, (_, offset) => ({
            x: x + (horizontal ? offset : 0), y: y + (horizontal ? 0 : offset),
          }));
          if (cells.every(cell => inBounds(cell, size))) candidates.push(cells);
        }
      }
    }
    for (const cells of shuffled(candidates, rng)) {
      searchSteps += 1;
      const blocked = cells.some(cell => occupied.some(other => noTouch
        ? Math.abs(cell.x - other.x) <= 1 && Math.abs(cell.y - other.y) <= 1
        : cell.x === other.x && cell.y === other.y));
      if (blocked) continue;
      occupied.push(...cells);
      placed.push({ ...spec, cells });
      if (place(depth + 1)) return true;
      placed.pop();
      occupied.splice(occupied.length - cells.length, cells.length);
    }
    return false;
  }
  if (!place(0)) throw new RangeError('当前舰队无法在棋盘中合法部署');

  return {
    size, noTouch,
    ships: placed.sort((a, b) => a.index - b.index).map(({ index, ...spec }) => ({
      ...spec, sunk: false,
      cells: spec.cells.map(cell => ({ ...cell, hp: 1, maxHp: 1 })),
    })),
    shots: {},
  };
}

export const ENEMY_LAYOUT_POOL_SIZE = 128;
export const ENEMY_LAYOUT_POOL_VERSION = 'seekdb-naval-layout-pool-v1';
const enemyLayoutPools = new Map();

/** 每关公开固定阵形池；campaignSeed只选择索引，返回副本防止污染缓存。 */
export function createEnemyFleet({ level = 1, seed = 1 } = {}) {
  const definition = typeof level === 'number' ? LEVELS.find(item => item.id === level) : level;
  if (!definition || !Array.isArray(definition.enemyShips)) throw new RangeError('缺少有效关卡配置');
  const config = `${definition.id}|${definition.size}|${definition.enemyShips.join(',')}`;
  if (!enemyLayoutPools.has(config)) {
    enemyLayoutPools.set(config, Array.from({ length: ENEMY_LAYOUT_POOL_SIZE }, (_, index) => createFleet(definition.enemyShips,
      { size: definition.size, seed: `${ENEMY_LAYOUT_POOL_VERSION}|${config}|${index}` })));
  }
  const layoutIndex = hashSeed(`${seed}|enemy-layout|${definition.id}`) % ENEMY_LAYOUT_POOL_SIZE;
  return { ...JSON.parse(JSON.stringify(enemyLayoutPools.get(config)[layoutIndex])), layoutIndex, layoutPoolSize: ENEMY_LAYOUT_POOL_SIZE };
}

/** 校验人工部署及移动后的舰队；受损舰船的 hp 为零仍是合法布局。 */
export function validateFleet(fleet) {
  const errors = [];
  if (!fleet || !Number.isInteger(fleet.size) || fleet.size < 2 || !Array.isArray(fleet.ships) || !fleet.ships.length) {
    return { ok: false, errors: ['缺少有效的棋盘或舰队'] };
  }
  const occupied = new Map();
  const identifiers = new Set();
  fleet.ships.forEach((ship, index) => {
    if (!ship?.id || identifiers.has(ship.id)) errors.push(`第 ${index + 1} 艘舰编号重复或缺失`);
    identifiers.add(ship?.id);
    if (!Array.isArray(ship?.cells) || !ship.cells.length || ship.cells.length !== ship.length) {
      errors.push(`第 ${index + 1} 艘舰长度不匹配`);
      return;
    }
    const xs = new Set(ship.cells.map(cell => cell.x));
    const ys = new Set(ship.cells.map(cell => cell.y));
    if (xs.size !== 1 && ys.size !== 1) errors.push(`第 ${index + 1} 艘舰必须横放或竖放`);
    const axis = ys.size === 1 ? 'x' : 'y';
    const positions = ship.cells.map(cell => cell[axis]).sort((a, b) => a - b);
    if (positions.some((value, next) => next > 0 && value !== positions[next - 1] + 1)) {
      errors.push(`第 ${index + 1} 艘舰必须连续`);
    }
    ship.cells.forEach(cell => {
      if (!inBounds(cell, fleet.size)) errors.push('舰体越出棋盘');
      if (cell.maxHp !== 1 || !Number.isInteger(cell.hp) || cell.hp < 0 || cell.hp > 1) {
        errors.push('舰体血量无效');
      }
      const key = coordinateKey(cell);
      if (occupied.has(key)) errors.push(`${String.fromCharCode(65+cell.x)}${cell.y+1}：第${index+1}艘舰与第${occupied.get(key)+1}艘舰重叠`);
      occupied.set(key, index);
    });
    if (ship.cells.reduce((sum, cell) => sum + cell.maxHp, 0) !== ship.length) errors.push('舰体总血量与实际舰长不符');
  });
  if (fleet.noTouch !== false) {
    for (const [key, shipIndex] of occupied) {
      const [x, y] = key.split(',').map(Number);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const other = occupied.get(`${x + dx},${y + dy}`);
          if (other !== undefined && other !== shipIndex) errors.push(`${String.fromCharCode(65+x)}${y+1} 与 ${String.fromCharCode(65+x+dx)}${y+dy+1} 的不同舰船${dx&&dy?'斜角':'边缘'}接壤`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/** 部署提示只标其他固定舰周围的空格，不把选中舰自身或舰体涂成禁放格。 */
export function placementBlockedCells(fleet, movingShipIndex=0) {
  if(!fleet?.ships || fleet.noTouch===false)return [];
  const occupied=new Set(fleet.ships.flatMap(ship=>ship.cells.map(coordinateKey))),blocked=new Map();
  fleet.ships.forEach((ship,index)=>{
    if(index===movingShipIndex)return;
    for(const cell of ship.cells)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const next={x:cell.x+dx,y:cell.y+dy};
      if(inBounds(next,fleet.size)&&!occupied.has(coordinateKey(next)))blocked.set(coordinateKey(next),next);
    }
  });
  return [...blocked.values()];
}

/** 每格一击，命中和落空都记入攻击史；同关禁止再次投弹。 */
export function applyShot(fleet, target) {
  if (!inBounds(target, fleet.size)) return { valid: false, error: '炮击坐标必须是棋盘内整数格', ...target };
  const key = coordinateKey(target);
  const ship = fleet.ships.find(candidate => candidate.cells.some(cell => coordinateKey(cell) === key));
  const cell = ship?.cells.find(candidate => coordinateKey(candidate) === key);
  if (fleet.shots[key] || (cell && cell.hp === 0)) {
    return { valid: false, error: '该格本关已经投过弹，请选择未攻击坐标', ...target };
  }
  if (cell) cell.hp -= 1;
  const sunk = Boolean(ship && ship.cells.every(part => part.hp === 0));
  if (sunk) ship.sunk = true;
  const remainingHp = fleet.ships.reduce((total, candidate) => total + candidate.cells.reduce((sum, part) => sum + part.hp, 0), 0);
  const result = {
    valid: true, x: target.x, y: target.y, kind: cell ? (sunk ? 'sunk' : 'hit') : 'miss',
    cellCleared: !cell || cell.hp === 0, cellHp: cell?.hp ?? 0,
    shipId: sunk ? ship.id : null,
    sunkCells: sunk ? ship.cells.map(part => ({ x: part.x, y: part.y })) : [],
    remainingHp, defeated: remainingHp === 0,
  };
  fleet.shots[key] = { ...result, attempts: (fleet.shots[key]?.attempts ?? 0) + 1 };
  return result;
}

/** 双炮与特殊弹都用此函数先校验整次齐射，再逐格结算。 */
export function validateSalvo(targets, maxShots, size = 8) {
  const errors = [];
  if (!Array.isArray(targets) || targets.length === 0 || !Number.isInteger(maxShots) || maxShots < 1 || targets.length > maxShots) {
    errors.push('齐射数量不合法');
  } else {
    if (targets.some(cell => !inBounds(cell, size))) errors.push('齐射坐标越界或不是整数');
    if (new Set(targets.map(coordinateKey)).size !== targets.length) errors.push('同一次齐射不能重复攻击同一格');
  }
  return { ok: errors.length === 0, errors };
}

/** history 接受 knowledge.shots/fleet.shots 字典、坐标数组或坐标键Set。 */
export function validateNewBombs(cells, history = {}, size = 8) {
  const result = validateSalvo(cells, Array.isArray(cells) ? Math.max(1, cells.length) : 1, size);
  if (!result.ok) return result;
  const keys = history instanceof Set ? history : Array.isArray(history)
    ? new Set(history.map(item => typeof item === 'string' ? item : coordinateKey(item)))
    : new Set(Object.keys(history.shots ?? history));
  if (cells.some(cell => keys.has(coordinateKey(cell)))) result.errors.push('范围内含本关已经投过弹的坐标');
  return { ok: result.errors.length === 0, errors: result.errors };
}

/** 原作多点模板；I的偶数4×4范围以中间四格左上格为锚点，边缘裁剪，不使用方向参数。 */
export function weaponPattern(kind, anchor, size = 8) {
  if (!Number.isInteger(size) || size < 2 || !inBounds(anchor, size)) throw new RangeError('武器中心必须位于棋盘内');
  let offsets;
  if (kind === 'distributed_i') offsets = [-1, 2].flatMap(dy => [-1, 2].map(dx => [dx, dy]));
  else if (kind === 'distributed' || kind === 'distributed_ii') offsets = [-2, 0, 2].flatMap(dy => [-2, 0, 2].map(dx => [dx, dy]));
  else if (kind === 'piercing') offsets = [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]];
  else throw new RangeError('未知的特殊武器类型');
  return offsets.map(([dx, dy]) => ({ x: anchor.x + dx, y: anchor.y + dy })).filter(cell => inBounds(cell, size));
}

/** 正式多点武器以完整外框左上角为锚点；放不下返回[]，不裁剪图案。 */
export function weaponPatternAtAnchor(kind, anchor, size = 8) {
  const shape = kind === 'distributed_i' ? { span: 4, offset: 1 }
    : kind === 'distributed_ii' || kind === 'distributed' ? { span: 5, offset: 2 }
      : kind === 'piercing' ? { span: 3, offset: 1 } : null;
  if (!shape) throw new RangeError('未知的特殊武器类型');
  if (!Number.isInteger(size) || size < 2) throw new RangeError('棋盘尺寸无效');
  if (!inBounds(anchor, size) || anchor.x + shape.span > size || anchor.y + shape.span > size) return [];
  return weaponPattern(kind, { x: anchor.x + shape.offset, y: anchor.y + shape.offset }, size);
}

export function createKnowledge(size = 8) {
  return { size, shots: {}, sunkShips: [] };
}

/** 只保存炮击公开回执，不接受敌舰布局。 */
export function recordShot(knowledge, result) {
  if (!result?.valid) return knowledge;
  const key = coordinateKey(result);
  knowledge.shots[key] = {
    x: result.x, y: result.y,
    state: result.kind === 'miss' ? 'miss' : result.kind === 'sunk' ? 'sunk' : result.cellCleared ? 'hit' : 'damaged',
    cellCleared: result.cellCleared,
    attempts: (knowledge.shots[key]?.attempts ?? 0) + 1,
  };
  if (result.kind === 'sunk') {
    const cells = result.sunkCells.map(cell => ({ x: cell.x, y: cell.y }));
    if (!knowledge.sunkShips.some(ship => ship.id === result.shipId)) knowledge.sunkShips.push({ id: result.shipId, cells });
    for (const cell of cells) {
      const previous = knowledge.shots[coordinateKey(cell)];
      knowledge.shots[coordinateKey(cell)] = { ...previous, ...cell, state: 'sunk', cellCleared: true };
    }
  }
  return knowledge;
}

/**
 * AI 的全部输入只有公开炮击知识：沿命中线追击，最后随机搜索；不重复投弹。
 * 一次齐射的全部目标在任何回执出现前决定，双炮不能偷看第一炮结果。
 */
export function chooseEnemyShots(knowledge, count = 1, rng = createRng(1), { pursuit = 'linear' } = {}) {
  const { size, shots } = knowledge;
  const limit = Number.isInteger(count) && count > 0 ? count : 0;
  const available = cell => inBounds(cell, size) && !shots[coordinateKey(cell)];
  const selected = [];
  const selectedKeys = new Set();
  const append = cells => {
    for (const cell of cells) {
      const clean = { x: cell.x, y: cell.y };
      const key = coordinateKey(clean);
      if (selected.length < limit && available(clean) && !selectedKeys.has(key)) {
        selected.push(clean);
        selectedKeys.add(key);
      }
    }
  };
  const hits = pursuit === 'random' ? [] : Object.values(shots).filter(shot => shot.state === 'hit' || shot.state === 'damaged');

  const linear = [];
  for (let first = 0; pursuit === 'linear' && first < hits.length; first += 1) {
    for (let second = first + 1; second < hits.length; second += 1) {
      const a = hits[first];
      const b = hits[second];
      if (a.y === b.y && Math.abs(a.x - b.x) === 1) {
        linear.push({ x: Math.min(a.x, b.x) - 1, y: a.y }, { x: Math.max(a.x, b.x) + 1, y: a.y });
      }
      if (a.x === b.x && Math.abs(a.y - b.y) === 1) {
        linear.push({ x: a.x, y: Math.min(a.y, b.y) - 1 }, { x: a.x, y: Math.max(a.y, b.y) + 1 });
      }
    }
  }
  append(shuffled(linear, rng));
  const adjacent = hits.flatMap(cell => [
    { x: cell.x - 1, y: cell.y }, { x: cell.x + 1, y: cell.y },
    { x: cell.x, y: cell.y - 1 }, { x: cell.x, y: cell.y + 1 },
  ]);
  append(shuffled(adjacent, rng));
  const sea = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) sea.push({ x, y });
  }
  append(shuffled(sea, rng));
  return selected;
}

/** 全球海域由4×4个交战窗口构成，步长为半盘；舰队仍使用真实窗口内local坐标。 */
export function sectorBounds(sector, windowSize) {
  if (!/^S(?:[1-9]|1[0-6])$/.test(sector) || !Number.isInteger(windowSize) || windowSize < 2 || windowSize > 16 || windowSize % 2 !== 0) {
    throw new RangeError('交战窗口编号或尺寸无效');
  }
  const index = Number(sector.slice(1)) - 1;
  const minX = index % 4 * windowSize / 2;
  const minY = Math.floor(index / 4) * windowSize / 2;
  return { minX, minY, maxX: minX + windowSize - 1, maxY: minY + windowSize - 1, width: windowSize, height: windowSize };
}

/** 偏离半盘时0.55，偏离一整盘及以上为0；中间采用连续分段线性衰减。 */
export function targetingAccuracy(selectedBounds, targetBounds) {
  const centerX = bounds => (bounds.minX + bounds.maxX) / 2;
  const centerY = bounds => (bounds.minY + bounds.maxY) / 2;
  const deviation = Math.max(Math.abs(centerX(selectedBounds) - centerX(targetBounds)) / targetBounds.width,
    Math.abs(centerY(selectedBounds) - centerY(targetBounds)) / targetBounds.height);
  if (deviation >= 1) return 0;
  return deviation <= 0.5 ? 1 - 0.9 * deviation : 1.1 * (1 - deviation);
}

/** 打偏不等于落空，调用方不可把drift写成已排除格；准确选区不额外消耗随机数。 */
export function resolveAim({ selectedBounds, targetBounds, cell, rng }) {
  if (!Number.isInteger(cell?.x) || !Number.isInteger(cell?.y) || cell.x < 0 || cell.y < 0
    || cell.x >= selectedBounds.width || cell.y >= selectedBounds.height) throw new RangeError('瞄准格必须位于所选交战窗口内');
  const accuracy = targetingAccuracy(selectedBounds, targetBounds);
  if (accuracy === 0) return { drift: true, target: null, accuracy };
  if (accuracy < 1) {
    if (typeof rng !== 'function') throw new TypeError('偏区瞄准必须提供可复现随机数函数');
    if (rng() >= accuracy) return { drift: true, target: null, accuracy };
  }
  const x = selectedBounds.minX + cell.x - targetBounds.minX;
  const y = selectedBounds.minY + cell.y - targetBounds.minY;
  const target = x >= 0 && x < targetBounds.width && y >= 0 && y < targetBounds.height ? { x, y } : null;
  return { drift: false, target, accuracy };
}

/** 只根据数据库实际返回cells计算边界；空集、缺格、重复格或非法坐标返回null。 */
export function boundsFromCells(input) {
  let cells;
  try { cells = typeof input === 'string' ? JSON.parse(input) : input; } catch { return null; }
  if (!Array.isArray(cells) || !cells.length || cells.some(cell => !Number.isInteger(cell?.x) || !Number.isInteger(cell?.y) || cell.x < 0 || cell.y < 0)) return null;
  const minX = Math.min(...cells.map(cell => cell.x));
  const maxX = Math.max(...cells.map(cell => cell.x));
  const minY = Math.min(...cells.map(cell => cell.y));
  const maxY = Math.max(...cells.map(cell => cell.y));
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (width * height !== cells.length || new Set(cells.map(coordinateKey)).size !== cells.length) return null;
  return { minX, minY, maxX, maxY, width, height };
}

function sectorCells(sector, windowSize) {
  const bounds = sectorBounds(sector, windowSize);
  return Array.from({ length: windowSize * windowSize }, (_, offset) => ({
    x: bounds.minX + offset % windowSize, y: bounds.minY + Math.floor(offset / windowSize),
  }));
}

const BAND_TYPES = ['west', 'east', 'north', 'south'];
function inHalfBand(cell, type, size) {
  return type === 'west' ? cell.x < size / 2 : type === 'east' ? cell.x >= size / 2
    : type === 'north' ? cell.y < size / 2 : cell.y >= size / 2;
}

/**
 * 资料只记录完整交战窗口。目标窗口由seed与关卡确定，不能随轮次、命中或舰损变化。
 * signature 是人工定义的八维战术特征，不是通用语言模型的语义嵌入。
 * truth 仅供生成质量检查；不要将 truth、fleet 或 ships 插入 intelligence。
 */
export function generateEvidence({ fleet, level = 1, round = 1, seed = 1 } = {}) {
  const definition = typeof level === 'number' ? LEVELS.find(item => item.id === level) : level;
  if (!definition || !Number.isInteger(round) || round < 1) throw new RangeError('关卡或回合无效');
  if (fleet?.size !== definition.size || !Array.isArray(fleet.ships) || !fleet.ships.length) throw new RangeError('裁判舰队尺寸必须与本关交战窗口一致');
  const windowSize = definition.size;
  const worldSize = windowSize + windowSize / 2 * 3;
  const phase = definition.evidenceEpochEvery ? Math.floor((round - 1) / definition.evidenceEpochEvery) + 1 : 1;
  const rng = createRng(`${seed}|evidence|${definition.id}|${phase}|${round}`);
  const missionId = `mission-${definition.id}-${hashSeed(seed).toString(16)}`;
  const oldMission = `${missionId}-old`;
  const windowRng = createRng(`${seed}|combat-window|${definition.id}`);
  const targetSector = `S${1 + Math.floor(windowRng() * 16)}`;
  // 用开局完整舰体采样一次；不能根据剩余HP或轮次追踪目标、持续缩窄活动带。
  const clueSeed = `${seed}|tactical-clues|${definition.id}`;
  const trueClues = generateTacticalClues({ fleet, level: definition, seed: clueSeed });
  const targetBand = BAND_TYPES.find(type => trueClues[0].cells.every(cell => inHalfBand(cell, type, windowSize)));
  const cluesBySector = new Map([[targetSector, trueClues]]);
  const emptySectors = shuffled(Array.from({ length: 16 }, (_, index) => `S${index + 1}`)
    .filter(sector => sector !== targetSector), rng);
  const falseSector = index => emptySectors[index % emptySectors.length] ?? `S${((Number(targetSector.slice(1)) + index) % 16) + 1}`;
  const callSign = CALL_SIGNS[(hashSeed(seed) + definition.id + phase) % CALL_SIGNS.length];
  const rows = [];
  const prefix = `l${definition.id}-r${round}`;

  function observation({ label, sector = targetSector, source = '岸基观察站', confidence = 92,
    observedRound = round, mission = missionId, shipClass = 'warship', callsign = callSign,
    vector = WARSHIP_VECTOR, text = '截获军用发动机和编队回波。' }) {
    const signature = vector.map(value => Number(Math.max(0, Math.min(1, value + (rng() - 0.5) * 0.04)).toFixed(4)));
    if (!cluesBySector.has(sector)) {
      const synthetic = createFleet(definition.enemyShips, { size: windowSize, seed: `${clueSeed}|synthetic|${sector}` });
      cluesBySector.set(sector, generateTacticalClues({ fleet: synthetic, level: definition, seed: `${clueSeed}|${sector}` }));
    }
    const bounds = sectorBounds(sector, windowSize);
    const clues = cluesBySector.get(sector).map(clue => ({ ...clue,
      ...(clue.cells ? { cells: clue.cells.map(cell => ({ x: cell.x + bounds.minX, y: cell.y + bounds.minY })) } : {}) }));
    const tacticalHint = clues[0].text;
    rows.push({ id: `${prefix}-${label}`, sector_id: sector, cells: JSON.stringify(sectorCells(sector, windowSize)),
      tactical_cells: JSON.stringify(clues[0].cells), tactical_hint: tacticalHint, tactical_clues: JSON.stringify(clues),
      body: `${source} REPORT ${callsign} : 全海域${worldSize}×${worldSize}，登记${windowSize}×${windowSize}战场与开局固定粗线索，不提供单舰格。${text}`, source, confidence,
      observed_round: observedRound, mission_id: mission, ship_class: shipClass,
      call_sign: callsign, signature, embedding: [...signature] });
  }
  observation({ label: 'coast', confidence: 94, text: `第 ${phase} 版口令确认，低频发动机与军用编队特征吻合。` });
  observation({ label: 'radar', source: '舰载雷达站', confidence: 93, text: '另一独立站点观测到同类目标，位置只精确到大致海区。' });
  // 干扰按能力逐关激活：范围、全文、向量、条件。尚未教学的干扰归入第0轮档案。
  // 旧任务、过期、民船均给双源记录，防止终关的双源条件替代其他检索能力。
  for (const [source, suffix, confidence] of [['岸基观察站', 'coast', 93], ['舰载雷达站', 'radar', 92]]) {
    observation({ label: suffix === 'coast' ? 'old' : 'archive-echo', sector: falseSector(1),
      source, confidence, mission: oldMission, observedRound: definition.id >= 4 ? round : 0,
      text: '上一次任务的同代号军用回波；观察轮次与任务编号都应核对，第0轮是出航前档案。' });
    observation({ label: suffix === 'coast' ? 'expired' : 'expired-radar', sector: falseSector(2),
      source, confidence, observedRound: Math.max(0, round - 4), text: '本任务的同代号旧时段监听，已超出当前有效时间窗。' });
    observation({ label: suffix === 'radar' ? 'civil' : 'civil-coast', sector: falseSector(3),
      source, confidence, shipClass: 'merchant', vector: CIVIL_VECTOR, observedRound: definition.id >= 3 ? round : 0,
      text: '相同代号，但低频和编队规律符合民船；第0轮属档案，当前轮次记录应比较战术特征。' });
    for (const [tag, sectorOffset] of [['a', 4], ['b', 5]]) {
      observation({ label: `other-${tag}-${suffix}`, sector: falseSector(sectorOffset),
        source, confidence, callsign: tag === 'a' ? 'SCOUTA' : 'SCOUTB', observedRound: definition.id >= 2 ? round : 0,
        text: '军用回波与任务一致，但编队口令不同；第0轮是档案，当前记录需要全文代号匹配。' });
    }
  }
  observation({ label: 'rumor', sector: falseSector(0), source: 'RUMOR', confidence: 96, observedRound: definition.id >= 4 ? round : 0,
    text: '港口转述本任务的同代号军用回波，自报可信度很高，却没有独立站点确认。' });
  observation({ label: 'rumor-repeat', sector: falseSector(0), source: 'RUMOR', confidence: 95, observedRound: definition.id >= 4 ? round : 0,
    text: '另一份转载仍来自同一个传闻来源，不能把转载次数当作独立信源。' });
  observation({ label: 'weather', sector: falseSector(6), source: '舰载雷达站', confidence: 98, observedRound: 0,
    shipClass: 'buoy', vector: BUOY_VECTOR, callsign: 'WEATHER', text: '气象浮标记录真实，但不能用于寻找敌舰。' });
  if (definition.id >= 6) {
    observation({ label: 'single-source', sector: falseSector(6), source: '岸基观察站', confidence: 94,
      text: '单站异常回波；信源身份有效，但尚无第二个独立来源复核。' });
  }
  const rangeStart = Math.max(1, round - 2);
  const title = (intro, neutral) => definition.id === 1 ? intro : neutral;
  const cards = [
    { id: `${prefix}-keyword`, kind: 'keyword', title: title('当前作战口令', '监听摘录 A'),
      body: `本轮作战通知：军舰使用英文代号 ${callSign}。全文检索应保留完整代号。`, payload: { keyword: callSign } },
    { id: `${prefix}-civil-keyword`, kind: 'keyword', title: title('渡轮时刻表', '监听摘录 B'),
      body: '港内渡轮代号 FERRY，资料真实，是否与本次找舰有关需要判断。', payload: { keyword: 'FERRY' } },
    { id: `${prefix}-vector`, kind: 'vector', title: title('军用回波特征', '声纹样本 A'),
      body: '参考军舰的发动机低频、航速、金属回波和编队规律，共八维人工战术特征。', payload: { vector: [...WARSHIP_VECTOR] } },
    { id: `${prefix}-civil-vector`, kind: 'vector', title: title('民船回波手册', '声纹样本 B'),
      body: '商船舰体较大，但军用特征与编队规律较弱；这是民船参考向量。', payload: { vector: [...CIVIL_VECTOR] } },
    { id: `${prefix}-filter`, kind: 'filter', title: title('当前任务与信源', '任务附件 A'),
      body: `当前任务 ${missionId}；采用 岸基观察站 / 舰载雷达站 独立站点，可信度至少 85${definition.id >= 6 ? '，同海区至少两个来源' : ''}。`,
      payload: { missionId, minConfidence: 85, sources: ['岸基观察站', '舰载雷达站'], minSources: definition.id >= 6 ? 2 : 1 } },
    { id: `${prefix}-old-filter`, kind: 'filter', title: title('历史任务封面', '任务附件 B'),
      body: `档案任务 ${oldMission}，记录有签名，但属于上一次行动。`,
      payload: { missionId: oldMission, minConfidence: 85, sources: ['岸基观察站', '舰载雷达站'], minSources: 1 } },
    { id: `${prefix}-range`, kind: 'range', title: title('本轮有效时间窗', '时间附件 A'),
      body: `本轮为第 ${round} 轮，采用第 ${rangeStart}～${round} 轮监听；第0轮是档案。查询同时返回战场和固定坐标粗线索。`,
      payload: { minRound: rangeStart, maxRound: round } },
    { id: `${prefix}-old-range`, kind: 'range', title: title('旧版监听时间窗', '时间附件 B'),
      body: `旧版资料时间窗为第 0～${Math.max(0, round - 3)} 轮，注意它与当前时间窗的差异。`,
      payload: { minRound: 0, maxRound: Math.max(0, round - 3) } },
    { id: `${prefix}-rumor-filter`, kind: 'filter', title: title('港口传闻摘录', '转述附件'),
      body: 'RUMOR 没有独立确认，仅按自报可信度收集，可能存在错误海区。',
      payload: { missionId, minConfidence: 40, sources: ['RUMOR'], minSources: 1 } },
    { id: `${prefix}-weather-keyword`, kind: 'keyword', title: title('气象站日志', '监听摘录 C'),
      body: 'WEATHER 是气象浮标代号。日志可靠，但它的回波不代表军舰。', payload: { keyword: 'WEATHER' } },
  ];
  return { cards: shuffled(cards, rng), rows: shuffled(rows, rng), missionId, phase, windowSize, worldSize, tacticalCount: windowSize * windowSize / 2,
    callSign, featureNames: [...TACTICAL_FEATURES],
    truth: { targetSector, targetBounds: sectorBounds(targetSector, windowSize), targetBand, reliableRowIds: [`${prefix}-coast`, `${prefix}-radar`] } };
}

function sqlLiteral(value) {
  // 同时兼容 MySQL 字符串的反斜杠转义与标准单引号转义。
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''").replaceAll('\0', '')}'`;
}

/** 按选中的资料卡构造可直接执行的 seekdb SQL；不访问裁判舰位。 */
export function buildQuery({ selectedCards = [], abilities = [], missionId = '', round = 1 } = {}) {
  const invalid = error => ({ sql: '', description: '', valid: false, error, keyword: null, vector: null });
  if (!Array.isArray(selectedCards) || !Array.isArray(abilities)) return invalid('资料卡或检索能力格式不正确');
  const abilityKinds = { fulltext: 'keyword', vector: 'vector', filter: 'filter', range: 'range' };
  if (abilities.length === 0 || abilities.some(ability => !abilityKinds[ability])) return invalid('至少选择一种有效检索能力');
  if (new Set(abilities).size !== abilities.length) return invalid('检索能力不能重复');
  const payloads = {};
  for (const ability of abilities) {
    const matches = selectedCards.filter(card => card?.kind === abilityKinds[ability]);
    if (matches.length !== 1) return invalid(matches.length ? `同类资料只能选择一张：${abilityKinds[ability]}` : `缺少与${ability}匹配的资料卡`);
    payloads[ability] = matches[0].payload ?? {};
  }
  if (selectedCards.some(card => !abilities.some(ability => abilityKinds[ability] === card?.kind))) {
    return invalid('选中的资料没有配套能力，请移除资料或补上对应能力');
  }
  const conditions = [];
  const descriptions = [];
  let keyword = null;
  let vector = null;
  let distance = '';
  let minSources = 1;
  if (payloads.fulltext) {
    keyword = payloads.fulltext.keyword;
    if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 100) return invalid('全文资料缺少有效英文代号');
    conditions.push(`MATCH(body) AGAINST (${sqlLiteral(keyword)} IN NATURAL LANGUAGE MODE)`);
    descriptions.push(`全文检索代号 ${keyword}`);
  }
  if (payloads.vector) {
    vector = payloads.vector.vector;
    if (!Array.isArray(vector) || vector.length !== 8 || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      return invalid('战术特征必须是八维有限数值向量');
    }
    vector = [...vector];
    const vectorLiteral = sqlLiteral(JSON.stringify(vector));
    distance = `l2_distance(embedding, ${vectorLiteral})`;
    conditions.push(`${distance} <= 0.42`);
    descriptions.push('八维战术特征的 L2 距离不超过 0.42');
  }
  if (payloads.filter) {
    const filter = payloads.filter;
    const mission = filter.missionId ?? missionId;
    if (typeof mission !== 'string' || !mission || !Number.isFinite(filter.minConfidence)
      || filter.minConfidence < 0 || filter.minConfidence > 100 || !Array.isArray(filter.sources)
      || !filter.sources.length || filter.sources.some(source => typeof source !== 'string' || !source)) {
      return invalid('条件资料缺少任务编号、可信度或信源');
    }
    minSources = filter.minSources ?? 1;
    if (!Number.isInteger(minSources) || minSources < 1 || minSources > filter.sources.length) return invalid('独立来源数量不合法');
    conditions.push(`mission_id = ${sqlLiteral(mission)}`);
    conditions.push(`confidence >= ${filter.minConfidence}`);
    conditions.push(`source IN (${filter.sources.map(sqlLiteral).join(', ')})`);
    descriptions.push(`筛选任务 ${mission}、可靠信源与可信度`);
  }
  if (payloads.range) {
    const { minRound, maxRound } = payloads.range;
    if (!Number.isInteger(minRound) || !Number.isInteger(maxRound) || minRound < 0 || maxRound < minRound || maxRound > 100000) {
      return invalid('时间范围必须是有效回合区间');
    }
    conditions.push(`observed_round BETWEEN ${minRound} AND ${maxRound}`);
    descriptions.push(`时间窗为第 ${minRound}～${maxRound} 轮`);
  }
  const baseWhere = conditions.join('\n  AND ');
  if (minSources > 1) {
    conditions.push(`sector_id IN (\n    SELECT sector_id FROM intelligence\n    WHERE ${baseWhere}\n    GROUP BY sector_id\n    HAVING COUNT(DISTINCT source) >= ${minSources}\n  )`);
    descriptions.push(`同海区至少 ${minSources} 个独立来源`);
  }
  const fields = 'id, sector_id, cells, body, source, confidence, observed_round, tactical_cells, tactical_hint, tactical_clues, fleet_manifest, map_x, map_y, enemy_fire_every, detail_keyword';
  const sql = `SELECT ${fields}${distance ? `, ${distance} AS distance` : ''}\nFROM intelligence\nWHERE ${conditions.join('\n  AND ')}\nORDER BY ${distance ? 'distance ASC, ' : ''}confidence DESC, id ASC\nLIMIT 8;`;
  return { sql, description: `${descriptions.join('；')}。返回完整战场与开局舰格分布统计，不返回单舰坐标。`, valid: true, error: null, keyword, vector };
}
