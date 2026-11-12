import {NavalDB} from './数据库.mjs';
import {renderWeaponChoices,paintPixelBrand} from './像素控件.mjs';
import {createReconChoices,createDetailChoices} from './情报组合.mjs';
import {createReconTask,createDetailTask} from './检索任务.mjs';
import {normalizeSupportRows,planSql,supportEnemyPlan} from './战术规划.mjs';
import {drawAxisNumber, drawAxisLetter} from './棋盘字模.mjs';
import {SEA_PALETTE,drawSeaCell} from './海面像素.mjs';
import {ICON_SIZE, drawPixelIcon, getLevelRewards, WEAPON_INFO} from './像素图鉴.mjs';
import {createDetailEvidence, buildDetailQuery, isTacticalClueKind} from './细节检索.mjs';
import {checkRecon, canUseFork, chartColumn, canEnterSea, FORK_DESCRIPTION} from './作战流程.mjs';
import {LEVELS, ROUND_LIMITS, createRng, createFleet, validateFleet, applyShot, createKnowledge,
  recordShot, chooseEnemyShots, generateEvidence, buildQuery, validateSalvo, sectorBounds, boundsFromCells, resolveAim, weaponPatternAtAnchor, enemyFirePlan, createEnemyFleet, placementBlockedCells} from './海战规则.mjs';

const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const key = cell => `${cell.x},${cell.y}`;
const coord = cell => `${String.fromCharCode(65 + cell.x)}${cell.y + 1}`;
const quote = value => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const LIMITS = ROUND_LIMITS;
const COMBAT_SPEED = 0.45;
const COMBAT_PLAYBACK_RATE = 1.2;
const isExtraClueKind = kind => kind !== 'dense_half' && isTacticalClueKind(kind);
const DETAIL_MISSIONS = [
  ['新兵认船','确认哪一带有完整舰，练习命中后追击。'],
  ['海水免打扰','找一块确认无舰的2×2海域，省下炮弹。'],
  ['听声辨长舰','判断最长舰的横竖方向，别把所有船当成同一方向。'],
  ['航道抓现行','找出长舰跨过的行列分界，两侧都可能藏着同一艘船。'],
  ['潜艇捉迷藏','查潜艇所在半盘与一块空海域，再安排雷达。'],
  ['终局联合搜潜','查潜艇活动宽带和3×3空海域，规划最后的搜潜路线。'],
];
const METHODS = [
  {id: 'range', kind: 'range', name: '范围检索', unlock: 1, detail: 'BETWEEN · 选有效观测区间'},
  {id: 'fulltext', kind: 'keyword', name: '全文检索', unlock: 2, detail: 'MATCH · 识别监听代号'},
  {id: 'vector', kind: 'vector', name: '向量检索', unlock: 3, detail: 'L2 · 比对八维回波特征'},
  {id: 'filter', kind: 'filter', name: '条件筛选', unlock: 4, detail: 'WHERE · 排除旧任务与传闻'},
];
const TUTORIAL = [
  ['先安排自己的舰队', '点舰身选船，再点船头的目标格；方向键移动，R以船头为中心旋转，船头位置不变。确认后出航。'],
  ['查情报，再读SQL结果', '定位SQL给出坐标；回波向量加监听词查更多线索。读完结果后自动定位，确认出航。'],
  ['点格、发射、追击', '空心圈是落空，橙色是命中。普通炮不重打，雷达与武器在菜单里。'],
];
const MEDALS = {
  lightweight: ['极致轻量', '最长舰缩短一格，解锁嵌入式三联炮。'],
  fork: ['Fork / Merge', FORK_DESCRIPTION],
  mysql: ['MySQL 兼容', '复制敌舰双炮协议，每四轮普通双响。'],
  distributed: ['分布式扩展', '解锁四角四点弹；第六关增加隔格九点弹，同系列每关共享一发。'],
  piercing: ['异步向量索引导弹', '每关一枚X形五点导弹。'],
  ultimate: ['究极分布式扩展', '解锁5×5隔格九点弹，与四角弹共享弹包。'],
};
let db;
let campaign;
let state;
let deal;
let detailEvidence = null;
let detailSelection = {sample:'',keyword:''};
let busy = true;
let serial = 0;
let tableNames;
let cards = new Set();
let abilities = new Set();
let targets = [];
let hover = null;
let selectedShip = 0;
let deploySerial = 0;
let fx = null;
let noteSerial = 0;
let queryMetrics = [];
let logs = [];
let notes = [];
let view = 'welcome';
let tutorialIndex = 0;
let recordsOpen = false;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function freshSeed() {
  return `SEA-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase()}`;
}

function notify(message, type = 'info') {
  logs.unshift({round: state?.round ?? 0, message, type});
  logs = logs.slice(0, 50);
  const status = $('status-message');
  if (status) {status.textContent = message; status.dataset.tone = type;}
  const area = $('battle-log');
  area.replaceChildren(...logs.map(item => {
    const row = element('p', `log-line ${item.type}`);
    row.append(element('b', '', String(item.round).padStart(2, '0')), document.createTextNode(` ${item.message}`));
    return row;
  }));
}

async function operation(work) {
  if (busy) return;
  // SQL动作失败时恢复可操作状态；序号保持单调，已创建的分支名称不复用。
  const backup = clone({campaign, state, deal, detailEvidence, detailSelection, tableNames, notes, queryMetrics, targets,
    cards: [...cards], abilities: [...abilities], noteSerial, view, tutorialIndex});
  busy = true;
  render();
  try { await work(); }
  catch (error) {
    ({campaign, state, deal, detailEvidence, detailSelection, tableNames, notes, queryMetrics, targets, view, tutorialIndex} = backup);
    cards = new Set(backup.cards); abilities = new Set(backup.abilities);
    // 补偿已成功写入而动作尚未提交的笔记，避免重试或Merge保留幽灵记录。
    if (tableNames?.notes && campaign) {
      try {
        const added = Array.from({length: Math.max(0, noteSerial - backup.noteSerial)}, (_, i) =>
          quote(`${campaign.id}-${campaign.level}-${backup.noteSerial + i + 1}`));
        if (added.length) await db.exec(`DELETE FROM ${tableNames.notes} WHERE id IN (${added.join(',')})`);
      } catch (cleanupError) { notify(`未能清理失败动作的笔记：${cleanupError.message}`, 'error'); }
    }
    if (state?.activeSector) state.knowledge = state.sectorKnowledge[state.activeSector];
    notify(`执行失败：${error.message}`, 'error');
    $('engine-detail').textContent = error.message;
  } finally { busy = false; render(); }
}

function boardSize() { return state?.player.size ?? 8; }
function availableMethods() { return METHODS.filter(method => method.unlock <= (campaign?.level ?? 1)); }
function hasMedal(name) { return campaign?.medals.includes(name); }
function canRewind() { return Boolean(state?.deploymentConfirmed && tableNames?.checkpoint
  && canUseFork({owned: hasMedal('fork'), level: campaign.level,
    lastUse: campaign.lastForkUseLevel, used: campaign.rewinds[campaign.level]})); }
function ordinaryShots() {
  return hasMedal('mysql') && state?.copiedDoubleEvery > 0 && state.round % state.copiedDoubleEvery === 0 ? 2 : 1;
}

async function createSchema() {
  await db.exec('CREATE DATABASE IF NOT EXISTS seekdb_naval');
  await db.exec('USE seekdb_naval');
  await db.exec(`CREATE TABLE IF NOT EXISTS intelligence (
    id VARCHAR(64) PRIMARY KEY, sector_id VARCHAR(8), cells LONGTEXT, tactical_cells LONGTEXT, tactical_hint TEXT,
    tactical_clues LONGTEXT, fleet_manifest TEXT, map_x DOUBLE, map_y DOUBLE, enemy_fire_every INT, detail_keyword VARCHAR(24), body TEXT,
    source VARCHAR(24), confidence INT, observed_round INT, mission_id VARCHAR(64),
    ship_class VARCHAR(24), call_sign VARCHAR(24), embedding VECTOR(8),
    FULLTEXT INDEX ft_body(body), VECTOR INDEX idx_signal(embedding)
    WITH (distance=l2, type=hnsw, lib=vsag))`);
  await db.exec('CREATE TABLE IF NOT EXISTS sea_cells (x INT, y INT, PRIMARY KEY(x,y), INDEX grid_yx(y,x))');
  await db.exec('DELETE FROM sea_cells');
  const cells = [];
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) cells.push(`(${x},${y})`);
  await db.exec(`INSERT INTO sea_cells VALUES ${cells.join(',')}`);
  await db.exec('CREATE TABLE IF NOT EXISTS capabilities (owner VARCHAR(16), skill VARCHAR(24), every_n INT, PRIMARY KEY(owner,skill))');
  await db.exec(`CREATE TABLE IF NOT EXISTS tactical_observations (
    id VARCHAR(80) PRIMARY KEY, sector_id VARCHAR(8), mission_id VARCHAR(64), observed_round INT,
    clue_id VARCHAR(64), kind VARCHAR(32), clue_text TEXT, body TEXT, source VARCHAR(24), embedding VECTOR(8), payload_json LONGTEXT,
    FULLTEXT INDEX ft_detail(body), VECTOR INDEX idx_detail_signal(embedding)
    WITH (distance=l2, type=hnsw, lib=vsag))`);
  await db.exec('CREATE TABLE IF NOT EXISTS radar_echoes (x INT, y INT, occupied INT, jammed INT, PRIMARY KEY(x,y))');
  await db.exec('CREATE TABLE IF NOT EXISTS naval_tactic_cells (mission_id VARCHAR(64),sector_id VARCHAR(8),x INT,y INT,tag VARCHAR(24),PRIMARY KEY(mission_id,sector_id,x,y,tag))');
  await db.exec('CREATE TABLE IF NOT EXISTS naval_public_shots (mission_id VARCHAR(64),sector_id VARCHAR(8),x INT,y INT,state VARCHAR(16),PRIMARY KEY(mission_id,sector_id,x,y))');
  await db.exec('CREATE TABLE IF NOT EXISTS naval_pattern_offsets (weapon VARCHAR(24),dx INT,dy INT,span INT,PRIMARY KEY(weapon,dx,dy))');
  await db.exec('DELETE FROM naval_pattern_offsets');
  const offsets=[];
  for(const [weapon,span] of [['radar',2],['distributed_i',4],['distributed_ii',5],['piercing',3]]){
    const points=weapon==='radar'?[{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}]:weaponPatternAtAnchor(weapon,{x:0,y:0},12);
    for(const c of points)offsets.push(`(${quote(weapon)},${c.x},${c.y},${span})`);
  }
  await db.exec(`INSERT INTO naval_pattern_offsets VALUES ${offsets.join(',')}`);
  await db.exec("REPLACE INTO capabilities VALUES ('enemy','double_fire',2)");
}

async function startCampaign(seed = freshSeed()) {
  const cleanSeed = String(seed).trim().slice(0, 64) || freshSeed();
  campaign = {seed: cleanSeed, id: ++serial, level: 1, medals: [], score: 0, rewinds: {}, lastForkUseLevel: null};
  logs = []; notes = []; queryMetrics = []; noteSerial = 0;
  $('new-seed').value = cleanSeed;
  await db.exec("DELETE FROM capabilities WHERE owner='player'");
  const name = `notes_main_${serial}`;
  await db.exec(`CREATE TABLE ${name} (id VARCHAR(80) PRIMARY KEY, level_no INT, round_no INT, kind VARCHAR(12), body TEXT)`);
  campaign.notesTable = name;
  await prepareLevel();
}

async function prepareLevel() {
  const level = LEVELS[campaign.level - 1];
  const enemySeed = `${campaign.seed}|enemy|${campaign.level}`;
  const lightweight = hasMedal('lightweight');
  await db.exec(`REPLACE INTO capabilities VALUES ('enemy','double_fire',${level.enemyDoubleEvery})`);
  state = {
    phase: 'deploy', rewardsConfirmed:false, pendingRewards:[], rewardCards:[], projectileStyle:{}, deploymentConfirmed: false, briefingAccepted: false, round: 1, enemySeed,
    player: createFleet(level.playerShips, {size: level.size, seed: `${campaign.seed}|player|${campaign.level}`, lightweight, noTouch:true}),
    enemy: createEnemyFleet({level: campaign.level, seed: enemySeed}),
    knowledge: createKnowledge(level.size), aiKnowledge: createKnowledge(level.size),
    activeSector: null, proposedSector: 'S1', sectorKnowledge: {}, globalShots: {}, enemySector: null,
    queryUsed: false, reconLocked: false, mapPin: null, wasHit: false, heat: [], resultRows: [], copiedDoubleEvery: 0,
    ammo: {radar: level.radarCharges, dual: level.dualCharges, triple: level.tripleCharges}, radarFindings: [], radarKnowledge: {}, lastRadarSql: '', impact: null,
    reconChoiceId:'',detailChoiceId:'',rejectedReconChoices:[],rejectedDetailChoices:[],
    mapMarks:{},detailComparisons:null,hybridReady:false,support:{focus:[],submarine:[],safe:[],cells:[],protocols:[]},relayDisabled:false,sweepRound:null,tacticPlans:[],lastTacticSql:'',detailRows: [], acquiredDetailRows: [], lastDetailSql: '', lastDetailInput: null, detailMs: 0, detailFeedback: '',
    weapon: 'normal', direction: 'horizontal', specialUsed: {distributed: false, piercing: false},
    levelScore: 0, shotHistory: [], lastSql: '', lastReconSql: '', lastMs: 0,
  };
  state.enemySector = generateEvidence({fleet: state.enemy, level: campaign.level, round: 1, seed: campaign.seed}).truth.targetSector;
  // 雷达裁判表单独预载，情报表只保存粗线索。正常界面只能按雷达模板查询四格。
  const occupied = new Set(state.enemy.ships.flatMap(ship => ship.cells.map(key)));
  const echoes = Array.from({length: level.size ** 2}, (_, i) => `(${i % level.size},${Math.floor(i / level.size)},${occupied.has(`${i % level.size},${Math.floor(i / level.size)}`) ? 1 : 0},${campaign.level===5 && i%level.size>=level.size/2?1:0})`);
  await db.exec('DELETE FROM radar_echoes');
  await db.exec(`INSERT INTO radar_echoes VALUES ${echoes.join(',')}`);
  if (hasMedal('mysql')) {
    const config = await db.query("SELECT every_n FROM capabilities WHERE owner='player' AND skill='double_fire'");
    state.copiedDoubleEvery = Number(config.rows[0]?.every_n ?? 0);
  }
  selectedShip = 0; deploySerial = 0; targets = []; cards.clear(); abilities.clear();
  deal = null; detailEvidence = null; detailSelection={sample:'',keyword:''}; tableNames = null; view = 'deploy'; $('result-panel').hidden = true;
  $('shrink-toggle').checked = lightweight;
  notify(`进入第${campaign.level}关。先部署舰队，再选择资料进行检索。`);
  if (campaign.level === 1) notify('第一关先用时间范围定位，再用回波和监听词查更多线索。');
  notify('点舰身选船，再点船头目标格；方向键移动，R以船头为中心旋转，船头不动。确认后出航。');
  render();
}

