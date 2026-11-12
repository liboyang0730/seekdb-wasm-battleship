/** 开局粗情报。只使用舰体几何，不读取血量、受击记录或轮次。 */
function fixedIndex(seed, label, count) {
  let hash = 2166136261;
  for (const char of `${seed}|${label}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % count;
}

const column = value => String.fromCharCode(65 + value);
const key = cell => `${cell.x},${cell.y}`;
export const TACTICAL_CLUE_KINDS = Object.freeze(['dense_half', 'full_ship_band', 'empty_patch',
  'ship_orientation', 'ship_crossline', 'submarine_region']);
export function isTacticalClueKind(kind) { return TACTICAL_CLUE_KINDS.includes(kind); }

function strip(size, axis, start, width) {
  return Array.from({ length: size * size }, (_, index) => ({ x: index % size, y: Math.floor(index / size) }))
    .filter(cell => cell[axis] >= start && cell[axis] < start + width);
}

function stripName(axis, start, width) {
  return axis === 'x' ? `${column(start)}～${column(start + width - 1)}列` : `${start + 1}～${start + width}行`;
}

/** cells 使用战术棋盘的0起点坐标；写入SQL观测前，由调用者平移为globalXY。 */
export function generateTacticalClues({ fleet, level = 1, seed = 1 } = {}) {
  const size = fleet?.size;
  if (!Number.isInteger(size) || size < 4 || size % 2 || !fleet.ships?.length) throw new RangeError('战术线索需要偶数棋盘和完整开局舰队');
  const ships = fleet.ships.map(ship => ship.cells.map(cell => ({ x: cell.x, y: cell.y })));
  const occupied = ships.flat();
  if (occupied.some(cell => !Number.isInteger(cell.x) || !Number.isInteger(cell.y) || cell.x < 0 || cell.y < 0 || cell.x >= size || cell.y >= size)) throw new RangeError('舰队坐标越界');
  const limit = Math.min(size >= 12 ? 3 : 2, typeof level === 'object' ? level.clueLimit ?? 3 : 3);
  const halves = ['x', 'y'].flatMap(axis => [0, size / 2].map(start => {
    const cells = strip(size, axis, start, size / 2);
    const keys = new Set(cells.map(key));
    return { axis, start, cells, count: occupied.filter(cell => keys.has(key(cell))).length };
  }));
  const max = Math.max(...halves.map(half => half.count));
  const denseChoices = halves.filter(half => half.count === max);
  const dense = denseChoices[fixedIndex(seed, 'dense-half', denseChoices.length)];
  const basis = { axis: dense.axis, area: stripName(dense.axis, dense.start, size / 2),
    oppositeArea: stripName(dense.axis, dense.start === 0 ? size / 2 : 0, size / 2),
    count: dense.count, oppositeCount: occupied.length - dense.count, asOf: '开局' };
  const statistics = basis.count === basis.oppositeCount
    ? `开局统计：${basis.area}和${basis.oppositeArea}各有${basis.count}个舰格。`
    : `开局统计：${basis.area}有${basis.count}个舰格，${basis.oppositeArea}有${basis.oppositeCount}个舰格。`;
  const clues = [{ id: 'dense-half', kind: 'dense_half',
    text: statistics, cells: dense.cells, basis }];
  if (limit <= 1) return clues;

  const levelId = typeof level === 'number' ? level : level.id;
  const occupiedKeys = new Set(occupied.map(key));
  function fullBand(fallback = false) {
    const bands = [];
    for (const axis of ['x', 'y']) for (let start = 0; start <= size / 2; start += 1) {
      const cells = strip(size, axis, start, size / 2), keys = new Set(cells.map(key));
      if (ships.some(ship => ship.every(cell => keys.has(key(cell))))) bands.push({ axis, start, cells });
    }
    const different = bands.filter(band => band.axis !== dense.axis || band.start !== dense.start);
    const choices = different.length ? different : bands;
    if (!choices.length) return null;
    const band = choices[fixedIndex(seed, 'full-ship-band', choices.length)];
    return { id: 'full-ship-band', kind: 'full_ship_band',
      text: `开局观测：${stripName(band.axis, band.start, size / 2)}内至少有一艘完整舰。`, cells: band.cells,
      ...(fallback ? { proof: { asOf: '开局', fallback: true } } : {}) };
  }
  function emptyPatch(span, preferred = []) {
    const preferredKeys = new Set(preferred.map(key)), patches = [];
    for (let y = 0; y <= size - span; y += 1) for (let x = 0; x <= size - span; x += 1) {
      const cells = Array.from({ length: span * span }, (_, i) => ({ x: x + i % span, y: y + Math.floor(i / span) }));
      if (cells.every(cell => !occupiedKeys.has(key(cell)))) {
        patches.push({ x, y, cells, overlap: cells.filter(cell => preferredKeys.has(key(cell))).length });
      }
    }
    if (!patches.length) return null;
    const maxOverlap = Math.max(...patches.map(patch => patch.overlap));
    const choices = patches.filter(patch => patch.overlap === maxOverlap);
    const patch = choices[fixedIndex(seed, `empty-patch-${span}`, choices.length)];
    return { id: `empty-patch-${span}`, kind: 'empty_patch',
      text: `开局观测：${column(patch.x)}～${column(patch.x + span - 1)}列、${patch.y + 1}～${patch.y + span}行的${span}×${span}区域全部是空海，可以排除。`,
      cells: patch.cells, proof: { asOf: '开局', span, emptyCellCount: patch.cells.length, fallback: false } };
  }
  function orientation() {
    const length = Math.max(...ships.map(ship => ship.length));
    const longest = ships.filter(ship => ship.length === length);
    const ship = longest[fixedIndex(seed, 'longest-orientation', longest.length)];
    const horizontal = length === 1 || ship[0].y === ship[1].y;
    return { id: 'longest-orientation', kind: 'ship_orientation',
      text: `开局观测：最长舰为${length}格，其中至少一艘${horizontal ? '横向' : '竖向'}布置，位置未明。`,
      proof: { asOf: '开局', length, orientation: horizontal ? 'horizontal' : 'vertical',
        candidatePlacementCount: size * (size - length + 1), quantifier: 'at_least_one' } };
  }
  function crossline() {
    const lengths = [...new Set(ships.filter(ship => ship.length >= 4).map(ship => ship.length))];
    const choices = [];
    for (const axis of ['x', 'y']) for (let boundary = 1; boundary < size; boundary += 1) {
      const crosses = ship => Math.min(...ship.map(cell => cell[axis])) < boundary && Math.max(...ship.map(cell => cell[axis])) >= boundary;
      if (!ships.some(ship => ship.length >= 4 && crosses(ship))) continue;
      const candidates = new Map(); let placements = 0;
      for (const length of lengths) for (let line = 0; line < size; line += 1) for (let start = 0; start <= size - length; start += 1) {
        const cells = Array.from({ length }, (_, i) => axis === 'x' ? { x: start + i, y: line } : { x: line, y: start + i });
        if (crosses(cells)) { placements += 1; for (const cell of cells) candidates.set(key(cell), cell); }
      }
      if (candidates.size >= Math.ceil(size * size / 3) && placements >= Math.ceil(size * size / 3)) {
        choices.push({ axis, boundary, cells: [...candidates.values()], placements, centrality: Math.abs(boundary - size / 2) });
      }
    }
    if (!choices.length) return null;
    const closest = Math.min(...choices.map(choice => choice.centrality));
    const central = choices.filter(choice => choice.centrality === closest);
    const choice = central[fixedIndex(seed, 'ship-crossline', central.length)];
    const boundaryName = choice.axis === 'x' ? `${column(choice.boundary - 1)}/${column(choice.boundary)}列` : `第${choice.boundary}/${choice.boundary + 1}行`;
    return { id: 'long-ship-crossline', kind: 'ship_crossline',
      text: `开局观测：至少一艘长≥4格的舰跨过${boundaryName}分界，同一艘舰在分界两侧都有舰格。`,
      cells: choice.cells, proof: { asOf: '开局', axis: choice.axis, boundaries: [choice.boundary], minLength: 4,
        quantifier: 'at_least_one', candidateCellCount: choice.cells.length, candidatePlacementCount: choice.placements } };
  }
  function submarineRegion(width) {
    const submarines = ships.filter(ship => ship.length === 1), choices = [];
    if (!submarines.length) return null;
    for (const axis of ['x', 'y']) {
      const starts = width === size / 2 ? [0, size - width] : Array.from({ length: size - width + 1 }, (_, i) => i);
      for (const start of starts) if (submarines.some(ship => ship[0][axis] >= start && ship[0][axis] < start + width)) {
        choices.push({ axis, start, cells: strip(size, axis, start, width) });
      }
    }
    const region = choices[fixedIndex(seed, 'submarine-region', choices.length)];
    return { id: 'submarine-region', kind: 'submarine_region',
      text: `开局观测：至少一艘1格潜艇在${stripName(region.axis, region.start, width)}内，仍需逐格确认；这条线索只描述潜艇。`,
      cells: region.cells, proof: { asOf: '开局', axis: region.axis, width, targetLength: 1,
        quantifier: 'at_least_one', regionCellCount: region.cells.length, candidateCellCount: region.cells.length } };
  }
  if (levelId === 2) clues.push(emptyPatch(2) ?? fullBand(true));
  else if (levelId === 3) clues.push(orientation());
  else if (levelId === 4) clues.push(crossline() ?? fullBand(true));
  else if (levelId >= 5) {
    const region = submarineRegion(levelId === 5 ? size / 2 : Math.min(size - 1, Math.ceil(size / 3) + 1));
    if (!region) clues.push(fullBand(true));
    else {
      const patch = emptyPatch(levelId === 5 ? 2 : 3, region.cells);
      const excluded = new Set((patch?.cells ?? []).map(key));
      region.proof.candidateCellCount = region.cells.filter(cell => !excluded.has(key(cell))).length;
      clues.push(region, patch ?? fullBand(true));
    }
  } else clues.push(fullBand());
  return clues.filter(Boolean).slice(0, limit);
}
