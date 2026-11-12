/** 纯数据契约与SQL构造测试；不以JS模拟数据库执行结果。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSupportRows,planSql,supportEnemyPlan,SUPPORT_CODES,TACTICAL_PATTERNS} from './战术规划.mjs';
import {LEVELS,createEnemyFleet,generateEvidence,enemyFirePlan,weaponPatternAtAnchor} from './海战规则.mjs';
import {createDetailEvidence} from './细节检索.mjs';

const fixture=level=>{const seed='SUPPORT-CONTRACT';return createDetailEvidence({evidence:generateEvidence({fleet:createEnemyFleet({level,seed:`${seed}|enemy|${level}`}),level,seed}),level,seed});};
const target=level=>fixture(level).rows.find(r=>r.kind!=='non_tactical');
const alter=(row,work)=>{const next=structuredClone(row),p=JSON.parse(next.payload_json);work(p);next.payload_json=JSON.stringify(p);return next;};

test('六关实际payload契约可解析，噪声不授能力，同协议去重',()=>{
  for(const level of LEVELS){
    const detail=fixture(level.id),before=JSON.stringify(detail.rows),out=normalizeSupportRows(detail.rows,{size:level.size,level:level.id});
    assert.equal(out.protocols.length,1);assert.equal(out.protocols[0].id,`level-${level.id}-support`);assert.equal(out.protocols[0].code,SUPPORT_CODES[level.id-1]);assert.equal(JSON.stringify(detail.rows),before);
    if(level.id===1)assert.equal(out.focus.length,32);
    if(level.id===2)assert.equal(out.safe.length,4);
    if(level.id>=5){assert.equal(out.submarine.length,level.id===5?72:60);assert.equal(out.focus.length,out.submarine.length);assert.equal(out.safe.length,level.id===5?4:9);}
    assert.equal(new Set(out.cells.map(c=>`${c.tag}:${c.x},${c.y}`)).size,out.cells.length);
  }
});
test('密度半盘可独立归一化，不伪造协议',()=>{
  const cells=Array.from({length:32},(_,i)=>({x:i%4,y:Math.floor(i/4)}));
  const out=normalizeSupportRows([{kind:'dense_half',payload_json:JSON.stringify({clue:{kind:'dense_half',cells}})}],{size:8,level:1});assert.equal(out.focus.length,32);assert.deepEqual(out.protocols,[]);
});
test('未知schema/隐藏舰队/精确舰格/越界/重复坐标拒绝',()=>{
  const row=target(1),cases=[alter(row,p=>{p.fleet=[];}),alter(row,p=>{p.clue.ships=[];}),alter(row,p=>{p.clue.cells=[{x:0,y:0},{x:1,y:0},{x:2,y:0}];}),alter(row,p=>{p.clue.cells[0].x=8;}),alter(row,p=>{p.clue.cells[0].hp=1;}),alter(row,p=>{p.clue.cells[1]={...p.clue.cells[0]};}),alter(row,p=>{p.clue.proof={ship_id:'hidden'};})];
  for(const r of cases)assert.throws(()=>normalizeSupportRows([r],{size:8,level:1}));
  for(const payload_json of ['{','[]','null','{"schema":"unknown"}'])assert.throws(()=>normalizeSupportRows([{payload_json}],{size:8,level:1}));
  assert.throws(()=>normalizeSupportRows([{}],{size:8,level:1}));assert.throws(()=>normalizeSupportRows([],{size:12,level:1}));
});
test('协议ID/code/参数严格对应关卡，额外参数与冲突拒绝',()=>{
  for(const level of LEVELS){const row=target(level.id);for(const change of [p=>{p.protocol.id='other';},p=>{p.protocol.code='unknown';},p=>{p.protocol.bonus=999;}])assert.throws(()=>normalizeSupportRows([alter(row,change)],{size:level.size,level:level.id}));}
  assert.throws(()=>normalizeSupportRows([alter(target(3),p=>{p.protocol.target_length=4;})],{size:10,level:3}));
  assert.throws(()=>normalizeSupportRows([alter(target(4),p=>{p.protocol.max_enemy_shots=2;})],{size:10,level:4}));
  const a=target(1),b=alter(a,p=>{p.protocol.description='冲突';});assert.throws(()=>normalizeSupportRows([a,b],{size:8,level:1}));
});
test('空海与舰向不接受伪装的精确敌位，公开数值不接受NaN/负数',()=>{
  assert.throws(()=>normalizeSupportRows([alter(target(2),p=>{p.clue.cells.pop();})],{size:8,level:2}));
  assert.throws(()=>normalizeSupportRows([alter(target(3),p=>{p.clue.cells=[{x:0,y:0}];})],{size:10,level:3}));
  assert.throws(()=>normalizeSupportRows([alter(target(5),p=>{p.clue.proof.candidateCellCount=-1;})],{size:12,level:5}));
  assert.throws(()=>normalizeSupportRows([alter(target(1),p=>{p.clue.cells[0].x=null;})],{size:8,level:1}));
});
test('SQL只读四张公开表，范围完整、去重tag、旧格和safe仅剔分',()=>{
  for(const weapon of Object.keys(TACTICAL_PATTERNS)){
    const sql=planSql({weapon,size:12,missionId:'mission-1',sectorId:'S1'});
    for(const name of ['sea_cells','naval_pattern_offsets','naval_tactic_cells','naval_public_shots'])assert.ok(sql.includes(name));
    assert.doesNotMatch(sql,/radar_echoes|occupied|enemy|fleet|random/i);assert.match(sql,/COALESCE\(t.is_safe,0\)=0 AND COALESCE\(s.is_shot,0\)=0/);assert.match(sql,/GROUP BY x,y/);assert.match(sql,/HAVING total_points=/);assert.ok(sql.endsWith('LIMIT 2'));
    if(weapon==='radar')assert.match(sql,/MOD\(a.x,2\)=0 AND MOD\(a.y,2\)=0/);
  }
});
test('SQL参数类型校验与字符串转义，不把用户值插入标识符',()=>{
  const good={weapon:'radar',size:8,missionId:"m'\\ OR 1=1 --",sectorId:'S1'};const sql=planSql(good);assert.ok(sql.includes("mission_id='m''\\\\ OR 1=1 --'"));
  for(const patch of [{weapon:'radar;DROP TABLE x'},{weapon:new String('radar')},{weapon:'__proto__'},{size:9},{size:'8'},{missionId:null},{missionId:'a\0b'},{sectorId:'S17'},{sectorId:"S1' OR 1=1"},{limit:2.5},{limit:'2'},{limit:0}])assert.throws(()=>planSql({...good,...patch}));
});
test('模板与正式左上角四角/隔九/X五点一致，不裁边',()=>{
  for(const weapon of ['distributed_i','distributed_ii','piercing']){const p=TACTICAL_PATTERNS[weapon];assert.deepEqual(p.offsets.map(o=>`${o.dx},${o.dy}`).sort(),weaponPatternAtAnchor(weapon,{x:0,y:0},12).map(c=>`${c.x},${c.y}`).sort());assert.equal(weaponPatternAtAnchor(weapon,{x:13-p.span,y:0},12).length,0);}
  assert.equal(TACTICAL_PATTERNS.radar.offsets.length,4);
});
test('基准敌计划不变，L3停中继只降双炮，L4仅本轮扫频',()=>{
  for(let level=1;level<=6;level++)for(let round=1;round<=12;round++){const out=supportEnemyPlan({level,round}),base=enemyFirePlan(level,round);assert.equal(out.shots,base.shots);assert.equal(out.nextShots,base.nextShots);assert.equal(out.warning,base.warning);}
  for(const round of [3,4,7,8]){const r=supportEnemyPlan({level:3,round,relayDisabled:true});assert.equal(r.shots,1);assert.equal(r.nextShots,1);assert.equal(r.warning,false);}
  assert.equal(supportEnemyPlan({level:4,round:3,sweepRound:3}).shots,1);assert.equal(supportEnemyPlan({level:4,round:3,sweepRound:2}).shots,2);assert.equal(supportEnemyPlan({level:5,round:3,sweepRound:3,relayDisabled:true}).shots,2);
  assert.equal(supportEnemyPlan({level:4,round:2,sweepRound:2}).nextShots,2);assert.throws(()=>supportEnemyPlan({level:3,round:4,relayDisabled:1}));
});