async function writeEvidence(evidence) {
  detailEvidence=createDetailEvidence({evidence,level:campaign.level,seed:campaign.seed});
  const manifest = JSON.stringify(LEVELS[campaign.level - 1].enemyShips);
  const archive=Array.from({length:128},(_,i)=>({...evidence.rows[i%evidence.rows.length],id:`archive-${i}`,observed_round:0,mission_id:'archived-mission',source:'ARCHIVE',confidence:20,call_sign:'ARCHIVE',body:`港口旧档案${i}：${detailEvidence.signalStory.archiveLines[i%detailEvidence.signalStory.archiveLines.length]}`,tactical_clues:'[]',tactical_hint:''}));
  const values = [...evidence.rows,...archive].map(row => {
    const bounds = boundsFromCells(row.cells);
    return `(${[
    row.id, row.sector_id, row.cells, row.tactical_cells, row.tactical_hint, JSON.stringify(JSON.parse(row.tactical_clues || '[]').slice(0,1).map(({id,kind,text,basis})=>({id,kind,text,basis}))), manifest,
      bounds.minX + bounds.width / 2, bounds.minY + bounds.height / 2, LEVELS[campaign.level - 1].enemyDoubleEvery, detailEvidence.keyword,
      row.body, row.source, row.confidence, row.observed_round, row.mission_id, row.ship_class, row.call_sign, JSON.stringify(row.embedding),
    ].map(value => typeof value === 'number' ? value : quote(value)).join(',')})`;
  });
  await db.exec('BEGIN');
  try {
    await db.exec('DELETE FROM intelligence');
    await db.exec(`INSERT INTO intelligence VALUES ${values.join(',')}`);
    await db.exec('DELETE FROM tactical_observations');
    const detailValues=detailEvidence.rows.map(row=>`(${[row.id,row.sector_id,row.mission_id,row.observed_round,row.clue_id,row.kind,row.clue_text,row.body,row.source,JSON.stringify(row.embedding),row.payload_json||'{}'].map(value=>typeof value==='number'?value:quote(value)).join(',')})`);
    await db.exec(`INSERT INTO tactical_observations VALUES ${detailValues.join(',')}`);
    await db.exec('COMMIT');
  } catch (error) { await db.exec('ROLLBACK'); throw error; }
}

async function dealEvidence() {
  const next = generateEvidence({fleet: state.enemy, level: campaign.level, round: state.round, seed: campaign.seed});
  await writeEvidence(next);
  deal = next;
  cards.clear(); abilities.clear();
}

function packState() {
  // 真实敌舰布局只由裁判保管；快照用固定种子及公开炮击记录重建。
  const {enemy, enemySector, ...publicState} = state;
  return clone(publicState);
}

async function saveState() {
  if (!tableNames) return;
  await db.exec(`UPDATE ${tableNames.live} SET state_json=${quote(JSON.stringify(packState()))} WHERE id=1`);
}

async function confirmDeployment() {
  const check = validateFleet(state.player);
  if (!check.ok) throw new Error(check.errors.join('，'));
  state.phase = 'player'; state.deploymentConfirmed = true; state.briefingAccepted = false;
  // 调整布阵后重建开局分支，不能把已通过的情报门槛带进回档快照。
  state.reconLocked = false; state.queryUsed = false; state.resultRows = []; state.heat = []; state.mapPin = null;
  state.hybridReady=false;state.detailComparisons=null;state.support={focus:[],submarine:[],safe:[],cells:[],protocols:[]};state.tacticPlans=[];state.lastTacticSql='';state.mapMarks={};state.relayDisabled=false;state.sweepRound=null;
  state.lastReconSql = ''; state.lastSql = ''; state.lastDetailSql=''; state.lastDetailInput=null; state.detailRows=[]; state.acquiredDetailRows=[]; state.detailFeedback=''; detailSelection={sample:'',keyword:''};
  state.reconChoiceId='';state.detailChoiceId='';state.rejectedReconChoices=[];state.rejectedDetailChoices=[];
  cards.clear();abilities.clear();
  state.activeSector = null; state.sectorKnowledge = {}; state.globalShots = {};
  state.knowledge = createKnowledge(boardSize());
  if (tableNames) {
    await saveState();
    const checkpoint = `checkpoint_edit_${campaign.id}_${campaign.level}_${++serial}`;
    await db.exec(`FORK TABLE ${tableNames.live} TO ${checkpoint}`); tableNames.checkpoint = checkpoint;
    setView(state.activeSector ? 'battle' : state.queryUsed ? 'theater' : 'intel');
    notify('舰队已就位。'); return;
  }
  state.queryUsed = false;
  const unique = `${campaign.id}_${campaign.level}_${++serial}`;
  tableNames = {live: `live_${unique}`, checkpoint: `checkpoint_${unique}`, notes: `notes_work_${unique}`};
  await db.exec(`CREATE TABLE ${tableNames.live} (id INT PRIMARY KEY, state_json LONGTEXT)`);
  await db.exec(`INSERT INTO ${tableNames.live} VALUES (1,${quote(JSON.stringify(packState()))})`);
  await db.exec(`FORK TABLE ${tableNames.live} TO ${tableNames.checkpoint}`);
  await db.exec(`FORK TABLE ${campaign.notesTable} TO ${tableNames.notes}`);
  await dealEvidence();
  view = 'intel';
  notify('舰队部署完成。先读任务目标，再为每种检索选资料；对应能力会自动装配。');
}

async function addNote(kind, message) {
  const item = {id: `${campaign.id}-${campaign.level}-${++noteSerial}`, level: campaign.level, round: state.round, kind, message, previous: false};
  notes.unshift(item);
  await db.exec(`REPLACE INTO ${tableNames.notes} VALUES (${quote(item.id)},${item.level},${item.round},${quote(kind)},${quote(message)})`);
}

function currentPlan() {
  return buildQuery({selectedCards: deal?.cards.filter(card => cards.has(card.id)) ?? [],
    abilities: [...abilities], missionId: deal?.missionId ?? '', round: state?.round ?? 1});
}

function reconChoices() { return deal ? createReconChoices({deal,level:campaign.level}) : []; }
function detailChoices() { return detailEvidence ? createDetailChoices({evidence:detailEvidence,seed:campaign.seed,level:campaign.level}) : []; }
function reconTask() {return deal?createReconTask({deal,level:campaign.level,seed:campaign.seed}):null;}
function detailTask() {return detailEvidence?createDetailTask({evidence:detailEvidence,level:campaign.level,seed:campaign.seed}):null;}
function selectReconCard(id) {
  if(busy||!state||state.queryUsed)return;
  const task=reconTask(),group=task.groups.find(g=>g.choices.some(c=>c.id===id));if(!group)return;
  const deselect=cards.has(id);
  for(const card of group.choices)cards.delete(card.id);
  if(deselect)abilities.delete(group.ability);else{cards.add(id);abilities.add(group.ability);}
  render();
}
function selectDetailInput(kind,id) {
  if(busy||!state||state.hybridReady)return;
  const input=detailTask()?.groups.find(g=>g.kind===kind)?.choices.find(c=>c.id===id);if(!input)return;
  if(kind==='echo')detailSelection.sample=detailSelection.sample===input.name?'':input.name;
  else detailSelection.keyword=detailSelection.keyword===input.keyword?'':input.keyword;
  render();
}

async function runRecon() {
  if (state.phase !== 'player' || !state.deploymentConfirmed || state.reconLocked) return;
  const plan = currentPlan();
  if (!plan.valid) { notify(plan.error, 'error'); return; }
  const panel = document.querySelector('.query-station'); panel.classList.add('is-running');
  try {
    const result = await db.query(plan.sql);
    state.lastSql = plan.sql; state.lastReconSql = plan.sql; state.lastMs = result.elapsedMs;
    state.resultRows = result.rows;
    const check = checkRecon(result.rows, {level: campaign.level, targetSector: state.enemySector, abilities: [...abilities]});
    queryMetrics.push({level: campaign.level, round: state.round, sql: plan.sql, ms: result.elapsedMs, rows: result.rows.length, accepted: check.ok});
    state.reconLocked = check.ok; state.queryUsed = check.ok;
    state.heat = check.ok ? [...new Map(result.rows.flatMap(row => JSON.parse(row.cells)).map(cell => [key(cell), cell])).values()] : [];
    await animate('scan', state.heat, 'theater', null, 450);
    if (!check.ok) {
      const mismatch=reconTask().groups.flatMap(group=>group.choices.filter(c=>cards.has(c.id)&&c.mismatch).map(c=>c.mismatch));
      view='intel';notify(`${mismatch.join(' ')||check.reason} 请对照任务目标调整资料；不消耗炮弹或海战回合。`,'warning');
      await saveState(); return;
    }
    state.proposedSector = result.rows[0].sector_id; state.mapPin = null;
    await addNote('query', `SQL已确认目标海域，返回${result.rows.length}条观测和固定战术线索。`);
    notify('定位查询成功。先看 SQL 返回了什么，再查回波与监听关键词获取细节。', 'hit');
    await saveState(); setView('briefing');
  } finally { panel.classList.remove('is-running'); }
}

function currentDetailPlan(mode) {
  const sample=detailEvidence?.samples.find(item=>item.name===detailSelection.sample);
  const selectedMode=mode || (detailSelection.sample && detailSelection.keyword?'hybrid':detailSelection.sample?'vector':'fulltext');
  return buildDetailQuery({sectorId:state?.resultRows[0]?.sector_id,missionId:deal?.missionId,
    vector:sample?.vector,keyword:detailSelection.keyword,mode:selectedMode});
}

async function runDetailSearch() {
  if(!state?.deploymentConfirmed || !state.reconLocked || state.activeSector)return;
  const plan=currentDetailPlan();if(!plan.valid){notify(plan.error,'warning');return;}
  const both=Boolean(detailSelection.sample && detailSelection.keyword);
  let vectorRows=[],textRows=[];
  if(both){vectorRows=(await db.query(currentDetailPlan('vector').sql)).rows;textRows=(await db.query(currentDetailPlan('fulltext').sql)).rows;}
  const result=await db.query(plan.sql);
  state.lastDetailSql=plan.sql;state.lastDetailInput=clone(detailSelection);state.detailMs=result.elapsedMs;state.detailRows=result.rows;
  if(both){
    state.detailComparisons={vector:vectorRows.length,fulltext:textRows.length,hybrid:result.rows.length};
    const clues=result.rows.filter(row=>isExtraClueKind(row.kind));
    const acquired=new Map((state.acquiredDetailRows||[]).map(row=>[row.clue_id,row]));
    for(const row of clues)acquired.set(row.clue_id,{...clone(row),retrievalSql:plan.sql});
    state.acquiredDetailRows=[...acquired.values()];
    state.support=normalizeSupportRows(state.acquiredDetailRows,{size:boardSize(),level:campaign.level});
    state.hybridReady=state.support.protocols.length>0;
    if(state.hybridReady)state.detailFeedback=`混合检索确认${clues.length}条观测，战术手册和本关支援已就绪。`;
    else {
      const mismatch=detailTask().groups.flatMap(group=>group.choices.filter(c=>(group.kind==='echo'?c.name===detailSelection.sample:c.keyword===detailSelection.keyword)&&c.mismatch).map(c=>c.mismatch));
      state.detailFeedback=`${mismatch.join(' ')||detailEvidence.signalStory.feedback.empty} 请对照侦察目标调整；不消耗炮弹或海战回合。`;

    }
  }else state.detailFeedback=`单项检索得到${result.rows.length}条候选。再点击另一份情报，组合全文与向量条件。`;
  queryMetrics.push({level:campaign.level,round:state.round,kind:'detail',sql:plan.sql,rows:result.rows.length,ms:result.elapsedMs});
  await addNote('query',state.detailFeedback);notify(state.detailFeedback,state.hybridReady?'hit':'info');await saveState();
}

async function acceptBriefing() {
  if(!state?.deploymentConfirmed || !state.reconLocked || state.activeSector)return;
  if(!state.hybridReady)throw new Error('按侦察目标选择回波与监听资料，执行混合检索，再带线索出航。');
  const row=state.resultRows[0];
  state.mapPin={x:Number(row.map_x),y:Number(row.map_y)};
  state.briefingAccepted=true;await saveState();setView('theater');
}

function resultTable(rows, fields) {
  const table=element('table','query-result-table');
  const head=table.createTHead().insertRow();
  for(const [field,label] of fields) head.append(element('th','',label));
  const body=table.createTBody();
  for(const row of rows) {
    const line=body.insertRow();
    for(const [field] of fields) line.append(element('td','',row[field]===undefined?'':String(row[field])));
  }
  return table;
}

