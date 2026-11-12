/** 只处理数据库返回的公开粗范围与协议，不接受舰队或实时敌位。 */
import {LEVELS,enemyFirePlan} from './海战规则.mjs';

export const SUPPORT_CODES=Object.freeze(['radar_recommend','safe_mark','relay_target','radar_sweep','radar_filter','pattern_plan']);
export const TACTICAL_PATTERNS=Object.freeze(Object.fromEntries([
  ['radar',2,[[0,0],[1,0],[0,1],[1,1]]],
  ['distributed_i',4,[[0,0],[3,0],[0,3],[3,3]]],
  ['distributed_ii',5,[0,2,4].flatMap(dy=>[0,2,4].map(dx=>[dx,dy]))],
  ['piercing',3,[[0,0],[2,0],[1,1],[0,2],[2,2]]],
].map(([weapon,span,points])=>[weapon,Object.freeze({span,offsets:Object.freeze(points.map(([dx,dy])=>Object.freeze({dx,dy})))} )])));

const kinds=new Set(['dense_half','full_ship_band','empty_patch','ship_orientation','ship_crossline','submarine_region']);
const proofKeys=new Set(['asOf','fallback','span','emptyCellCount','length','orientation','candidatePlacementCount','quantifier','axis','boundaries','minLength','candidateCellCount','width','targetLength','regionCellCount']);
const key=c=>`${c.x},${c.y}`;
function integer(v,min,max,label){if(!Number.isInteger(v)||v<min||v>max)throw new RangeError(`${label}必须为${min}～${max}的整数`);return v;}
function object(v,label){if(!v||Array.isArray(v)||typeof v!=='object'||Object.getPrototypeOf(v)!==Object.prototype)throw new TypeError(`${label}必须是普通对象`);}
function keys(v,allowed,label){object(v,label);for(const name of Object.keys(v))if(!allowed.has(name))throw new TypeError(`${label}包含未知字段：${name}`);}
function checkSize(size){if(![8,10,12].includes(size))throw new RangeError('棋盘尺寸只支持8、10、12');}
function rectangle(cells,size){
  if(!cells.length)return null;
  const x=Math.min(...cells.map(c=>c.x)),y=Math.min(...cells.map(c=>c.y)),w=Math.max(...cells.map(c=>c.x))-x+1,h=Math.max(...cells.map(c=>c.y))-y+1;
  return cells.length===w*h?{x,y,w,h,stripe:w===size||h===size}:null;
}
function validateProof(proof,size){
  if(proof===undefined)return;
  keys(proof,proofKeys,'公开依据');
  for(const [name,value] of Object.entries(proof)){
    if(name==='asOf'){if(value!=='开局')throw new RangeError('公开依据必须是开局观测');}
    else if(name==='fallback'){if(typeof value!=='boolean')throw new TypeError('fallback必须为布尔值');}
    else if(name==='orientation'){if(!['horizontal','vertical'].includes(value))throw new RangeError('舰向无效');}
    else if(name==='axis'){if(!['x','y'].includes(value))throw new RangeError('轴向无效');}
    else if(name==='quantifier'){if(value!=='at_least_one')throw new RangeError('存在性量词无效');}
    else if(name==='boundaries'){if(!Array.isArray(value)||value.length!==1)throw new RangeError('分界必须为一条');integer(value[0],1,size-1,'分界');}
    else integer(value,1,size**3,`公开依据${name}`);
  }
}
function validateCells(clue,size,level){
  if(!Array.isArray(clue.cells)||clue.cells.length>size*size)throw new TypeError('粗范围必须是棋盘内坐标数组');
  const cells=clue.cells.map(c=>{keys(c,new Set(['x','y']),'粗范围坐标');return{x:integer(c.x,0,size-1,'x'),y:integer(c.y,0,size-1,'y')};});
  if(new Set(cells.map(key)).size!==cells.length)throw new RangeError('粗范围坐标重复');
  validateProof(clue.proof,size);const box=rectangle(cells,size),proof=clue.proof??{};
  if(['dense_half','full_ship_band'].includes(clue.kind)){
    if(!box?.stripe||cells.length!==size*size/2)throw new RangeError('半盘粗范围不能缩成精确舰格');
    if(clue.kind==='dense_half'&&!([0,size/2].includes(box.w===size?box.y:box.x)))throw new RangeError('密度半盘起点无效');
  }else if(clue.kind==='empty_patch'){
    const span=level===6?3:2;
    if(![2,5,6].includes(level)||!box||box.w!==span||box.h!==span||proof.span!==span||proof.emptyCellCount!==span*span)throw new RangeError('空海区域必须是本关完整公开方块');
  }else if(clue.kind==='submarine_region'){
    const width=level===5?size/2:Math.ceil(size/3)+1;
    if(![5,6].includes(level)||!box?.stripe||cells.length!==width*size||proof.width!==width||proof.targetLength!==1||proof.regionCellCount!==cells.length)throw new RangeError('潜艇观测必须保留宽区域，不能给单舰坐标');
  }else if(clue.kind==='ship_orientation'){
    if(level!==3||cells.length||proof.length!==5||!['horizontal','vertical'].includes(proof.orientation)||proof.candidatePlacementCount!==size*(size-4))throw new RangeError('舰向观测不能携带精确舰格');
  }else if(clue.kind==='ship_crossline'){
    if(level!==4||!box?.stripe||cells.length<Math.ceil(size*size/3)||proof.minLength!==4)throw new RangeError('跨线观测必须保留公开候选带');
  }
  return cells;
}
function normalizeProtocol(value,level){
  const allowed=new Set(['id','code','description',...(level===3?['target_length','period']:level===4?['enemy_period','max_enemy_shots']:[])]);
  keys(value,allowed,'战术协议');
  if(value.id!==`level-${level}-support`||value.code!==SUPPORT_CODES[level-1])throw new RangeError('战术协议与关卡不匹配');
  if(value.description!==undefined&&(typeof value.description!=='string'||value.description.length>500))throw new TypeError('战术说明无效');
  if(level===3&&(value.target_length!==5||value.period!==4))throw new RangeError('中继协议只接受公开的唯一5格舰与四轮周期');
  if(level===4&&(value.enemy_period!==3||value.max_enemy_shots!==1))throw new RangeError('扫频协议参数无效');
  return {...value};
}

