/** 细节资料与定位资料分表；只投影开局已有粗线索，不接收fleet或实时舰位。 */
import { isTacticalClueKind } from './战术线索.mjs';
import { createSignalStory } from './情报剧本.mjs';
export { isTacticalClueKind, TACTICAL_CLUE_KINDS } from './战术线索.mjs';
const SAMPLE_DEFINITIONS = [
  { name: 'civil', label: '民船运输回波', vector: [0.12, 0.42, 0.36, 0.82, 0.28, 0.54, 0.64, 0.08] },
  { name: 'noise', label: '气象浮标杂讯', vector: [0.06, 0.04, 0.01, 0.08, 0.45, 0.03, 0.18, 0.02] },
];
const KEYWORDS = [
  { keyword: 'ANCHOR', label: '锚泊监听' },
  { keyword: 'BEACON', label: '航标监听' },
  { keyword: 'COMPASS', label: '航向监听' },
  { keyword: 'TIDE', label: '潮汐监听' },
  { keyword: 'CORAL', label: '礁区监听' },
];

function hashSeed(seed) {
  let hash = 2166136261;
  for (const char of String(seed)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''").replaceAll('\0', '')}'`;
}

const PUBLIC_PROOF_KEYS = new Set(['asOf', 'fallback', 'span', 'emptyCellCount', 'length', 'orientation',
  'candidatePlacementCount', 'quantifier', 'axis', 'boundaries', 'minLength', 'candidateCellCount',
  'width', 'targetLength', 'regionCellCount']);

function publicClue(clue, windowCells) {
  const minX = Math.min(...windowCells.map(cell => cell.x)), minY = Math.min(...windowCells.map(cell => cell.y));
  const keys = new Set(windowCells.map(cell => `${cell.x},${cell.y}`));
  const rawCells = clue.cells ?? [];
  if (!Array.isArray(rawCells) || rawCells.some(cell => !Number.isInteger(cell?.x) || !Number.isInteger(cell?.y)
    || !keys.has(`${cell.x},${cell.y}`))) throw new RangeError('额外线索的粗区域越出定位海区');
  const proof = Object.fromEntries(Object.entries(clue.proof ?? {}).filter(([key]) => PUBLIC_PROOF_KEYS.has(key)));
  return { kind: clue.kind, cells: rawCells.map(cell => ({ x: cell.x - minX, y: cell.y - minY })),
    ...(Object.keys(proof).length ? { proof: JSON.parse(JSON.stringify(proof)) } : {}) };
}

function supportProtocol(level, extras) {
  const protocol = { id: `level-${level}-support`, code: ['radar_recommend', 'safe_mark', 'relay_target',
    'radar_sweep', 'radar_filter', 'pattern_plan'][level - 1], description: [
    '用本次粗线索推荐雷达扫描窗口，扫描仍消耗原有雷达库存和一次行动。',
    '把本次确认的空海区域加入避空标记，不视为已经投过炸弹。',
    '最长舰承担副炮中继；击沉这类目标后，停止后续周期双炮。',
    '扫频雷达可在敌方双炮轮压制副炮，本轮最多反击一发，仍消耗一次雷达行动。',
    '校准后可读取受扰雷达的有效回波；尚未解码的受扰格应保持未知。',
    '比较现有多点武器覆盖尚未排除候选格的数量；覆盖分数不等于真实命中。',
  ][level - 1] };
  if (level === 3) {
    const length = extras.find(clue => clue.kind === 'ship_orientation')?.proof?.length;
    if (!Number.isInteger(length) || length < 1) throw new RangeError('额外观测缺少公开的最长舰长度');
    Object.assign(protocol, { target_length: length, period: 4 });
  }
  if (level === 4) Object.assign(protocol, { enemy_period: 3, max_enemy_shots: 1 });
  return protocol;
}

/** 返回的embedding为八维人工领域特征，不是通用语义模型的嵌入。 */
export function createDetailEvidence({ evidence, level = 1, seed = 1 } = {}) {
  const levelId = typeof level === 'number' ? level : level?.id;
  if (!Number.isInteger(levelId) || levelId < 1 || levelId > 6) throw new RangeError('细节资料关卡无效');
  if (!evidence || !Array.isArray(evidence.rows) || typeof evidence.missionId !== 'string' || !evidence.missionId) throw new RangeError('缺少开局资料');
  const reliableIds = new Set(evidence.truth?.reliableRowIds ?? []);
  const reliable = evidence.rows.filter(row => reliableIds.has(row.id)).sort((a, b) => a.id.localeCompare(b.id));
  if (!reliable.length) throw new RangeError('开局资料没有已确认的可靠观测行');
  const original = reliable[0];
  if (!/^S(?:[1-9]|1[0-6])$/.test(original.sector_id) || original.mission_id !== evidence.missionId) throw new RangeError('可靠资料的任务或海区不一致');
  let clues;
  try { clues = typeof original.tactical_clues === 'string' ? JSON.parse(original.tactical_clues) : original.tactical_clues; }
  catch { throw new RangeError('可靠资料的战术线索不是有效JSON'); }
  if (!Array.isArray(clues)) throw new RangeError('可靠资料缺少开局战术线索');
  const extras = clues.slice(1).filter(clue => clue?.kind !== 'dense_half' && isTacticalClueKind(clue?.kind)).slice(0, levelId >= 5 ? 2 : 1);
  if (!extras.length || extras.some(clue => ![clue.id, clue.kind, clue.text].every(value => typeof value === 'string' && value.length))) {
    throw new RangeError('可靠资料缺少既有额外线索；请在截取定位线索之前创建细节资料');
  }
  let windowCells;
  try { windowCells = typeof original.cells === 'string' ? JSON.parse(original.cells) : original.cells; }
  catch { throw new RangeError('定位海区不是有效JSON'); }
  if (!Array.isArray(windowCells) || !windowCells.length || windowCells.some(cell => !Number.isInteger(cell?.x) || !Number.isInteger(cell?.y))) {
    throw new RangeError('缺少有效定位海区坐标');
  }
  const protocol = supportProtocol(levelId, extras);
  const signalStory = createSignalStory({ level: levelId, seed });
  const samples = [{ name: 'warship', label: signalStory.echo.label, vector: [...signalStory.echo.vector] },
    ...SAMPLE_DEFINITIONS.map(sample => ({ ...sample, vector: [...sample.vector] }))];
  const forbidden = new Set([evidence.callSign, ...evidence.rows.map(row => row.call_sign)].filter(Boolean).map(value => String(value).toUpperCase()));
  const candidates = KEYWORDS.filter(option => !forbidden.has(option.keyword) && option.keyword !== signalStory.listen.keyword);
  if (candidates.length < 2) throw new RangeError('没有足够的独立详情关键词');
  const start = hashSeed(`${seed}|detail-keyword|${levelId}`) % candidates.length;
  const selected = [{ keyword: signalStory.listen.keyword, label: signalStory.listen.label },
    ...Array.from({ length: 2 }, (_, index) => ({ ...candidates[(start + index) % candidates.length] }))];
  const keyword = selected[0].keyword;
  const rotation = hashSeed(`${seed}|detail-options|${levelId}`) % selected.length;
  const keywordOptions = [...selected.slice(rotation), ...selected.slice(0, rotation)];
  const prefix = `detail-l${levelId}-${hashSeed(`${seed}|${evidence.missionId}`).toString(16)}`;
  const rows = [];
  function add({ suffix, clueId = `detail-noise-${suffix}`, kind = 'non_tactical', text,
    token = keyword, vector = samples[0].vector, sector = original.sector_id,
    mission = evidence.missionId, observedRound = 1, source = '信号校准站', details = '', payload = null }) {
    rows.push({ id: `${prefix}-${suffix}`, sector_id: sector, mission_id: mission,
      observed_round: observedRound, clue_id: clueId, kind, clue_text: text,
      body: `${source} ${token} DETAIL : ${details}${text}`, source, embedding: [...vector], payload_json: JSON.stringify(payload ?? {}) });
  }
  // 每条开局extra只存一行，不把两个可靠站点的同一结论重复发给玩家。
  extras.forEach((clue, index) => add({ suffix: `extra-${index + 1}`, clueId: clue.id,
    kind: clue.kind, text: clue.text, source: reliable[index % reliable.length].source,
    details: `资料渠道：回波来自${signalStory.echo.source}。${signalStory.echo.text} 监听来自${signalStory.listen.source}。${signalStory.listen.text} 协议说明：${protocol.description} 观测结论：`,
    payload: { clue: publicClue(clue, windowCells), protocol } }));
  // 正交干扰使真实SQL的每个谓词都有作用，不在JS里硬判错或伪造结果。
  add({ suffix: 'word-a', token: selected[1].keyword, text: '这是其他监听目录的军用回波，只记录设备校准，没有本任务舰队布阵结论。' });
  add({ suffix: 'word-b', token: selected[2].keyword, text: '这是另一监听目录的军用回波，只记录港口通联，没有本任务舰队布阵结论。' });
  add({ suffix: 'civil', vector: samples[1].vector, source: '民船电台', text: '民船装卸记录：回波对应运输船，不是本任务敌舰的战术线索。' });
  add({ suffix: 'noise', vector: samples[2].vector, source: '气象浮标', text: '气象浮标记录：海面杂讯不能解释为敌舰布阵。' });
  add({ suffix: 'old-mission', mission: `${evidence.missionId}-archive`, source: '历史档案', text: '上一任务的军用设备档案，任务编号不属于本次行动。' });
  const otherSector = `S${Number(original.sector_id.slice(1)) % 16 + 1}`;
  add({ suffix: 'other-sector', sector: otherSector, source: '岸基观察站', text: '其他战术海区的设备校准记录，不是当前已定位海区的线索。' });
  add({ suffix: 'expired', observedRound: 0, source: '历史档案', text: '出航前第0轮旧档案，不能当作当前行动线索。' });
  return { rows, keyword, samples, keywordOptions, signalStory };
}

/** 只构造SQL；执行和结果展示交给真实seekdb，不在此返回猜测的命中行。 */
export function buildDetailQuery(input = {}) {
  const invalid = error => ({ valid: false, sql: '', error, description: '' });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('详情检索输入格式不正确');
  const { sectorId, missionId, vector, keyword, mode = 'hybrid' } = input;
  if (!['hybrid', 'vector', 'fulltext'].includes(mode)) return invalid('请选择全文、向量或混合检索');
  const useVector = mode !== 'fulltext', useText = mode !== 'vector';
  if (typeof sectorId !== 'string' || !/^S(?:[1-9]|1[0-6])$/.test(sectorId)) return invalid('请选择已定位的有效海区');
  if (typeof missionId !== 'string' || !missionId.trim()) return invalid('缺少当前任务编号');
  if (useText && (typeof keyword !== 'string' || !keyword.trim())) return invalid('请选择详情监听关键词');
  if (useVector && (!Array.isArray(vector) || vector.length !== 8 || Array.from({ length: 8 }, (_, i) => vector[i]).some(value => !Number.isFinite(value)))) {
    return invalid('请选择有效的八维回波样本');
  }
  const encoded = useVector ? sqlLiteral(JSON.stringify(vector)) : null;
  const distance = useVector ? `l2_distance(embedding, ${encoded})` : 'NULL';
  const sql = [
    'SELECT clue_id, kind, clue_text, source, body, payload_json,',
    `  ${distance} AS distance`,
    'FROM tactical_observations',
    `WHERE mission_id = ${sqlLiteral(missionId)}`,
    `  AND sector_id = ${sqlLiteral(sectorId)}`,
    '  AND observed_round >= 1',
    ...(useText ? [`  AND MATCH(body) AGAINST (${sqlLiteral(keyword.trim())} IN NATURAL LANGUAGE MODE)`] : []),
    ...(useVector ? [`  AND ${distance} <= 0.42`] : []),
    'ORDER BY distance, id',
    'LIMIT 6',
  ].join('\n');
  return { valid: true, sql, error: null,
    description: mode === 'hybrid' ? '组合监听关键词与八维人工回波，读取当前任务、当前海区的固定额外线索。'
      : mode === 'vector' ? '仅比对回波相似度，同类信号的其他目录也可能返回；尚未使用监听关键词。'
        : '仅按监听关键词查目录，民船和天气记录也可能同词；尚未比对回波。' };
}