function renderBriefing() {
  if(!$('briefing-sql'))return;
  const mission=DETAIL_MISSIONS[(campaign?.level||1)-1],story=detailEvidence?.signalStory;
  $('detail-mission-title').textContent=`混合侦察 · ${story?.title||mission[0]}`;
  $('detail-mission-help').textContent=`${mission[1]}${story?` 监听员备注：${story.listen.text}`:''}`;
  $('briefing-sql').textContent=state?.lastReconSql||'先执行定位 SQL。';
  const sourceCards=(state?.resultRows||[]).map(row=>{
    const card=element('article','briefing-source');
    const report=row.body.split('不提供单舰格。').at(-1);
    card.append(element('h4','',row.source),element('p','',report));return card;
  });
  $('briefing-rows').replaceChildren(...(sourceCards.length?sourceCards:[element('p','','尚未执行定位查询。')]));
  const row=state?.resultRows[0],findings=[];
  if(state?.reconLocked&&row){
    findings.push(element('p','',`${state.resultRows.length}份报告指向同一海域${row.sector_id}。共同结论合并展示，观测依据见各站报告。`));
    findings.push(element('p','',`大海图：${chartColumn(Math.floor(Number(row.map_x)))}${Math.floor(Number(row.map_y))+1}附近，出航前自动标记。`));
    try{for(const clue of JSON.parse(row.tactical_clues||'[]'))findings.push(element('p','',clue.text));}catch{}
  }
  $('briefing-findings').replaceChildren(...findings);
  const task=detailTask();
  $('detail-match-objective').textContent=task?.goal||'定位后接收侦察任务。';
  const groups=[];
  for(const group of task?.groups||[]) {
    const section=element('section','retrieval-group');section.dataset.detailKind=group.kind;
    section.append(element('h4','retrieval-group-title',group.label));
    const pair=element('div','retrieval-pair');
    for(const input of group.choices){
      const selected=group.kind==='echo'?detailSelection.sample===input.name:detailSelection.keyword===input.keyword;
      const button=element('button',`detail-source-card${selected?' selected':''}`);button.type='button';button.dataset.detailInputId=input.id;button.dataset.detailKind=group.kind;
      button.setAttribute('aria-pressed',String(selected));button.disabled=busy||!state?.reconLocked||state.hybridReady;
      button.append(element('strong','',input.label),element('span','evidence-body',input.text),element('span','evidence-acquisition',`获取渠道：${input.acquisition}`));
      button.onclick=()=>selectDetailInput(group.kind,input.id);pair.append(button);
    }
    section.append(pair);groups.push(section);
  }
  $('detail-choice-groups').replaceChildren(...groups);
  const plan=currentDetailPlan(),both=Boolean(detailSelection.sample&&detailSelection.keyword);
  $('detail-sql-preview').textContent=plan.valid?plan.sql:'-- 按侦察目标选择回波与监听词，实时组合 SQL。';
  $('run-detail-search').disabled=busy||!state?.reconLocked||state.hybridReady||!plan.valid||!both;
  $('run-detail-search').textContent=state?.hybridReady?'线索已取得':both?'执行混合检索 →':'先选择回波与监听资料';
  $('detail-feedback').textContent=state?.detailFeedback||'对照侦察目标，分别选择回波与监听资料；选错可调整后重查。';
  const nodes=[];
  if(state?.detailComparisons){const c=state.detailComparisons;nodes.push(element('p','briefing-findings',`仅回波 ${c.vector} 条候选 → 仅监听 ${c.fulltext} 条候选 → 混合条件 ${c.hybrid} 条观测`));}
  for(const item of state?.detailRows||[]){
    const card=element('article','briefing-source');
    card.append(element('h4','',item.source),element('p','',item.clue_text));
    const distance=item.distance==null?'尚未比较回波':`回波距离 ${Number(item.distance).toFixed(3)} ≤ 0.42`;
    card.append(element('p','section-help',`${state.lastDetailInput?.keyword?`监听词「${state.lastDetailInput.keyword}」命中记录；`:''}${distance}`));
    const raw=element('p','section-help',`依据原文：${item.body.slice(0,160)}${item.body.length>160?'…':''}`);card.append(raw);nodes.push(card);
  }
  $('detail-result-list').replaceChildren(...nodes);
  $('accept-briefing').disabled=busy||!state?.hybridReady;
  $('accept-briefing').textContent=state?.hybridReady?`带${queriedClues().length}条SQL线索出航`:'完成混合检索后出航';
}

function selectedBounds(sector = state?.activeSector) {
  const record = state?.resultRows.find(row => row.sector_id === sector);
  return record ? boundsFromCells(record.cells) : sectorBounds(sector, boardSize());
}

function projectKnowledge(sector) {
  const bounds = selectedBounds(sector), knowledge = createKnowledge(boardSize());
  const inside = cell => cell.x >= bounds.minX && cell.x <= bounds.maxX && cell.y >= bounds.minY && cell.y <= bounds.maxY;
  for (const observation of Object.values(state.globalShots)) {
    if (!inside(observation)) continue;
    recordShot(knowledge, {...observation, x: observation.x - bounds.minX, y: observation.y - bounds.minY,
      sunkCells: observation.sunkCells.filter(inside).map(cell => ({x: cell.x - bounds.minX, y: cell.y - bounds.minY}))});
  }
  return knowledge;
}

function renderTheater() {
  const valid = canEnterSea(state);
  const row = valid ? state.resultRows[0] : null;
  $('sector-choice').disabled = true;
  $('engage-sector').disabled = busy || state?.phase !== 'player' || !valid || !state.mapPin || Boolean(state.activeSector);
  $('engage-sector').textContent = state?.activeSector ? '已抵达交战海域' : '就是这里，出航！';
  $('active-sector-name').textContent = state?.activeSector ? `A～${chartColumn(boardSize()-1)} / 1～${boardSize()}` : '尚未抵达';
  $('theater-hint').textContent = valid ? 'seekdb 已自动定位目标海域，直接点击「就是这里，出航！」。' : '先完成情报检索，再定位出航。';
  $('map-target-readout').textContent = row ? `SQL已定位：${chartColumn(Math.floor(Number(row.map_x)))}${Math.floor(Number(row.map_y))+1} 附近` : '参考坐标等待 seekdb 查询。';
  $('map-coordinates').textContent = state?.mapPin ? `已根据查询结果自动标记：${chartColumn(Math.floor(state.mapPin.x))}${Math.floor(state.mapPin.y)+1}` : '等待查询结果自动定位。';
}

async function engageSector(sector) {
  if (state.phase !== 'player' || !canEnterSea(state) || state.activeSector) return;
  if(!state.hybridReady)throw new Error('先完成两份情报的混合检索。');
  const row=state.resultRows[0];
  if(!Number.isFinite(Number(row.map_x)) || !Number.isFinite(Number(row.map_y))) throw new Error('查询结果缺少有效导航坐标，请重新检索。');
  state.mapPin={x:Number(row.map_x),y:Number(row.map_y)};
  state.activeSector = state.resultRows[0].sector_id; state.proposedSector = state.activeSector;
  state.knowledge = projectKnowledge(state.activeSector); state.sectorKnowledge[state.activeSector] = state.knowledge;
  targets = []; $('map-feedback').textContent = '';
  await addNote('move', `完成海图定位，进入${boardSize()}×${boardSize()}战场。`);
  await saveState(); notify('抵达！先看手册里的 SQL 线索，再选点或使用雷达。', 'hit'); setView('battle');
}

function drawTheater(now) {
  const canvas = $('theater-canvas'), ctx = canvas.getContext('2d'), w=canvas.width, h=canvas.height;
  const world=boardSize()*2.5, pad=28, cw=w-pad*2, ch=h-pad*2;
  ctx.imageSmoothingEnabled=false; ctx.fillStyle='#17485f'; ctx.fillRect(0,0,w,h);
  ctx.font='12px PixelChinese, monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
  for(let i=0;i<=world;i++) {
    const x=pad+i/world*cw, y=pad+i/world*ch;
    ctx.strokeStyle=i%2 ? '#21566c' : '#2d6377'; ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x,pad);ctx.lineTo(x,h-pad);ctx.moveTo(pad,y);ctx.lineTo(w-pad,y);ctx.stroke();
    if(i<world && (world<=20 || i%2===0)) {
      ctx.fillStyle='#ecf1dc';ctx.fillText(chartColumn(i),pad+(i+.5)/world*cw,13);
      ctx.fillText(String(i+1),13,pad+(i+.5)/world*ch);
    }
  }
  if(state?.reconLocked && state.resultRows[0]) {
    // 背景只使用SQL返回的战场范围；不读取任何舰船格。
    const row=state.resultRows[0], b=boundsFromCells(row.cells);
    ctx.fillStyle='#65c7b925';ctx.fillRect(pad+b.minX/world*cw,pad+b.minY/world*ch,b.width/world*cw,b.height/world*ch);
  }
  if(state?.mapPin) {
    const x=pad+state.mapPin.x/world*cw,y=pad+state.mapPin.y/world*ch;
    ctx.fillStyle='#ffc888';ctx.fillRect(x-8,y-1,17,3);ctx.fillRect(x-1,y-8,3,17);
    ctx.strokeStyle='#ffc888';ctx.strokeRect(x-6,y-6,13,13);
  }
  if(fx?.side==='theater') {ctx.fillStyle='#a4e5ce66';ctx.fillRect(pad+(now-fx.start)/fx.duration*cw,pad,3,ch);}
}

function requiredTargets() {
  return state?.weapon === 'normal' ? ordinaryShots() : state?.weapon === 'dual' ? 2 : state?.weapon === 'triple' ? 3 : 1;
}
function predictedArea(anchor = targets[0]) {
  if (!anchor || !state) return [];
  if (['normal','dual','triple'].includes(state.weapon)) return [...targets];
  if (state.weapon === 'radar') return [{x:anchor.x,y:anchor.y},{x:anchor.x+1,y:anchor.y},{x:anchor.x,y:anchor.y+1},{x:anchor.x+1,y:anchor.y+1}].filter(c=>c.x<boardSize()&&c.y<boardSize());
  return weaponPatternAtAnchor(state.weapon, anchor, boardSize());
}

function weaponAvailable(id) {
  if (id === 'normal') return true;
  if (['radar','dual','triple'].includes(id)) return Boolean(state?.ammo[id] > 0);
  if (id === 'piercing') return hasMedal('piercing') && !state.specialUsed.piercing;
  if (id.startsWith('distributed')) return hasMedal('distributed') && !state.specialUsed.distributed
    && (id !== 'distributed_ii' || hasMedal('ultimate'));
  return false;
}

function weaponUnlocked(id) {
  if(!state)return false;
  if(id==='normal')return true;
  if(['radar','dual','triple'].includes(id))return LEVELS[campaign.level-1][`${id}Charges`]>0;
  if(id==='piercing')return hasMedal('piercing');
  if(id==='distributed_i')return hasMedal('distributed');
  if(id==='distributed_ii')return hasMedal('distributed')&&hasMedal('ultimate');
  return false;
}

async function weaponArea() {
  if (state.weapon === 'normal') return [...targets];
  if (['dual','triple'].includes(state.weapon)) {
    if (!weaponAvailable(state.weapon)) throw new Error('本关该弹药已用尽');
    state.ammo[state.weapon]--; return [...targets];
  }
  if (!weaponAvailable(state.weapon)) throw new Error('本关该武器尚未解锁或弹药已用尽');
  const pattern = predictedArea();
  const sql = `SELECT x,y FROM sea_cells\nWHERE ${pattern.map(cell => `(x=${cell.x} AND y=${cell.y})`).join(' OR ')}\nORDER BY x,y;`;
  const result = await db.query(sql);
  state.lastWeaponSql = sql;
  notify(`${weaponName(state.weapon)}：${result.rows.length}个落点。`);
  state.specialUsed[state.weapon === 'piercing' ? 'piercing' : 'distributed'] = true;
  return result.rows.map(row => ({x: Number(row.x), y: Number(row.y)}));
}

async function scanRadar() {
  if (!weaponAvailable('radar')) throw new Error('本关雷达额度已用尽');
  const area=predictedArea();
  if(area.length!==4) throw new Error('雷达需要完整2×2区域，请向海图内侧选点');
  const calibrated=hasProtocol('radar_filter');
  const sql=`SELECT x,y,CASE WHEN jammed=1 AND ${calibrated?1:0}=0 THEN NULL ELSE occupied END AS occupied,CASE WHEN jammed=1 THEN NULL ELSE occupied END AS raw_occupied FROM radar_echoes\nWHERE ${area.map(c=>`(x=${c.x} AND y=${c.y})`).join(' OR ')}\nORDER BY y,x;`;
  const result=await db.query(sql); state.lastWeaponSql=sql; state.ammo.radar--;
  state.radarFindings=result.rows.map(row=>({x:Number(row.x),y:Number(row.y),occupied:row.occupied==null?null:Number(row.occupied),rawOccupied:row.raw_occupied==null?null:Number(row.raw_occupied)}));
  state.lastRadarSql=sql;
  for(const cell of state.radarFindings) state.radarKnowledge[key(cell)]={...cell,round:state.round};
  await animate('scan',area,'enemy','radar',600);
  const echoes=state.radarFindings.filter(c=>c.occupied===1);
  const quiet=state.radarFindings.filter(c=>c.occupied===0);const unknown=state.radarFindings.filter(c=>c.occupied==null);
  const text=`扫描四格：${echoes.length}格有回波${echoes.length?`（${echoes.map(coord).join('、')}）`:''}，${quiet.length}格无回波${unknown.length?`，${unknown.length}格受扰未知`:''}。`;
  renderRadarReport();
  if(hasProtocol('radar_sweep')&&enemyFirePlan(campaign.level,state.round).shots===2){state.sweepRound=state.round;notify('扫频命中装填窗口，本轮敌方副炮受抑制。');}
  if(calibrated)notify(`混合检索滤波：本次恢复${state.radarFindings.filter(r=>r.rawOccupied==null&&r.occupied!=null).length}格受扰回波。`);
  await addNote('radar',text);notify(text);targets=[];state.weapon='normal';await enemyResponse();
}

async function setMapMarks(kind,cells=targets,source='manual'){
  if(state?.phase!=='player'||!state.activeSector)return;
  if(!['flag','question','clear'].includes(kind))throw new Error('请选择红旗、问号或清除标记。');
  const chosen=cells.filter(c=>Number.isInteger(c.x)&&Number.isInteger(c.y)&&c.x>=0&&c.y>=0&&c.x<boardSize()&&c.y<boardSize()&&!state.knowledge.shots[key(c)]);
  if(!chosen.length){notify('先选择一个尚未投弹的格子，再放置标记。');return;}
  for(const cell of chosen){if(kind==='clear')delete state.mapMarks[key(cell)];else state.mapMarks[key(cell)]={...cell,kind,source};}
  targets=[];await saveState();notify(`${kind==='flag'?'已插红旗排除':kind==='question'?'已标白色问号':'已清除标记'}：${chosen.map(coord).join('、')}。不消耗炮弹和回合。`);
}

function hasProtocol(code){return Boolean(state?.support?.protocols.some(p=>p.code===code));}

async function requestSupportPlan(){
  const weapon=hasProtocol('radar_recommend')?'radar':state.weapon;
  if(!['radar','distributed_i','distributed_ii','piercing'].includes(weapon))throw new Error('先选择雷达或多点武器，再进行战术推演。');
  if(!weaponAvailable(weapon))throw new Error('该武器本关库存不足。');
  await db.exec('DELETE FROM naval_tactic_cells');await db.exec('DELETE FROM naval_public_shots');
  const cells=state.support.cells;
  if(cells.length)await db.exec(`INSERT INTO naval_tactic_cells VALUES ${cells.map(c=>`(${quote(deal.missionId)},${quote(state.activeSector)},${c.x},${c.y},${quote(c.tag)})`).join(',')}`);
  const shots=Object.values(state.knowledge.shots);
  if(shots.length)await db.exec(`INSERT INTO naval_public_shots VALUES ${shots.map(c=>`(${quote(deal.missionId)},${quote(state.activeSector)},${c.x},${c.y},${quote(c.state)})`).join(',')}`);
  const sql=planSql({weapon,size:boardSize(),missionId:deal.missionId,sectorId:state.activeSector,limit:2});
  const result=await db.query(sql);state.lastTacticSql=sql;state.tacticPlans=result.rows.map(r=>({...r,weapon}));
  await saveState();notify(`seekdb 已比较公开待查区域，返回${result.rows.length}个覆盖方案。`);
}


