/** 流程裁判只核对查询结果与导航误差，不生成或补充战术线索。 */
export const FORK_DESCRIPTION = '在关卡内或关卡失败后，可重开本关一次；敌位和重开前一致，随后需要两关冷却时间。';

export function canEnterSea(state) {
  return Boolean(state?.deploymentConfirmed && state.reconLocked && state.briefingAccepted);
}

export function checkRecon(rows, {level, targetSector, abilities}) {
  const required = ['range','fulltext','vector','filter'].slice(0, Math.min(4, level));
  const names={range:'范围检索',fulltext:'全文检索',vector:'向量检索',filter:'条件筛选'};
  const missing=required.filter(method=>!abilities.includes(method));
  if(missing.length)return {ok:false,reason:`还缺${missing.map(method=>names[method]).join('、')}，请为对应资料配上检索能力。`};
  if (!rows.length) return {ok: false, reason: '没有查到相关观测，换一份证据试试。'};
  const sectors = new Set(rows.map(row => row.sector_id));
  if (sectors.size !== 1 || !sectors.has(targetSector)) return {ok: false, reason: '观测尚未指向正确目标。检查口令、时间和信源。'};
  return {ok: true, reason: '观测已吻合，请在航海图上标记会合点。'};
}

export function canUseFork({owned, level, lastUse, used}) {
  return Boolean(owned && !used && (lastUse == null || level - lastUse >= 3));
}

/** 点位使用海图连续坐标；容差为棋盘边长的1/8，不替玩家自动吸附。 */
export function locatePin(pin, row, size) {
  const tolerance = size / 8;
  if (!pin || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)
    || !Number.isFinite(Number(row?.map_x)) || !Number.isFinite(Number(row?.map_y))) return {ok: false, distance: Infinity, tolerance};
  const distance = Math.hypot(pin.x - Number(row.map_x), pin.y - Number(row.map_y));
  return {ok: distance <= tolerance, distance, tolerance};
}

export function chartColumn(index) {
  let value = Math.floor(index) + 1, label = '';
  while (value > 0) {value--; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26);}
  return label;
}