/** 无效资料整批拒绝；目录噪声的空对象不提供任何能力。坐标全部是0起点局部坐标。 */
export function normalizeSupportRows(rows,{size,level}={}){
  checkSize(size);integer(level,1,6,'关卡');if(LEVELS[level-1].size!==size)throw new RangeError('关卡与棋盘尺寸不一致');
  if(!Array.isArray(rows))throw new TypeError('查询结果必须是数组');
  const focus=new Map(),submarine=new Map(),safe=new Map(),protocols=new Map();
  for(const row of rows){
    object(row,'查询行');if(typeof row.payload_json!=='string'||row.payload_json.length>65536)throw new TypeError('缺少合法payload_json');
    let payload;try{payload=JSON.parse(row.payload_json);}catch{throw new TypeError('payload_json不是合法JSON');}
    keys(payload,new Set(['clue','protocol']),'公开战术payload');
    if(!Object.keys(payload).length){if(row.kind&&row.kind!=='non_tactical')throw new TypeError('战术行缺少公开payload');continue;}
    keys(payload.clue,new Set(['kind','cells','proof']),'公开线索');const clue=payload.clue;
    if(!kinds.has(clue.kind)||(row.kind!==undefined&&row.kind!==clue.kind))throw new RangeError('公开线索类型不匹配');
    const cells=validateCells(clue,size,level);
    if(['dense_half','full_ship_band','submarine_region'].includes(clue.kind))for(const c of cells)focus.set(key(c),c);
    if(clue.kind==='submarine_region')for(const c of cells)submarine.set(key(c),c);
    if(clue.kind==='empty_patch')for(const c of cells)safe.set(key(c),c);
    if(payload.protocol!==undefined){const p=normalizeProtocol(payload.protocol,level),old=protocols.get(p.id);if(old&&JSON.stringify(old)!==JSON.stringify(p))throw new RangeError('同一协议出现冲突参数');protocols.set(p.id,p);}
    else if(clue.kind!=='dense_half')throw new TypeError('额外线索缺少本关协议');
  }
  const ordered=map=>[...map.values()].sort((a,b)=>a.y-b.y||a.x-b.x),f=ordered(focus),s=ordered(submarine),e=ordered(safe);
  return{focus:f,submarine:s,safe:e,protocols:[...protocols.values()],cells:[...f.map(c=>({...c,tag:'focus'})),...s.map(c=>({...c,tag:'submarine'})),...e.map(c=>({...c,tag:'safe'}))]};
}

function literal(value,label,max){if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw new TypeError(`${label}无效`);return`'${value.replaceAll('\\','\\\\').replaceAll("'","''")}'`;}