async function fire() {
  if (state.phase !== 'player') return;
  if (!canEnterSea(state) || !state.activeSector) throw new Error('请先完成真实SQL检索和海图定位');
  if (state.weapon === 'radar') {await scanRadar(); return;}
  const expected = requiredTargets();
  if (targets.length !== expected) throw new Error(`请先选择${expected}个攻击坐标`);
  if (state.weapon === 'normal') {
    const fired=new Set(state.shotHistory.filter(shot=>shot.side==='player').map(key));
    if(targets.some(cell=>fired.has(key(cell)))) throw new Error('这个位置已经投过炸弹，请选择新坐标。');
  }
  const area = await weaponArea();
  const check = validateSalvo(area, ['normal','dual','triple'].includes(state.weapon) ? expected : 9, boardSize());
  if (!check.ok) throw new Error(check.errors.join('，'));
  state.phase = 'attacking';

  render();
  await animate('launch', area, 'enemy', state.weapon, state.weapon === 'normal' ? 500 : 750);
  for (const cell of area) {
    const bounds = selectedBounds(), enemyBounds = sectorBounds(state.enemySector, boardSize());
    const shotNumber = state.shotHistory.filter(item => item.side === 'player').length;
    const aim = resolveAim({selectedBounds: bounds, targetBounds: enemyBounds, cell,
      rng: createRng(`${campaign.seed}|aim|${campaign.level}|${state.round}|${shotNumber}|${state.activeSector}`)});
    const receipt = {side: 'player', sector: state.activeSector, round: state.round, x: cell.x, y: cell.y, drift: aim.drift, kind: aim.drift ? 'drift' : 'pending'};
    state.shotHistory.push(receipt);
    if (aim.drift) {
      state.levelScore -= 3;
      await animate('shot', [cell], 'enemy', 'drift', 360);
      notify(`我方 ${state.activeSector}·${coord(cell)}：打偏！火控定位偏差，不能据此排除该格。`, 'warning');
      await addNote('shot', `${state.activeSector}·${coord(cell)} 打偏（不标记空格）`);
      continue;
    }
    const result = aim.target ? applyShot(state.enemy, aim.target) : {valid: true, kind: 'miss',
      cellCleared: true, cellHp: 0, shipId: null, sunkCells: [], defeated: false};
    if (!result.valid) {receipt.kind = 'repeated'; continue;}
    receipt.kind = result.kind;
    if(result.kind==='sunk'&&hasProtocol('relay_target')&&result.sunkCells.length===state.support.protocols.find(p=>p.code==='relay_target').target_length){state.relayDisabled=true;notify('我方切断副炮中继！敌方后续双炮停止。','hit');}
    const globalResult = {...result, x: bounds.minX + cell.x, y: bounds.minY + cell.y,
      sunkCells: result.sunkCells.map(part => ({x: enemyBounds.minX + part.x, y: enemyBounds.minY + part.y}))};
    state.globalShots[key(globalResult)] = globalResult;
    if (result.kind === 'sunk') for (const part of globalResult.sunkCells) state.globalShots[key(part)] = {...globalResult, ...part};
    state.knowledge = projectKnowledge(state.activeSector); state.sectorKnowledge[state.activeSector] = state.knowledge;
    state.levelScore += result.kind === 'sunk' ? 130 : result.kind === 'hit' ? 45 : -3;
    await animate('shot', [cell], 'enemy', result.kind, result.kind === 'sunk' ? 1000 : area.length > 2 ? 420 : 600);
    notify(`我方 ${state.activeSector}·${coord(cell)}：${{miss: '落空', hit: '命中', sunk: '击沉敌舰'}[result.kind]}。`, result.kind === 'miss' ? 'info' : 'hit');
    await addNote('shot', `${state.activeSector}·${coord(cell)} ${result.kind === 'miss' ? '落空' : result.kind === 'sunk' ? '击沉' : '命中'}`);
    if (result.defeated) { await victory(); return; }
  }
  targets = []; state.weapon = 'normal';
  await enemyResponse();
}

async function enemyResponse() {
  state.phase = 'enemy'; render();
  const level = LEVELS[campaign.level - 1];
  const count = supportEnemyPlan({level:campaign.level,round:state.round,relayDisabled:state.relayDisabled,sweepRound:state.sweepRound}).shots;
  const shots = chooseEnemyShots(state.aiKnowledge, count, createRng(`${campaign.seed}|ai|${campaign.level}|${state.round}`), {pursuit: level.enemyPursuit});
  if (count > 1) notify('敌军双炮齐射。', 'warning');

  await animate('launch', shots, 'fleet', 'normal', 480);
  for (const cell of shots) {
    const result = applyShot(state.player, cell);
    if (!result.valid) throw new Error('敌方选择了无效炮击格');
    recordShot(state.aiKnowledge, result);
    state.shotHistory.push({side: 'enemy', round: state.round, kind: result.kind, x: cell.x, y: cell.y});
    if (result.kind !== 'miss') state.wasHit = true;
    await animate('shot', [cell], 'fleet', result.kind, result.kind === 'sunk' ? 1000 : 600);
    notify(`敌方 ${coord(cell)}：${result.kind === 'miss' ? '落空' : result.kind === 'sunk' ? '我方舰船沉没' : result.cellCleared ? '我方中弹' : '装甲受损，尚未击穿'}。`, result.kind === 'miss' ? 'info' : 'warning');
    if (result.defeated) { await lose('我方舰队已覆灭。'); return; }
  }

  if (state.round >= LIMITS[campaign.level - 1]) { await lose('作战轮数耗尽，敌军完成封锁。'); return; }
  state.round += 1; state.phase = 'player';
  await saveState();
}

async function victory() {
  if(state.phase==='victory')return;
  state.phase = 'victory'; view = 'result';
  const level = LEVELS[campaign.level - 1];
  campaign.score += Math.max(0, state.levelScore) + 500 + (LIMITS[campaign.level - 1] - state.round) * 12;
  state.pendingRewards=[level.reward,...(level.extraRewards||[])].filter(Boolean);
  state.rewardCards=getLevelRewards(campaign.level);state.rewardsConfirmed=false;
  await db.exec(`MERGE TABLE ${tableNames.notes} INTO ${campaign.notesTable} STRATEGY THEIRS`);
  campaign.summaryRows = (await db.query(`SELECT kind, COUNT(*) AS total FROM ${campaign.notesTable} GROUP BY kind ORDER BY kind`)).rows;
  await saveState();
  notify(`第${campaign.level}关胜利。${level.reward ? `获得“${MEDALS[level.reward][0]}”勋章。` : '六关战役完成。'}`, 'hit');
  showResult(campaign.level === 6 ? '六海域突破 · 战役完成' : '海域肃清 · 请领取勋章与装备',
    level.reward ? `“${MEDALS[level.reward][0]}”：${MEDALS[level.reward][1]}` : `本次海图 ${campaign.seed}，战术评分 ${campaign.score}；数据库汇总战役笔记 ${campaign.summaryRows.reduce((sum, row) => sum + Number(row.total), 0)} 条。`,
    campaign.level < 6 ? '携勋章进入下一关' : '全新海图再出航');
}

async function confirmRewards() {
  if(state?.phase!=='victory' || state.rewardsConfirmed)return;
  if(state.pendingRewards.includes('mysql')) {
    const sql="INSERT INTO capabilities(owner,skill,every_n) SELECT 'player',skill,every_n FROM capabilities WHERE owner='enemy' AND skill='double_fire' ON DUPLICATE KEY UPDATE every_n=VALUES(every_n)";
    await db.exec(sql);state.lastSql=sql;
  }
  for(const reward of state.pendingRewards)if(!campaign.medals.includes(reward))campaign.medals.push(reward);
  state.rewardsConfirmed=true;await saveState();
  notify(campaign.level<6?'奖励已领取！勋章和新装备在下一关生效。':'战果已确认，六海域战役完成。','hit');
}

async function advanceFromResult() {
  if(state?.phase==='victory' && !state.rewardsConfirmed) {notify('请先确认领取本关勋章与装备。','warning');return;}
  if(state.phase==='defeat')await rewind();
  else if(state.phase==='victory' && campaign.level<6){campaign.level++;await prepareLevel();}
  else await startCampaign();
}

function iconCanvas(icon,label) {
  const canvas=element('canvas','pixel-item-icon');canvas.width=canvas.height=32;
  canvas.dataset.pixelIcon=icon;canvas.setAttribute('role','img');canvas.setAttribute('aria-label',label);
  return canvas;
}

function paintIcon(canvas,id,frame=0) {
  if(canvas.width!==32)canvas.width=32;if(canvas.height!==32)canvas.height=32;
  const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,32,32);
  drawPixelIcon(ctx,id,(32-ICON_SIZE)/2,(32-ICON_SIZE)/2,1,frame);
}

function renderRewards() {
  const gallery=$('reward-gallery');if(!gallery)return;
  const won=state?.phase==='victory';gallery.hidden=!won;
  const nodes=[];
  if(won)for(const card of state.rewardCards) {
    const item=element('article','reward-card');item.dataset.rewardKind=card.kind;item.dataset.rewardId=card.id;
    item.append(iconCanvas(card.icon,`${card.title}像素图标`));
    const text=element('div','reward-content');
    text.append(element('span','reward-type',card.kind==='medal'?'获得勋章':card.kind==='weapon'?'解锁新武器':'解锁战术技能'),element('h5','',card.title));
    text.append(element('p','reward-effect',`游戏效果：${card.description}`));
    if(card.featureDescription){
      text.append(element('h6','reward-feature-title',`seekdb 特性 · ${card.featureTitle}`),element('p','reward-feature',card.featureDescription));
      const link=element('a','reward-feature-link','查看官方介绍 ↗');link.href=card.featureUrl;link.target='_blank';link.rel='noopener noreferrer';text.append(link);
    }
    if(card.pattern)text.append(element('p','reward-pattern',`${card.pattern.size}×${card.pattern.size}范围 · ${card.pattern.cells.length}点`));
    item.append(text);nodes.push(item);
  }
  if(won && !nodes.length) {
    const item=element('article','reward-card');item.append(iconCanvas('trophy','六海域通关奖杯'));
    const summary=element('div','reward-content');summary.append(element('h5','','六海域突破'),element('p','',`本次战役共收获${campaign.medals.length}枚勋章。确认战果，开启新的海域。`));item.append(summary);nodes.push(item);
  }
  gallery.replaceChildren(...nodes);
  $('confirm-rewards').hidden=!won;$('confirm-rewards').disabled=busy||!won||state.rewardsConfirmed;
  $('confirm-rewards').textContent=state?.rewardsConfirmed?'已确认领取':campaign?.level===6?'确认战果':'确认领取勋章与装备';
  $('reward-feedback').textContent=!won?'':state.rewardsConfirmed?'已领取，可以继续出航。':'请查看上方勋章、新武器与技能说明，再确认领取。';
  $('next-level').disabled=busy||won&&!state.rewardsConfirmed;
}

async function lose(reason) {
  state.phase = canRewind() ? 'defeat' : 'gameover'; view = 'result';
  await saveState();
  notify(reason + (canRewind() ? '本关还可重开一次。' : '本轮战役结束。'), 'error');
  showResult(canRewind() ? '舰队失守 · 尚有一次试错机会' : 'Game Over · 本轮战役结束',
    reason + (canRewind() ? FORK_DESCRIPTION : '重新出航将清空本轮勋章，生成不同的第一关。'),
    canRewind() ? '试错机会 · 重开本关' : '从新的第一关出发');
}

async function rewind() {
  if (!state?.deploymentConfirmed || !tableNames?.checkpoint) throw new Error('请先确认舰队部署，再使用试错机会。');
  if (!canRewind() || !['player', 'defeat'].includes(state.phase)) throw new Error('本关没有可用的试错机会：尚未解锁、已经使用、仍在冷却或当前无法行动。');
  await db.exec(`MERGE TABLE ${tableNames.notes} INTO ${campaign.notesTable} STRATEGY THEIRS`);
  const merged = await db.query(`SELECT id,level_no,round_no,kind,body FROM ${campaign.notesTable} ORDER BY id`);
  notes = merged.rows.map(row => ({id: row.id, level: Number(row.level_no), round: Number(row.round_no),
    kind: row.kind, message: row.body, previous: true})).reverse();
  const nextLive = `live_restore_${campaign.id}_${campaign.level}_${++serial}`;
  const forkSql = `FORK TABLE ${tableNames.checkpoint} TO ${nextLive}`;
  await db.exec(forkSql);
  const restored = await db.query(`SELECT state_json FROM ${nextLive} WHERE id=1`);
  state = JSON.parse(restored.rows[0].state_json);
  state.enemy = createEnemyFleet({level: campaign.level, seed: state.enemySeed});
  state.enemySector = generateEvidence({fleet: state.enemy, level: campaign.level, round: 1, seed: campaign.seed}).truth.targetSector;
  if (state.activeSector) state.knowledge = state.sectorKnowledge[state.activeSector];
  state.phase = 'player'; view = 'intel'; tableNames.live = nextLive;
  const nextNotes = `notes_after_${campaign.id}_${campaign.level}_${serial}`;
  await db.exec(`FORK TABLE ${campaign.notesTable} TO ${nextNotes}`); tableNames.notes = nextNotes;
  targets=[];detailSelection={sample:'',keyword:''};state.lastSql=forkSql;
  await dealEvidence(); await saveState();
  campaign.rewinds[campaign.level] = 1; campaign.lastForkUseLevel = campaign.level;
  $('result-panel').hidden = true;
  notify('时间线已重置。敌舰布局不变，前分支笔记已 Merge 保留；本关重开次数剩余 0。', 'warning');
  window.scrollTo(0, 0);
}

function showResult(title, message, action) {
  $('result-title').textContent = title; $('result-copy').textContent = message;
  $('next-level').textContent = action;
  $('retry-level').textContent = '结束本轮，生成新战役';
  view = 'result'; $('result-panel').hidden = false;
  window.scrollTo(0, 0);
}

function renderCards() {
  const host=$('evidence-list'),task=reconTask();
  if(!task||state?.phase==='deploy'){host.replaceChildren(element('p','record-placeholder','确认部署后接收本关资料。'));return;}
  host.replaceChildren(...task.groups.map(group=>{
    const section=element('section','retrieval-group');section.dataset.reconKind=group.kind;
    section.append(element('h4','retrieval-group-title',group.label));
    const pair=element('div','retrieval-pair');
    for(const card of group.choices){
      const selected=cards.has(card.id),button=element('button',`evidence-item${selected?' selected':''}`);
      button.type='button';button.dataset.cardId=card.id;button.setAttribute('aria-pressed',String(selected));
      button.append(element('strong','',card.description),element('span','evidence-acquisition',`获取渠道：${card.acquisition}`));
      button.disabled=busy||state.phase!=='player'||state.queryUsed;
      button.onclick=()=>selectReconCard(card.id);pair.append(button);
    }
    section.append(pair);return section;
  }));
}

function renderMethods() {
  $('ability-list').replaceChildren(...availableMethods().map(method => {
    const node = element('div', `ability-item${abilities.has(method.id)?' selected':''}`);
    node.dataset.ability=method.id;
    node.append(element('strong','',method.name),element('small','',method.detail));
    return node;
  }));
}

function renderResult() {
  const host = $('result-list');
  if (!state?.resultRows.length && !state?.queryUsed) { host.replaceChildren(element('p', 'record-placeholder', '选择资料与能力后执行真实 SQL。')); return; }
  if (!state.resultRows.length) { host.replaceChildren(element('p', '', '返回空集。资料之间可能矛盾，请调整后重查。')); return; }
  const summary = element('p', 'region-summary', `返回 ${new Set(state.resultRows.map(row => row.sector_id)).size} 个 ${boardSize()}×${boardSize()} 窗口；不包含舰位。`);
  const table = element('table');
  const head = table.createTHead().insertRow(); ['海区', '全局范围', '来源'].forEach(text => head.append(element('th', '', text)));
  const body = table.createTBody();
  state.resultRows.forEach(row => {
    const bounds = boundsFromCells(row.cells);
    const range = `${chartColumn(bounds.minX)}～${chartColumn(bounds.maxX)}列 / ${bounds.minY+1}～${bounds.maxY+1}行`;
    const line = body.insertRow(); [row.sector_id, range, row.source].forEach(value => line.append(element('td', '', value)));
  });
  host.replaceChildren(summary, table);
}

function selectionStatus() {
  const selected=deal?.cards.filter(card=>cards.has(card.id)) || [];
  const labels={range:'时间范围',keyword:'监听口令',vector:'回波样本',filter:'任务与来源'};
  const missing=[];
  const required=availableMethods();
  for(const method of required) {
    if(!selected.some(card=>card.kind===method.kind))missing.push(`${labels[method.kind]}资料`);
    if(!abilities.has(method.id))missing.push(method.name);
  }
  return {ready:missing.length===0,missing,required};
}

function render() {
  $('start-game').disabled = busy || !db;
  $('extra-query').hidden = true;
  $('fleet-controls').hidden = Boolean(state && state.phase !== 'deploy');
  document.querySelector('.attack-console').hidden = !state || state.phase === 'deploy';
  $('shrink-toggle').disabled = busy || !hasMedal('lightweight') || state?.phase !== 'deploy';
  for (const id of ['random-fleet', 'rotate-ship', 'confirm-fleet']) $(id).disabled = busy || state?.phase !== 'deploy';
  $('level-name').textContent = campaign ? `0${campaign.level} / ${LEVELS[campaign.level - 1].title}` : '等待出航';
  $('level-intro').textContent = campaign ? LEVELS[campaign.level - 1].briefing : '先部署，再检索，用证据推开海雾。';
  const phaseNames = {deploy: '部署舰队', player: '我方行动', attacking: '我方炮击', enemy: '敌方炮击', victory: '本关胜利', defeat: '最后试错机会', gameover: '战役结束'};
  $('turn-label').textContent = state ? `${phaseNames[state.phase]} · ${state.round}/${LIMITS[campaign.level - 1]}轮` : '引擎准备中';
  $('seed-label').textContent = campaign?.seed ?? '尚未出航';
  $('score-label').textContent = String((campaign?.score ?? 0) + (state?.phase === 'victory' ? 0 : Math.max(0, state?.levelScore ?? 0))).padStart(4, '0');
  $('stage-list').replaceChildren(...LEVELS.map(level => {
    const node = element('span', `stage-step ${campaign?.level === level.id ? 'active' : campaign?.level > level.id ? 'done' : ''}`, `0${level.id}`);
    node.title = level.title; return node;
  }));
  $('badge-list').replaceChildren(...(campaign?.medals ?? []).map(id => {
    const node = element('span', 'badge', `✦ ${MEDALS[id][0]}`); node.title = MEDALS[id][1]; return node;
  }));
  $('placement-hint').textContent = state?.phase === 'deploy' ? `已选第${selectedShip + 1}艘舰，船头${coord(state.player.ships[selectedShip].cells[0])}。点空白格指定船头；方向键移动。` : '';
  $('fleet-caption').textContent = state ? `我方剩余耐久 ${remainingHp(state.player)}/${state.player.ships.reduce((sum, ship) => sum + ship.cells.reduce((n,cell)=>n+cell.maxHp,0), 0)} · ${hasMedal('lightweight') ? '轻量舰队' : '标准舰队'}` : '部署自己的舰队。';
  $('enemy-caption').textContent = state?.reconLocked ? `敌方海图 · ${boardSize()}×${boardSize()}` : '敌舰情报等待检索';
  renderCards(); renderMethods(); renderResult(); renderTheater(); renderBriefing();
  const plan = currentPlan();
  const selection=selectionStatus();
  const task=reconTask();
  $('mission-title').textContent=task?`任务目标 · ${task.title}`:'任务目标';
  if($('mission-objective'))$('mission-objective').textContent=task?.goal||'确认舰队部署后领取任务。';
  if($('selection-checklist'))$('selection-checklist').textContent=selection.ready?'资料已配齐，请对照任务目标核对 SQL 后执行。':`按目标逐项选择资料；还缺：${selection.missing.filter(item=>item.endsWith('资料')).join('、')}。`;
  $('sql-preview').textContent=plan.valid?plan.sql:'-- 选资料时自动加入对应检索能力，SQL 在这里实时生成。';
  $('query-meta').textContent=state?.queryUsed?`${state.resultRows.length}条 · ${state.lastMs.toFixed(1)} ms（实际SQL）`:'目标是判断依据。选错可调整，不消耗炮弹和海战回合。';
  $('run-query').disabled = busy || state?.phase !== 'player' || state.queryUsed || !plan.valid || !selection.ready;
  $('skip-query').disabled = busy || state?.phase !== 'player';
  $('skip-query').textContent = state?.queryUsed ? '继续选择海域' : '冒险盲选';
  $('rewind-button').disabled = busy || !canRewind() || !['player', 'defeat'].includes(state?.phase);
  $('rewind-button').hidden = !hasMedal('fork') || (campaign?.level ?? 0) < 3;
  $('rewind-button').textContent = hasMedal('fork') ? `试错机会 · ${campaign.rewinds[campaign.level] ? '本关已用' : campaign.lastForkUseLevel != null && campaign.level-campaign.lastForkUseLevel<3 ? `冷却至第${campaign.lastForkUseLevel+3}关` : '本关剩1次'}` : '第三关启用试错机会';
  $('rewind-button').title = FORK_DESCRIPTION;
  $('selection-hint').textContent = targets.length ? `已选 ${targets.map(coord).join('、')}${state?.weapon !== 'normal' ? `，覆盖${predictedArea().length}格` : ` / 本轮${ordinaryShots()}发`}` : `选择${requiredTargets()}个${state?.weapon === 'radar' ? '扫描锚点' : '目标'}。`;
  const needed = requiredTargets();
  $('fire-shot').disabled = busy || state?.phase !== 'player' || !state.activeSector || !state.reconLocked || targets.length !== needed || !weaponAvailable(state.weapon);
  $('fire-shot').textContent = state?.weapon === 'radar' ? '扫描四格 · 耗1轮' : !state || state.weapon === 'normal' ? `发射 ${ordinaryShots()} 枚炮弹` : `发射${weaponName(state.weapon)}`;
  $('clear-selection').disabled = !targets.length || busy;
  $('turn-hint').textContent = busy ? '战术终端正在执行，请稍候。' : state?.phase === 'player'
    ? `${state.queryUsed ? '情报已确认，选择攻击坐标或使用雷达。' : '先完成真实SQL检索和地图定位。'}${ordinaryShots() === 2 ? ' 当前为双炮回合。' : ''}`
    : '双方交替行动，雷达也占用一轮。';
  $('notebook').replaceChildren(...notes.slice(0, 24).map(note => element('p', `note-line${note.previous ? ' previous-note' : ''}`,
    `${note.previous ? '〔前分支〕' : ''}第${note.level}关·${note.round}轮 ${note.message}`)));
  const weaponSelect = $('weapon-choice');
  weaponSelect.disabled = busy || state?.phase !== 'player';
  for (const option of weaponSelect.options) {
    option.disabled = !state || !weaponAvailable(option.value);
    option.textContent=option.value==='normal'?`${ordinaryShots()===2?'MySQL兼容双响炮':'普通炮弹'} · 本轮${ordinaryShots()}发`:`${weaponName(option.value)} · ${!weaponUnlocked(option.value)?'未解锁':!weaponAvailable(option.value)?'已用':['radar','dual','triple'].includes(option.value)?`剩${state.ammo[option.value]}次`:'剩1发'}`;
  }
  weaponSelect.value = state?.weapon ?? 'normal';
  if($('weapon-choices')){
    const focused=document.activeElement?.dataset.weaponId;
    renderWeaponChoices({container:$('weapon-choices'),options:[...weaponSelect.options].map(o=>({value:o.value,label:o.textContent,disabled:weaponSelect.disabled||o.disabled,icon:WEAPON_INFO[o.value]?.icon||'normal'})),value:weaponSelect.value,onChoose:id=>{weaponSelect.value=id;weaponSelect.dispatchEvent(new Event('change'));}});
    if(focused)$('weapon-choices').querySelector(`[data-weapon-id="${focused}"]`)?.focus({preventScroll:true});
  }
  for(const id of ['mark-flag','mark-question','mark-clear'])$(id).disabled=busy||state?.phase!=='player'||!state?.activeSector;
  $('mark-sql-safe').hidden=!state?.support.safe.length||!state?.activeSector;
  $('mark-sql-safe').disabled=busy||state?.phase!=='player';
  const previewId=state?.weapon==='normal' && ordinaryShots()===2?'dual':state?.weapon || 'normal';
  if($('weapon-icon')) {
    $('weapon-icon').dataset.pixelIcon=WEAPON_INFO[previewId]?.icon || 'normal';
    $('weapon-description').textContent=state?.weapon==='normal' && ordinaryShots()===2?'MySQL兼容双响炮：本轮选择两个新坐标，一次齐射。':WEAPON_INFO[previewId]?.description || '';
  }

  $('weapon-direction').hidden = true;
  $('weapon-direction').textContent = state?.direction === 'vertical' ? '方向：纵向 ↓' : '方向：横向 →';
  renderFlow();renderRewards();
}

function setView(next) {
  if(next==='intel' && state?.reconLocked) next='briefing';
  if (['battle','theater'].includes(next) && !state?.reconLocked) next = 'intel';
  if (next === 'briefing' && !state?.reconLocked) next='intel';
  if (next === 'battle' && !state?.activeSector) next = 'theater';
  if (!state?.deploymentConfirmed && !['welcome','tutorial','result'].includes(next)) next='deploy';
  if (['theater','battle'].includes(next) && state?.reconLocked && !state.briefingAccepted) next='briefing';
  view = next; render();
  window.scrollTo({top: 0, behavior: 'instant'});
}

function weaponName(id) {
  return ({radar:'混合检索雷达',dual:'HTAP 双响炮',triple:'嵌入式三联炮',piercing:'异步向量索引导弹',distributed_i:'多模态扩展弹',distributed_ii:'OceanBase 分布式火力支援',distributed:'OceanBase 分布式火力支援'})[id] || '普通炮弹';
}

function queriedClues() {
  if (!state?.reconLocked) return [];
  const clues=new Map();
  for(const row of state.resultRows) {
    if(state.activeSector && row.sector_id!==state.activeSector) continue;
    try {for(const clue of JSON.parse(row.tactical_clues || '[]')) if(clue?.id && typeof clue.text==='string') clues.set(clue.id,clue);}
    catch { /* 坏资料不能用隐藏布局补齐。 */ }
  }
  for(const row of state.acquiredDetailRows || []) {
    if(isExtraClueKind(row.kind) && typeof row.clue_text==='string') clues.set(row.clue_id,{id:row.clue_id,kind:row.kind,text:row.clue_text});
  }
  return [...clues.values()].slice(0,LEVELS[campaign.level-1].clueLimit);
}

function tacticalRegion() {
  if (!state?.activeSector || !canEnterSea(state)) return [];
  const bounds = selectedBounds(), cells = new Map();
  for (const row of state.resultRows) {
    try {
      for (const part of JSON.parse(row.tactical_cells || '[]')) {
        const cell = {x: part.x - bounds.minX, y: part.y - bounds.minY};
        if (cell.x >= 0 && cell.x < boardSize() && cell.y >= 0 && cell.y < boardSize()) cells.set(key(cell), cell);
      }
    } catch { /* 异常资料不生成虚构活动带。 */ }
  }
  return [...cells.values()];
}

function renderRadarReport() {
  const host=$('radar-report');if(!host)return;
  const rows=state?.radarFindings || [];
  host.hidden=!rows.length;
  $('radar-summary').textContent=rows.length ? `扫描${rows.map(coord).join('、')}：${rows.filter(c=>c.occupied===1).length}格有回波，${rows.filter(c=>c.occupied===0).length}格无回波，${rows.filter(c=>c.occupied==null).length}格未知。` : '尚未扫描';
  $('radar-results').replaceChildren(...(rows.length ? [resultTable(rows.map(row=>({coordinate:coord(row),echo:row.occupied==null?'？ 受扰未知':row.occupied?'◆ 有回波':'◇ 无回波',raw:row.rawOccupied==null?'？ 原始回波受扰':row.rawOccupied?'有回波':'无回波'})),[['coordinate','坐标'],['raw','原始信号'],['echo','SQL结论']])] : []));
  $('radar-sql').textContent=state?.lastRadarSql || '';
}