/** 只按公开候选覆盖排序；旧格与安全格可覆盖，但不给覆盖分。不是命中率。 */
export function planSql({weapon,size,missionId,sectorId,limit=2}={}){
  checkSize(size);if(typeof weapon!=='string'||!Object.hasOwn(TACTICAL_PATTERNS,weapon))throw new RangeError('不支持该规划武器');integer(limit,1,10,'建议数量');
  const mission=literal(missionId,'任务编号',64);if(typeof sectorId!=='string'||!/^S(?:[1-9]|1[0-6])$/.test(sectorId))throw new RangeError('海区编号无效');const sector=literal(sectorId,'海区编号',8),pattern=TACTICAL_PATTERNS[weapon];
  const unknown='COALESCE(t.is_safe,0)=0 AND COALESCE(s.is_shot,0)=0';
  return [
    'SELECT a.x AS anchor_x, a.y AS anchor_y,',
    `  SUM(CASE WHEN ${unknown} THEN 1 ELSE 0 END) AS unknown_coverage,`,
    '  SUM(CASE WHEN COALESCE(s.is_shot,0)=1 THEN 1 ELSE 0 END) AS repeat_count,',
    '  SUM(CASE WHEN COALESCE(t.is_safe,0)=1 THEN 1 ELSE 0 END) AS safe_count,',
    '  COUNT(*) AS total_points,',
    `  SUM(CASE WHEN ${unknown} AND COALESCE(t.is_submarine,0)=1 THEN 1 ELSE 0 END) AS submarine_coverage,`,
    `  SUM(CASE WHEN ${unknown} AND COALESCE(t.is_focus,0)=1 THEN 1 ELSE 0 END) AS focus_coverage`,
    'FROM sea_cells a',
    `JOIN naval_pattern_offsets o ON o.weapon='${weapon}' AND o.span=${pattern.span}`,
    'JOIN sea_cells p ON p.x=a.x+o.dx AND p.y=a.y+o.dy',
    'LEFT JOIN (',
    "  SELECT x,y,MAX(CASE WHEN tag='safe' THEN 1 ELSE 0 END) AS is_safe,",
    "    MAX(CASE WHEN tag='focus' THEN 1 ELSE 0 END) AS is_focus,",
    "    MAX(CASE WHEN tag='submarine' THEN 1 ELSE 0 END) AS is_submarine",
    `  FROM naval_tactic_cells WHERE mission_id=${mission} AND sector_id=${sector}`,
    '  GROUP BY x,y',
    ') t ON t.x=p.x AND t.y=p.y',
    'LEFT JOIN (',
    '  SELECT x,y,1 AS is_shot FROM naval_public_shots',
    `  WHERE mission_id=${mission} AND sector_id=${sector} AND state IN ('miss','hit','sunk')`,
    '  GROUP BY x,y',
    ') s ON s.x=p.x AND s.y=p.y',
    `WHERE a.x BETWEEN 0 AND ${size-pattern.span} AND a.y BETWEEN 0 AND ${size-pattern.span}`,
    `  AND p.x BETWEEN 0 AND ${size-1} AND p.y BETWEEN 0 AND ${size-1}`,
    ...(weapon==='radar'?['  AND MOD(a.x,2)=0 AND MOD(a.y,2)=0']:[]),
    'GROUP BY a.x,a.y',
    `HAVING total_points=${pattern.offsets.length} AND unknown_coverage>0`,
    'ORDER BY submarine_coverage DESC,focus_coverage DESC,unknown_coverage DESC,repeat_count ASC,safe_count ASC,anchor_y,anchor_x',
    `LIMIT ${limit}`,
  ].join('\n');
}

/** 只调整公开副炮计划；不读舰位、不授予额外资源，也不改变AI选点。 */
export function supportEnemyPlan({level,round,relayDisabled=false,sweepRound=null}={}){
  integer(level,1,6,'关卡');integer(round,1,10000,'轮次');if(typeof relayDisabled!=='boolean')throw new TypeError('中继状态必须为布尔值');if(sweepRound!==null)integer(sweepRound,1,10000,'扫频轮次');
  const base=enemyFirePlan(level,round);let shots=base.shots,nextShots=base.nextShots,reason=null;
  if(level===3&&relayDisabled){shots=1;nextShots=1;reason='relay_disabled';}
  else if(level===4&&sweepRound===round){shots=1;reason='radar_sweep';}
  return{shots,nextShots,warning:nextShots===2,baseShots:base.shots,baseNextShots:base.nextShots,reason};
}