function renderFlow() {
  document.body.dataset.view = view;
  if(!fx && $('battle-animation-label'))$('battle-animation-label').textContent=state?.phase==='player'?'我方回合':state?.phase==='enemy'?'敌方回合':'等待发射';
  $('screen-tabs').hidden = !state || ['welcome','tutorial','result'].includes(view);
  $('tactical-sidebar').hidden = !state || ['welcome','tutorial','deploy','result'].includes(view);
  $('recent-battle-log').replaceChildren(...logs.filter(item=>view!=='battle'||/^(我方|敌方|雷达)/u.test(item.message)).slice(0, 2).map(item => element('p', '', item.message.length > 32 ? item.message.slice(0, 31) + '…' : item.message)));
  $('quick-rule').textContent = view === 'battle' ? '○ 落空　✹ 命中　★ 击沉\n红旗：排除　白问号：存疑。\n普通炮不能重复投弹。' : view === 'intel' ? '先读任务目标，再逐项选择相符资料。' : 'SQL已自动定位，确认即可出航。';
  for (const screen of document.querySelectorAll('[data-screen]')) screen.hidden = screen.dataset.screen !== view;
  const fleetHost = $(view === 'deploy' ? 'deploy-slot' : 'battle-fleet-slot');
  if ($('fleet-panel').parentElement !== fleetHost) fleetHost.append($('fleet-panel'));
  const labels = {welcome: ['准备出航', '找出敌军，击沉舰队。'], tutorial: ['30秒上手', TUTORIAL[tutorialIndex][0]],
    deploy: ['调整舰队', '点舰身选船 → 点船头目标格；方向键移动，R绕船头旋转。'],
    intel: ['01 情报工作台', selectionStatus().ready?'资料已装入，核对SQL后执行。':'先看任务目标，再选相符资料。'],
    briefing: ['02 混合侦察', '按侦察目标选择回波和监听词，再执行混合 SQL。'],
    theater: ['03 作战海图', '查询结果已自动标记，确认即可出航。'],
    battle: ['04 战术海图', `点敌方海图选格，再发射${ordinaryShots() === 2 ? '两发' : '炮弹'}。`],
    result: ['战况报告', '携勋章继续出航。']};
  const [title, hint] = labels[view] ?? labels.welcome;
  $('flow-title').textContent = title; $('flow-hint').textContent = hint;
  $('flow-status').textContent = busy ? '正在执行…' : state ? `第${campaign.level}关 · 第${state.round}轮` : 'seekdb 大海戦';
  $('quick-start').disabled = busy || !db;
  $('tutorial-title').textContent = TUTORIAL[tutorialIndex][0]; $('tutorial-copy').textContent = TUTORIAL[tutorialIndex][1];
  $('tutorial-count').textContent = `${tutorialIndex + 1} / ${TUTORIAL.length}`;
  $('tutorial-next').textContent=tutorialIndex<TUTORIAL.length-1?'下一步':state?.deploymentConfirmed?'开始找情报':'开始布阵';
  for (const [id, target] of [['view-intel','intel'], ['view-theater','theater'], ['view-battle','battle']]) {
    $(id).disabled = busy || !state || ['victory','defeat','gameover'].includes(state.phase) || !state.deploymentConfirmed || (target !== 'intel' && !canEnterSea(state));
    if(id==='view-intel')$(id).textContent=state?.reconLocked?'情报解读':'情报';
    $(id).setAttribute('aria-current', view === target || target==='intel' && view==='briefing' ? 'step' : 'false');
  }
  $('view-deploy').disabled = busy || !state || Boolean(state.shotHistory.length) || !['player','deploy'].includes(state.phase);
  $('back-battle-button').hidden = !state?.activeSector || !['intel','theater'].includes(view);
  $('back-battle-button').disabled = busy;
  for (const id of ['recon-button','change-sector-button']) {$(id).hidden=true;$(id).disabled=true;}
  if (!state || ['welcome','tutorial','deploy','result'].includes(view)) recordsOpen = false;
  $('records-panel').hidden = !recordsOpen;
  $('toggle-records').setAttribute('aria-expanded', String(recordsOpen));
  $('toggle-records').textContent = recordsOpen ? '收起战报与笔记' : '展开战报与笔记';
  const executed=[state?.lastReconSql?`-- 海域定位 SQL\n${state.lastReconSql}`:''];
  const detailQueries=[...new Set((state?.acquiredDetailRows||[]).map(row=>row.retrievalSql).filter(Boolean))];
  detailQueries.forEach((sql,index)=>executed.push(`-- 更多线索 SQL ${index+1}\n${sql}`));
  if(state?.lastDetailSql && !detailQueries.includes(state.lastDetailSql)) executed.push(`-- 最近一次细节检索 SQL\n${state.lastDetailSql}`);
  if(state?.lastTacticSql)executed.push(`-- 战术推演 SQL\n${state.lastTacticSql}`);
  $('last-executed-sql').textContent=executed.filter(Boolean).join('\n\n') || '尚未执行检索 SQL。';
  const selected = state?.player.ships[selectedShip];
  $('selected-ship-name').textContent = selected ? `${selectedShip + 1}号舰 · ${selected.length}格` : '';
  $('selected-ship-direction').textContent = selected ? `${selected.cells[0].y === selected.cells.at(-1).y ? '横排 →' : '竖排 ↓'} · 船头 ${coord(selected.cells[0])}` : '';
  $('ship-list').replaceChildren(...(state?.player.ships ?? []).map((ship, index) => {
    const button = element('button', `ship-choice${index === selectedShip ? ' selected' : ''}`, `${index + 1}号舰 · ${ship.length}格`);
    button.type = 'button'; button.setAttribute('aria-pressed', String(index === selectedShip)); button.disabled = busy || state.phase !== 'deploy';
    button.addEventListener('click', () => {selectedShip = index; render();$('fleet-board').focus({preventScroll:true});}); return button;
  }));
  const clues=queriedClues(), clueHost=$('tactical-clues');
  const numbering=['一','二','三','四'];
  const clueNodes=clues.map((clue,index)=>{
    let text=clue.text.replace(/^开局(?:统计|观测)：/,'').replace(/舰格/g,'敌军舰格').replace(/完整舰/g,'完整敌军战舰');
    return element('p','clue-summary',`线索${numbering[index]||index+1}：敌方海图中，${text}`);
  });
  clueHost.replaceChildren(...(clueNodes.length?clueNodes:[element('p','clue-summary','线索等待 seekdb 实际查询。')]));
  $('spacing-battle-reminder').hidden=view!=='battle';
  renderRadarReport();
  let manifest=[];try {if(state?.reconLocked)manifest=JSON.parse(state.resultRows[0]?.fleet_manifest || '[]');}catch{/*不补隐藏情报。*/}
  const sunk=state?.knowledge.sunkShips || [];
  const remainingManifest=[...manifest];
  for(const ship of sunk){const i=remainingManifest.indexOf(ship.cells.length);if(i>=0)remainingManifest.splice(i,1);}
  $('enemy-fleet-status').textContent=manifest.length ? `剩${remainingManifest.length}艘 · 战舰长度：${remainingManifest.join('/') || '全部击沉'}` : '舰队资料等待 SQL';
  const period=state?.reconLocked ? Number(state.resultRows[0]?.enemy_fire_every || 0) : null;
  const livePlan=state?supportEnemyPlan({level:campaign.level,round:state.round,relayDisabled:state.relayDisabled,sweepRound:state.sweepRound}):{shots:1,nextShots:1};
  const {shots,nextShots}=livePlan;
  $('enemy-intent').textContent=period===null ? '敌方火力：等待检索' : `敌方本轮：${shots}发${nextShots===2 ? ' · 下轮双炮装填' : ''}`;
  $('enemy-intent').dataset.shots=String(shots===2 || nextShots===2 ? 2 : 1);
  $('battle-intel-hint').textContent = tacticalRegion().length ? '绿色活动带：有舰队活动，带外仍可能有敌舰。' : '等待 SQL 返回局部线索。';
  $('sector-summary').textContent = state?.resultRows.length ? `${new Set(state.resultRows.map(row => row.sector_id)).size} 个候选海域 · 每片${boardSize()}×${boardSize()}` : '等待 seekdb 确认海域。';
  const names = {miss: '落空', hit: '命中', sunk: '击沉', drift: '打偏，仍未知', repeated: '已探测'};
  const playerHistory = (state?.shotHistory ?? []).filter(shot => shot.side === 'player');
  const lastPlayer = playerHistory.at(-1), lastEnemy = state?.shotHistory.filter(shot => shot.side === 'enemy').at(-1);
  $('player-last-shot').textContent = lastPlayer ? `我方 ${coord(lastPlayer)}：${names[lastPlayer.kind] || (lastPlayer.drift ? names.drift : '已发射')}` : '我方：等待开炮';
  $('enemy-last-shot').textContent = lastEnemy ? `敌方 ${coord(lastEnemy)}：${names[lastEnemy.kind] || '已攻击'}` : '敌方：尚未攻击';
  $('shot-history').replaceChildren(...playerHistory.slice().reverse().map(shot => element('p', `shot-entry ${shot.kind || ''}`,
    `${shot.round || 1}轮 ${shot.sector}·${coord(shot)} ${names[shot.kind] || (shot.drift ? names.drift : '已发射')}`)));
}

function remainingHp(fleet) { return fleet.ships.reduce((sum, ship) => sum + ship.cells.reduce((hp, cell) => hp + cell.hp, 0), 0); }

function boardGeometry(canvas) {
  const n = boardSize(), step = Math.floor(Math.min((canvas.width - 24) / n, (canvas.height - 24) / n));
  return {n, step, mx: Math.floor((canvas.width - step * n) / 2), my: Math.floor((canvas.height - step * n) / 2)};
}

function boardPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect(), {n, step, mx, my} = boardGeometry(canvas);
  const x = Math.floor(((event.clientX - rect.left) * canvas.width / rect.width - mx) / step);
  const y = Math.floor(((event.clientY - rect.top) * canvas.height / rect.height - my) / step);
  return x >= 0 && x < n && y >= 0 && y < n ? {x, y} : null;
}

function selectEnemy(cell) {
  if (!cell || busy || state?.phase !== 'player' || !state.activeSector) return;
  const previous = state.knowledge.shots[key(cell)];
  if (state.weapon === 'normal' && previous) { notify('这个位置已确认，请选择其他格。'); return; }
  if (!['normal','dual','triple'].includes(state.weapon)) {
    const need={radar:2,piercing:3,distributed_i:4,distributed_ii:5}[state.weapon] || 1;
    if(cell.x+need>boardSize() || cell.y+need>boardSize()) {notify(`该武器需要完整${need}×${need}范围，请向海图内侧选点。`);return;}
    targets = [cell];
  }
  else if (targets.some(item => key(item) === key(cell))) targets = targets.filter(item => key(item) !== key(cell));
  else if (targets.length < requiredTargets()) targets.push(cell);
  else targets = [...targets.slice(1), cell];
  render();
}

function moveShip(cell, rotate = false, selectExisting = true) {
  if (busy || state?.phase !== 'deploy') return;
  const clicked = rotate || !selectExisting ? -1 : state.player.ships.findIndex(ship => ship.cells.some(part => key(part) === key(cell)));
  if (clicked >= 0) { selectedShip = clicked; render(); return; }
  const next = clone(state.player); const ship = next.ships[selectedShip];
  const horizontal = ship.cells.length > 1 && ship.cells[0].y === ship.cells[1].y;
  const newHorizontal = rotate ? !horizontal : horizontal;
  const anchor = rotate ? ship.cells[0] : cell;
  ship.cells = ship.cells.map((part, index) => ({...part,
    x: anchor.x + (newHorizontal ? index : 0), y: anchor.y + (newHorizontal ? 0 : index)}));
  const check = validateFleet(next);
  if (!check.ok) {const message=`${rotate?'无法旋转':'无法移动'}：${check.errors[0]}。请选更空旷的位置。`;notify(message,'warning');$('placement-hint').textContent=message;return;}
  state.player=next;notify(rotate?`第${selectedShip+1}艘舰已绕船头${coord(anchor)}旋转为${newHorizontal?'横排':'竖排'}，船头位置不变。`:`第${selectedShip+1}艘舰已移动，当前为${newHorizontal?'横排':'竖排'}。`);render();
}

function shotText(side, result) {
  return ({miss:'没有击中',hit:side==='fleet'?'我方战舰中弹':'击中敌舰',sunk:side==='fleet'?'我方战舰被击沉':'敌方战舰被击沉',drift:'炮弹偏离',repeated:'该格已经投弹'})[result] || '';
}
async function animate(type, cells, side, result, duration) {
  const combat=['launch','shot'].includes(type);
  if(type==='launch'||type==='scan'&&side==='enemy') {
    const canvas=$(side==='fleet'?'fleet-board':'enemy-board'),rect=canvas.getBoundingClientRect();
    const headerBottom=Math.max(0,document.querySelector('.masthead').getBoundingClientRect().bottom);
    // 武器始终展开后操作区较长，开炮时让受击海图回到可见范围。
    if(rect.top<headerBottom+12||rect.bottom>innerHeight-12)window.scrollTo({top:Math.max(0,scrollY+rect.top-headerBottom-16),behavior:'instant'});
  }
  // 按原作演出留足飞行、命中与结果阅读时间；多点弹逐格回执略收紧。
  const minimum=type==='launch'?1600:type==='shot'?result==='sunk'?5000:duration<=420?1500:2800:0;
  const normalMs=combat?Math.max(duration/COMBAT_SPEED,minimum)/COMBAT_PLAYBACK_RATE:duration;
  const ms=reducedMotion ? Math.min(normalMs,50) : normalMs;
  const label=side==='fleet'?'敌方发射':'我方发射';
  const caption=type==='shot' ? `${side==='fleet'?'敌方':'我方'}攻击 ${cells.map(coord).join('、')}：${shotText(side,result)}` : `${label} · 目标 ${cells.map(coord).join('、')}`;
  const style=type==='launch'?(result==='distributed'?'distributed_ii':result==='normal'&&cells.length>1?'dual':result):type==='scan'?'radar':state.projectileStyle[side] || 'normal';
  if(type==='launch')state.projectileStyle[side]=style;
  fx={type,cells,side,result,style,weaponLabel:WEAPON_INFO[style]?.title||weaponName(style),label,caption,speed:combat?COMBAT_SPEED*COMBAT_PLAYBACK_RATE:1,start:performance.now(),duration:Math.max(ms,1)};
  if(type==='scan' && side==='enemy')$('battle-animation-label').textContent='我方雷达扫描';
  if(combat) {
    state.impact={type,side,cells:clone(cells),result,label,caption};
    $('battle-animation-label').textContent=label;$('impact-readout').textContent=caption;
    if(type==='shot') $(side==='fleet'?'enemy-last-shot':'player-last-shot').textContent=caption;
  }
  await sleep(ms);fx=null;
}

const LCD={light:SEA_PALETTE.ship,sea:SEA_PALETTE.water,line:SEA_PALETTE.grid,ink:SEA_PALETTE.ink,frame:SEA_PALETTE.frame,hit:SEA_PALETTE.hit,sunk:SEA_PALETTE.sunk,radarYes:SEA_PALETTE.radarYes,radarNo:SEA_PALETTE.radarNo};

function pixelSprite(ctx, pattern, x, y, color, scale = 1) {
  ctx.fillStyle = color;
  pattern.forEach((row, dy) => [...row].forEach((on, dx) => {if (on !== '0' && on !== ' ') ctx.fillRect(Math.floor(x + dx * scale), Math.floor(y + dy * scale), scale, scale);}));
}

function outlinedSprite(ctx,pattern,x,y,color) {
  ctx.fillStyle=LCD.ink;
  pattern.forEach((row,dy)=>[...row].forEach((on,dx)=>{if(on==='1')ctx.fillRect(x+dx-1,y+dy-1,3,3);}));
  pixelSprite(ctx,pattern,x,y,color);
}

function drawShip(ctx, cells, geometry, {sunk = false, selected = false} = {}) {
  const {step, mx, my} = geometry;
  if (!cells.length) return;
  const vertical = cells.length > 1 && cells.every(cell => cell.x === cells[0].x);
  const minX = Math.min(...cells.map(cell => cell.x)), minY = Math.min(...cells.map(cell => cell.y));
  const length = step * cells.length - 4, beam = Math.max(5, Math.floor(step * 0.5));
  const ox = mx + minX * step + (vertical ? Math.floor((step - beam) / 2) : 2);
  const oy = my + minY * step + (vertical ? 2 : Math.floor((step - beam) / 2));
  const rect = (x, y, w, h, color) => {ctx.fillStyle = color; if (vertical) ctx.fillRect(ox + y, oy + x, h, w); else ctx.fillRect(ox + x, oy + y, w, h);};
  rect(2, 0, length - 7, beam, LCD.ink); rect(0, 2, length - 2, beam - 4, LCD.ink);
  rect(length - 5, 1, 3, beam - 2, LCD.ink);
  rect(2, 2, length - 7, Math.max(1, beam - 4), sunk ? LCD.line : LCD.light);
  for (let x = 5; x < length - 7; x += Math.max(8, step)) {
    rect(x, 2, 4, Math.max(2, beam - 4), LCD.ink); rect(x + 1, 2, 1, 2, LCD.sea);
    rect(x + 4, Math.floor(beam / 2), 4, 1, LCD.ink);
  }
  rect(3, -2, 1, 3, LCD.ink); rect(4, -2, 3, 2, LCD.light);
  if (selected) for (const cell of cells) {
    const x = mx + cell.x * step, y = my + cell.y * step;
    ctx.fillStyle = LCD.light;
    for (const [dx, dy] of [[1,1],[step-4,1],[1,step-4],[step-4,step-4]]) ctx.fillRect(x + dx, y + dy, 3, 3);
  }
  if(selected){const head=cells[0],cx=mx+(head.x+.5)*step,cy=my+(head.y+.5)*step;pixelSprite(ctx,vertical?['00100','01110','11111']:['001','011','111','011','001'],Math.floor(cx-2),Math.floor(cy-2),'#f4c66d');}
}

function sideShip(ctx, x, y, sink = 0, owner = 'enemy') {
  const own=owner==='player',body=own?'#fff3d1':'#172936',edge=own?'#172936':'#c8e2e7';
  // 同一套像素轮廓使用相反明度，两边在动画里也能一眼分辨。
  ctx.fillStyle=edge;ctx.fillRect(x+1,y-1+sink,44,6);ctx.fillRect(x+4,y+3+sink,36,5);
  ctx.fillRect(x+12,y-6+sink,17,7);ctx.fillRect(x+17,y-10+sink,8,7);
  ctx.fillStyle=body;
  ctx.fillRect(x + 2, y + sink, 42, 4); ctx.fillRect(x + 5, y + 4 + sink, 34, 3);
  ctx.fillRect(x + 13, y - 5 + sink, 15, 5); ctx.fillRect(x + 18, y - 9 + sink, 6, 5);
  ctx.fillRect(x + 7, y - 2 + sink, 8, 2); ctx.fillRect(x + 30, y - 2 + sink, 10, 2);
  ctx.fillRect(x + 22, y - 14 + sink, 1, 6); ctx.fillRect(x + 23, y - 14 + sink, 5, 3);
  ctx.fillStyle=own?'#35556a':'#fff3d1';for(let k=0;k<5;k++)ctx.fillRect(x+8+k*6,y+1+sink,2,1);
}

function drawCombatHeader(ctx, canvas, message) {
  ctx.fillStyle=LCD.frame;ctx.fillRect(0,0,canvas.width,64);
  ctx.textAlign='center';ctx.textBaseline='top';ctx.fillStyle=LCD.light;
  // Fusion Pixel为12px字模，不能缩到9px或用maxWidth压缩，否则笔画会粘连。
  ctx.font='12px PixelChinese,monospace';
  ctx.fillText(fx.label,80,4);ctx.fillText(message,80,24);
  let shown=fx.cells.length,summary;
  do {
    summary=`目标 ${fx.cells.slice(0,shown).map(coord).join(' ')}${shown<fx.cells.length?` 等${fx.cells.length}点`:''}`;
    if(ctx.measureText(summary).width<=144 || shown<=1)break;
    shown--;
  } while(shown>0);
  ctx.fillText(summary,80,44);
}

function pixelRipple(ctx, x, y, radius, color) {
  ctx.fillStyle=color;
  for(let i=0;i<20;i++){
    const a=i*Math.PI/10;
    ctx.fillRect(Math.round(x+Math.cos(a)*radius),Math.round(y+Math.sin(a)*Math.max(2,radius/5)),2,1);
  }
}

function drawImpactCutscene(ctx, canvas, progress) {
  const t=Math.min(1,progress/.62),surface=116,cx=80,frame=Math.floor(t*18);
  ctx.fillStyle=LCD.sea;ctx.fillRect(0,0,canvas.width,canvas.height);
  for(let y=88;y<canvas.height;y+=9){
    ctx.fillStyle=SEA_PALETTE.crest;
    for(let x=0;x<canvas.width;x+=29)ctx.fillRect((x+frame)%canvas.width,y,16,1);
  }
  if(fx.result==='miss') {
    if(t<.17){
      const y=Math.round(67+t/.17*(surface-67));
      ctx.fillStyle=LCD.ink;ctx.fillRect(cx-2,y-4,5,8);
      ctx.fillStyle=LCD.light;ctx.fillRect(cx-1,y-3,2,5);
    }else{
      const q=(t-.17)/.83,h=Math.max(0,Math.round(Math.sin(Math.min(1,q/.8)*Math.PI)*32));
      ctx.fillStyle=LCD.light;
      ctx.fillRect(cx-3,surface-h,7,h+2);ctx.fillRect(cx-6,surface-h+4,13,4);
      ctx.fillStyle=SEA_PALETTE.foam;ctx.fillRect(cx-1,surface-h+7,3,Math.max(0,h-8));
      for(let i=0;i<6;i++){
        const direction=i%2?1:-1,spread=(7+Math.floor(i/2)*5)*q;
        const x=Math.round(cx+direction*spread),y=Math.round(surface-Math.sin(q*Math.PI)*(14+i*3)+q*q*8);
        ctx.fillStyle=LCD.light;ctx.fillRect(x,y,2,3);
      }
      pixelRipple(ctx,cx,surface+2,Math.round(5+q*27),LCD.light);
      if(q>.3)pixelRipple(ctx,cx,surface+4,Math.round(3+(q-.3)*22),SEA_PALETTE.foam);
    }
  }else{
    const sinking=fx.result==='sunk',sink=sinking?Math.round(Math.max(0,(t-.3)/.7)*50):0;
    // 舰体只在实际命中回执中出现，落空演出不透露附近隐藏舰位。
    ctx.save();ctx.translate(34+(t<.55?frame%2:0),102+sink);ctx.scale(2,2);sideShip(ctx,0,0,0,fx.side==='fleet'?'player':'enemy');ctx.restore();
    if(t>.16)for(let i=0;i<4;i++){
      const y=Math.round(92-t*(16+i*3)-i*3),x=cx-7+(i%2)*6;
      ctx.fillStyle=LCD.ink;ctx.fillRect(x,y,9+i*2,7+i);
      ctx.fillStyle=SEA_PALETTE.foam;ctx.fillRect(x+2,y+1,4,2);
    }
    if(t<.78){
      const scale=t<.15?1:2;
      pixelSprite(ctx,['10000100001','01001110010','00111111100','01111111110','00111111100','11111111111','00111111100','01111111110','00111111100','01001110010','10000100001'],cx-5*scale,99-5*scale,LCD.ink,scale);
      pixelSprite(ctx,['0010100','0111110','1111111','0111110','1111111','0111110','0010100'],cx-3*scale,99-3*scale,frame%2?LCD.hit:LCD.sunk,scale);
      pixelSprite(ctx,['010','111','010'],cx-scale,99-scale,LCD.light,scale);
    }
    if(sinking){
      ctx.fillStyle=LCD.sea;ctx.fillRect(0,surface,canvas.width,canvas.height-surface);
      pixelRipple(ctx,cx,surface+1,Math.round(12+t*23),LCD.light);
      if(t>.65)for(let i=0;i<4;i++){
        const y=Math.round(surface-((t-.65)*42+i*5)%23);
        ctx.fillStyle=LCD.light;ctx.fillRect(cx-12+i*8,y,2,2);
      }
    }
  }
  drawCombatHeader(ctx,canvas,shotText(fx.side,fx.result));
}

function drawCutscene(ctx, canvas, now) {
  const t=Math.min(1,(now-fx.start)/fx.duration),frame=Math.floor(t*12),style=fx.style || 'normal';
  ctx.fillStyle=LCD.sea;ctx.fillRect(0,0,canvas.width,canvas.height);
  for(let y=96;y<canvas.height;y+=8){
    ctx.fillStyle=y%16?LCD.line:LCD.ink;ctx.fillRect((frame+y)%12,y,canvas.width,1);
    ctx.fillStyle=LCD.light;for(let x=0;x<canvas.width;x+=31)ctx.fillRect((x+frame*2)%canvas.width,y+2,9,1);
  }
  sideShip(ctx,82,93,0,fx.side==='fleet'?'player':'enemy');sideShip(ctx,7,126,0,fx.side==='fleet'?'enemy':'player');
  drawCombatHeader(ctx,canvas,fx.weaponLabel);
  const count=fx.cells.length;
  const distributed=style==='distributed_i'||style==='distributed_ii';
  for(let i=0;i<count;i++){
    const stagger=style==='triple' ? 0.10 : style==='dual' ? 0.14 : 0.045;
    const u=Math.max(0,Math.min(1,t*(1+count*stagger)-i*stagger));
    let x,y;
    if(distributed){
      // 分布式弹先沿共同航路上升，再分散成四角或九点集群。
      const spacing=style==='distributed_ii'?12:18,cols=style==='distributed_ii'?3:2;
      const split=Math.max(0,(u-.45)/.55),targetX=90+(i%cols)*spacing,targetY=77+Math.floor(i/cols)*spacing;
      x=Math.floor(26+u*72+split*(targetX-98));y=Math.floor(116-Math.sin(u*Math.PI)*40-u*24+split*(targetY-92));
      ctx.fillStyle=LCD.light;
      if(split>0){ctx.fillRect(x-1,y-7,1,4);ctx.fillRect(x-6,y+2,3,1);}
      ctx.fillStyle=LCD.ink;ctx.fillRect(x-2,y-2,5,5);ctx.fillStyle=style==='distributed_ii'?LCD.sunk:LCD.light;ctx.fillRect(x-1,y-1,3,3);
    }else if(style==='piercing'){
      // 异步向量索引导弹显示有尾焰的箭体，末段展开为X形五路。
      const offsets=[[-12,-10],[12,-10],[0,0],[-12,10],[12,10]],spread=Math.max(0,(u-.35)/.65),[dx,dy]=offsets[i%5];
      x=Math.floor(26+u*78+spread*dx);y=Math.floor(111-u*28+spread*dy);
      ctx.fillStyle=LCD.ink;ctx.fillRect(x-6,y-1,11,3);ctx.fillRect(x-3,y-3,3,7);
      ctx.fillStyle=LCD.light;ctx.fillRect(x-4,y,7,1);ctx.fillStyle=LCD.hit;ctx.fillRect(x-10,y-1,4,3);
    }else{
      // 单炮、双响、三联保留不同间隔与弧线，多管炮可同时辨识。
      x=Math.floor(26+u*(78+(i%3)*5));y=Math.floor(116-Math.sin(u*Math.PI)*(32+i*4)-u*24);
      ctx.fillStyle=LCD.ink;ctx.fillRect(x-1,y-1,5,5);ctx.fillStyle=LCD.light;ctx.fillRect(x,y,2,2);
      for(let tail=1;tail<4;tail++)ctx.fillRect(x-tail*4,y+tail,2,1);
    }
    if(u<.2){ctx.fillStyle=LCD.light;ctx.fillRect(24,113,7,7);ctx.fillStyle=LCD.hit;ctx.fillRect(26,115,3,3);}
  }
}

function drawBoard(canvas, side, now) {
  const ctx = canvas.getContext('2d'), g = boardGeometry(canvas), {n, step, mx, my} = g;
  ctx.imageSmoothingEnabled = false;ctx.textAlign='left';ctx.textBaseline='alphabetic'; ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (fx?.side === side && fx.type === 'launch') {drawCutscene(ctx, canvas, now); return;}
  if (fx?.side===side && fx.type==='shot' && ['miss','hit','sunk'].includes(fx.result) && (now-fx.start)/fx.duration<.78) {
    drawImpactCutscene(ctx,canvas,(now-fx.start)/fx.duration);return;
  }
  ctx.fillStyle=LCD.frame;ctx.fillRect(0,0,canvas.width,canvas.height);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const sx = mx + x * step, sy = my + y * step;
    drawSeaCell(ctx,sx,sy,step,x,y);
    ctx.fillStyle = LCD.line; ctx.fillRect(sx, sy, step + 1, 1); ctx.fillRect(sx, sy, 1, step + 1);
  }
  ctx.fillStyle = LCD.line; ctx.fillRect(mx + n * step, my, 1, n * step + 1); ctx.fillRect(mx, my + n * step, n * step + 1, 1);
  if(state?.phase==='deploy' && side==='fleet')for(const cell of placementBlockedCells(state.player,selectedShip)) {
    const cx=mx+cell.x*step+Math.floor(step/2),cy=my+cell.y*step+Math.floor(step/2);
    outlinedSprite(ctx,['1000001','0100010','0010100','0001000','0010100','0100010','1000001'],cx-3,cy-3,'#ff9a80');
  }
  for(let i=0;i<n;i++){drawAxisLetter(ctx,chartColumn(i),mx+(i+.5)*step,my-7,LCD.light);drawAxisNumber(ctx,i+1,mx-12,my+(i+.5)*step,LCD.light);}
  // 原作的像素波纹边框，以整像素块绘制。
  ctx.fillStyle=SEA_PALETTE.crest;
  for (let x = mx - 4; x <= mx + n * step + 3; x += 3) {ctx.fillRect(x, my - 2 + (x % 2), 2, 1);ctx.fillRect(x, my + n * step + 4 - (x % 2), 2, 1);}
  for (let y = my - 3; y <= my + n * step + 3; y += 3) {ctx.fillRect(mx - 4 + (y % 2), y, 1, 2);ctx.fillRect(mx + n * step + 4 - (y % 2), y, 1, 2);}
  if (state && side === 'fleet') state.player.ships.forEach((ship, index) => drawShip(ctx, ship.cells, g,
    {sunk: ship.sunk, selected: state.phase === 'deploy' && index === selectedShip}));
  const shots = side === 'enemy' ? state?.knowledge.shots : state?.aiKnowledge.shots;
  if(side==='enemy') for(const cell of Object.values(state?.radarKnowledge || {})) {
    if(shots?.[key(cell)])continue;
    const cx=mx+cell.x*step+Math.floor(step/2),cy=my+cell.y*step+Math.floor(step/2);
    if(cell.occupied==null){outlinedSprite(ctx,['11111','10001','00110','00100','00000','00100'],cx-2,cy-3,LCD.light);continue;}
    pixelSprite(ctx,['0001000','0010100','0100010','1000001','0100010','0010100','0001000'],cx-3,cy-3,cell.occupied?LCD.ink:LCD.radarNo);
    if(cell.occupied)pixelSprite(ctx,['00100','01110','11111','01110','00100'],cx-2,cy-2,LCD.radarYes);
  }

  if(side==='enemy')for(const mark of Object.values(state?.mapMarks||{})){
    if(shots?.[key(mark)])continue;
    const cx=mx+mark.x*step+Math.floor(step/2),cy=my+mark.y*step+Math.floor(step/2);
    if(mark.kind==='flag'){
      outlinedSprite(ctx,['1111111','1111110','1111100','1111000','1000000','1000000','1000000','1000000','1111000'],cx-3,cy-4,'#ff887a');
      ctx.fillStyle=LCD.light;ctx.fillRect(cx-3,cy-4,1,8);ctx.fillRect(cx-3,cy+4,4,1);
    }else outlinedSprite(ctx,['0111100','1100010','0000010','0001100','0011000','0010000','0000000','0011000','0011000'],cx-3,cy-4,LCD.light);
  }

  for (const shot of Object.values(shots ?? {})) {
    const cx = mx + shot.x * step + Math.floor(step / 2), cy = my + shot.y * step + Math.floor(step / 2);
    if(shot.state==='miss'){pixelSprite(ctx,['0011100','0100010','1000001','1000001','1000001','0100010','0011100'],cx-3,cy-3,LCD.light);pixelSprite(ctx,['01110','10001','10001','10001','01110'],cx-2,cy-2,LCD.ink);}
    else outlinedSprite(ctx,['1001001','0101010','0011100','1111111','0011100','0101010','1001001'],cx-3,cy-3,shot.state==='sunk'?LCD.sunk:LCD.hit);
  }
  const last=(state?.shotHistory || []).filter(shot=>shot.side===(side==='enemy'?'player':'enemy')).at(-1);
  if(last) {
    ctx.strokeStyle=LCD.light;ctx.lineWidth=1;
    ctx.strokeRect(mx+last.x*step+1.5,my+last.y*step+1.5,step-3,step-3);
  }
  if(fx?.side===side && fx.type==='shot') {
    const progress=Math.min(1,Math.max(0,((now-fx.start)/fx.duration-.78)/.22));
    for(const cell of fx.cells) {
      const cx=mx+(cell.x+.5)*step,cy=my+(cell.y+.5)*step;
      const radius=Math.max(2,Math.floor(Math.sin(progress*Math.PI)*(step/2-1)));
      if(fx.result==='miss')pixelRipple(ctx,Math.floor(cx),Math.floor(cy),radius,LCD.light);
      else{ctx.fillStyle=Math.floor(progress*10)%2?LCD.light:LCD.hit;ctx.fillRect(cx-radius,cy-1,radius*2+1,3);ctx.fillRect(cx-1,cy-radius,3,radius*2+1);}
      ctx.strokeStyle=LCD.ink;ctx.lineWidth=1;ctx.strokeRect(mx+cell.x*step+1.5,my+cell.y*step+1.5,step-3,step-3);
    }
  }
  if (side === 'enemy' && fx?.type==='scan' && fx.side==='enemy') {
    ctx.fillStyle='#fff0c988';
    for(const cell of fx.cells) {const x=mx+cell.x*step,y=my+cell.y*step;ctx.fillRect(x,y+Math.floor((now-fx.start)/fx.duration*step),step,1);}
  }
  if (side === 'enemy') {
    for (const cell of predictedArea()) {
      const cx = mx + cell.x * step + Math.floor(step / 2), cy = my + cell.y * step + Math.floor(step / 2);
      pixelSprite(ctx, ['001000100','010000010','100000001','000010000','000111000','000010000','100000001','010000010','001000100'], cx - 4, cy - 4, LCD.light);
    }
    if (hover && !targets.length && state?.phase === 'player') {
      const cx = mx + hover.x * step + Math.floor(step / 2), cy = my + hover.y * step + Math.floor(step / 2);
      ctx.fillStyle = LCD.ink;ctx.fillRect(cx - 3, cy, 7, 1);ctx.fillRect(cx, cy - 3, 1, 7);
    }
  }
}

function draw(now) { for(const canvas of document.querySelectorAll('canvas[data-pixel-icon]'))paintIcon(canvas,canvas.dataset.pixelIcon,Math.floor(now/240)%2); drawTheater(now); drawBoard($('enemy-board'), 'enemy', now); drawBoard($('fleet-board'), 'fleet', now); requestAnimationFrame(draw); }

function setupControls() {
  const forkHelp = [...$('help-dialog').querySelectorAll('.help-steps li')]
    .find(item => item.querySelector('strong')?.textContent === '试错机会');
  if (forkHelp) forkHelp.querySelector('p').textContent = `${FORK_DESCRIPTION}重开后再次失败，本轮战役结束。`;
  const tools = element('div', 'weapon-tools');
  const label = element('label', '', '弹种 '); const select = element('select'); select.id = 'weapon-choice'; select.setAttribute('aria-label', '选择炮弹');
  for (const [value, text] of [['normal', '普通炮弹'], ['radar', '混合检索雷达'], ['dual', 'HTAP 双响炮'], ['triple', '嵌入式三联炮'], ['distributed_i', '多模态扩展弹'], ['piercing', '异步向量索引导弹'], ['distributed_ii', 'OceanBase 分布式火力支援']]) {
    const option = element('option', '', text); option.value = value; select.append(option);
  }
  select.hidden=true;label.append(select); const direction = element('button', 'button button-small', '方向：横向 →'); direction.type = 'button'; direction.id = 'weapon-direction';
  tools.append(label, direction); document.querySelector('.navy-weapon-content').append(tools);
  select.addEventListener('change', () => { state.weapon = select.value; targets = [];  render(); });
  direction.addEventListener('click', () => { state.direction = state.direction === 'horizontal' ? 'vertical' : 'horizontal'; render(); });
  $('start-game').addEventListener('click', () => operation(async () => {await startCampaign($('new-seed').value); tutorialIndex = 0; setView('tutorial');}));
  $('quick-start').addEventListener('click', () => operation(() => startCampaign($('new-seed').value)));
  $('tutorial-next').addEventListener('click', () => {if(tutorialIndex<TUTORIAL.length-1){tutorialIndex++;render();}else setView(state?.deploymentConfirmed?'intel':'deploy');});
  $('tutorial-skip').addEventListener('click',()=>setView(state?.deploymentConfirmed?'intel':'deploy'));
  for (const [id, screen] of [['view-intel','intel'], ['view-theater','theater'], ['view-battle','battle']]) $(id).addEventListener('click', () => setView(screen));
  $('view-deploy').addEventListener('click', () => {if (state?.shotHistory.length || busy) return; state.phase = 'deploy'; setView('deploy');});
  $('recon-button').addEventListener('click', () => setView('intel'));
  $('change-sector-button').addEventListener('click', () => setView('theater'));
  $('back-battle-button').addEventListener('click', () => setView('battle'));
  $('toggle-records').addEventListener('click', () => {
    recordsOpen = !recordsOpen; renderFlow();
    if (recordsOpen) $('records-panel').scrollIntoView({block:'start', behavior:'instant'});
  });
  $('random-seed').addEventListener('click', () => {$('new-seed').value = freshSeed();});
  $('confirm-fleet').addEventListener('click', () => operation(confirmDeployment));
  $('random-fleet').addEventListener('click', () => {
    state.player = createFleet(LEVELS[campaign.level - 1].playerShips, {size: boardSize(), seed: `${campaign.seed}|player|${campaign.level}|${++deploySerial}`, lightweight: $('shrink-toggle').checked, noTouch:true}); render();
  });
  $('rotate-ship').addEventListener('click', () => moveShip(null, true));
  $('shrink-toggle').addEventListener('change', () => {
    state.player = createFleet(LEVELS[campaign.level - 1].playerShips, {size: boardSize(), seed: `${campaign.seed}|player|${campaign.level}|${deploySerial}`, lightweight: $('shrink-toggle').checked, noTouch:true}); render();
  });
  $('sector-choice').addEventListener('change', () => {state.proposedSector = $('sector-choice').value; render();});
  $('engage-sector').addEventListener('click', () => operation(() => engageSector(state.proposedSector)));
  // 航海图为查询结果展示，不再要求玩家手动标点。
  $('run-detail-search').addEventListener('click',()=>operation(runDetailSearch));
  $('accept-briefing').addEventListener('click',()=>operation(acceptBriefing));
  $('run-query').addEventListener('click', () => operation(runRecon));
  $('skip-query').addEventListener('click', () => notify('本关必须先完成检索和海图定位。'));
  $('fire-shot').addEventListener('click', () => operation(fire));
  $('mark-flag').addEventListener('click',()=>operation(()=>setMapMarks('flag')));
  $('mark-question').addEventListener('click',()=>operation(()=>setMapMarks('question')));
  $('mark-clear').addEventListener('click',()=>operation(()=>setMapMarks('clear')));
  $('mark-sql-safe').addEventListener('click',()=>operation(()=>setMapMarks('flag',state.support.safe,'sql')));
  $('enemy-board').addEventListener('contextmenu',event=>{
    if(state?.phase!=='player'||!state.activeSector)return;
    const cell=boardPoint(event,$('enemy-board'));if(!cell)return;event.preventDefault();
    const old=state.mapMarks[key(cell)]?.kind;operation(()=>setMapMarks(old==='flag'?'question':old==='question'?'clear':'flag',[cell]));
  });
  $('clear-selection').addEventListener('click', () => {targets = []; render();});
  $('rewind-button').addEventListener('click', () => operation(rewind));
  $('confirm-rewards').addEventListener('click',()=>operation(confirmRewards));
  $('next-level').addEventListener('click',()=>operation(advanceFromResult));
  $('retry-level').addEventListener('click', () => operation(() => startCampaign()));
  $('help-button').addEventListener('click', () => $('help-dialog').showModal());
  $('close-help').addEventListener('click', () => $('help-dialog').close());
  const enemy = $('enemy-board'); const fleet = $('fleet-board');
  enemy.addEventListener('click', event => selectEnemy(boardPoint(event, enemy)));
  enemy.addEventListener('mousemove', event => {hover = boardPoint(event, enemy);});
  enemy.addEventListener('mouseleave', () => {hover = null;});
  fleet.addEventListener('click', event => {const cell = boardPoint(event, fleet); if (cell){fleet.focus({preventScroll:true});moveShip(cell);}});
  document.addEventListener('keydown', event => {
    if(event.altKey || event.metaKey || event.ctrlKey || busy || state?.phase!=='deploy' || view!=='deploy' || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName))return;
    if(event.key.toLowerCase()==='r'){event.preventDefault();moveShip(null,true);return;}
    const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if(moves[event.key]){
      event.preventDefault();event.stopPropagation();const [dx,dy]=moves[event.key],head=state.player.ships[selectedShip].cells[0];
      moveShip({x:head.x+dx,y:head.y+dy},false,false);
    }
  });
  let keyboardCell = {x: 0, y: 0};
  enemy.addEventListener('keydown', event => {
    const moves = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
    if (moves[event.key]) {event.preventDefault(); const [dx, dy] = moves[event.key]; keyboardCell = {x: Math.max(0, Math.min(boardSize() - 1, keyboardCell.x + dx)), y: Math.max(0, Math.min(boardSize() - 1, keyboardCell.y + dy))}; hover = keyboardCell;}
    if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); selectEnemy(keyboardCell);}
  });
}

async function boot() {
  setupControls();paintPixelBrand($('brand-logo-canvas')).catch(()=>{}); $('new-seed').value = freshSeed(); render(); requestAnimationFrame(draw);
  try {
    db = await NavalDB.open(message => {$('engine-detail').textContent = message; $('engine-progress').value = Math.min(85, $('engine-progress').value + 24);});
    await createSchema();
    $('engine-status').textContent = '真实 seekdb 已就绪';
    $('engine-detail').textContent = db.engineVersion;
    $('engine-progress').value = 100; busy = false; render();
    notify('点击“开始作战”，先部署舰队。SQL 将在浏览器内真实执行。');
    if (new URLSearchParams(location.search).has('test')) window.navalTest = {
      db, getState: () => ({campaign, state, deal, detailEvidence, detailSelection, tableNames, notes, queryMetrics, busy, view}), geometry: id => boardGeometry($(id)), tacticalRegion, selectedShip:()=>selectedShip, selection:()=>clone(targets),
      start: seed => operation(() => startCampaign(seed)), confirm: () => operation(confirmDeployment),
      recon: () => operation(runRecon), detailSearch:()=>operation(runDetailSearch), acceptBriefing:()=>operation(acceptBriefing),
      detailSelect(sample,keyword){detailSelection={sample,keyword};render();}, animationInfo:()=>fx?clone(fx):null, engage: sector => operation(() => engageSector(sector)), fire: () => operation(fire), rewind: () => operation(rewind),
      selectCards(ids, methods) {cards = new Set(ids); abilities = new Set(methods); render();},
      reconChoices,detailChoices,reconTask,detailTask,selectReconCard,selectDetailInput,
      mark:(kind,cells)=>operation(()=>setMapMarks(kind,cells)),plan:()=>operation(requestSupportPlan),
      target(cells) {targets = cells; render();},
      pin(point) {state.mapPin=point;render();}, weapon(id) {state.weapon=id;targets=[];render();},
      stage: level => operation(async () => {campaign.level = level; campaign.medals = LEVELS.slice(0, level - 1).flatMap(item => [item.reward,...(item.extraRewards||[])]).filter(Boolean);
        if (level >= 4) await db.exec(`REPLACE INTO capabilities VALUES ('player','double_fire',${LEVELS[2].enemyDoubleEvery})`);
        await prepareLevel();}),
      win:()=>operation(victory), confirmRewards:()=>operation(confirmRewards), advance:()=>operation(advanceFromResult),
      lose: (reason = '测试关卡失败') => operation(() => lose(reason)),
    };
  } catch (error) {
    $('engine-status').textContent = 'seekdb 启动失败'; $('engine-detail').textContent = error.message;
    $('engine-progress').value = 0; notify(error.message, 'error');
  }
}

boot();
