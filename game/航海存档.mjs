const CATALOG = '`seekdb_naval_catalog`.`active_game`';
const SCHEMA_VERSION = 1;
let lastTimestamp = -1n;

export function isGameDatabaseName(name) {
  if (typeof name !== 'string') return false;
  // 比较完整匹配，避免 JavaScript 的 $ 接受末尾换行。
  return name.match(/^seekdb_naval_\d+$/)?.[0] === name;
}

function requireDatabaseName(name) {
  if (!isGameDatabaseName(name)) throw new Error('航海日志数据库名称无效。');
  return name;
}

export function makeGameDatabaseName(now = Date.now(), previous = '') {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('数据库时间戳必须是非负安全整数。');
  }
  if (previous !== '') requireDatabaseName(previous);
  const previousTimestamp = previous === '' ? -1n : BigInt(previous.slice('seekdb_naval_'.length));
  let timestamp = BigInt(now);
  if (timestamp <= previousTimestamp) timestamp = previousTimestamp + 1n;
  if (timestamp <= lastTimestamp) timestamp = lastTimestamp + 1n;
  lastTimestamp = timestamp;
  return `seekdb_naval_${timestamp}`;
}

function table(name, tableName) {
  return `\`${requireDatabaseName(name)}\`.\`${tableName}\``;
}

function literal(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''").replaceAll('\0', '\\0')}'`;
}

function serialize(value, field) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new Error(`航海日志 ${field} 无法序列化。`, {cause: error});
  }
  if (json === undefined) throw new Error(`航海日志 ${field} 必须是可序列化的 JSON。`);
  return json;
}

function parseJson(value, field) {
  if (typeof value !== 'string') throw new Error(`航海日志 ${field} 格式损坏。`);
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`航海日志 ${field} 不是有效 JSON。`, {cause: error});
  }
}

function revisionNumber(value) {
  if (!((typeof value === 'string' && /^\d+$/.test(value)) || typeof value === 'number')) {
    throw new Error('航海日志版本号无效。');
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('航海日志版本号无效。');
  return revision;
}

function resetIntent(value) {
  const reset = parseJson(value, 'reset_json');
  if (!reset || typeof reset !== 'object' || Array.isArray(reset)) throw new Error('航海日志重置意图格式损坏。');
  if (reset.oldDatabase !== null) requireDatabaseName(reset.oldDatabase);
  requireDatabaseName(reset.newDatabase);
  if (reset.oldDatabase === reset.newDatabase) throw new Error('重置前后数据库不能相同。');
  return {oldDatabase: reset.oldDatabase, newDatabase: reset.newDatabase};
}

export class NavalArchive {
  writing = false;
  revision = 0;
  #db;
  #queue = Promise.resolve();
  #pending = 0;
  #revisionDatabase = null;

  constructor(db) {
    if (typeof db?.exec !== 'function' || typeof db?.query !== 'function') {
      throw new TypeError('航海日志需要提供 exec/query 的数据库连接。');
    }
    this.#db = db;
  }

  // 串行处理，避免并发存档分配同一版本，也避免提前解除 trace 屏蔽。
  #run(work) {
    this.#pending += 1;
    this.writing = true;
    const task = this.#queue.then(work);
    this.#queue = task.catch(() => {});
    return task.finally(() => {
      this.#pending -= 1;
      this.writing = this.#pending > 0;
    });
  }

  initCatalog() {
    return this.#run(async () => {
      await this.#db.exec('CREATE DATABASE IF NOT EXISTS `seekdb_naval_catalog`');
      await this.#db.exec(`CREATE TABLE IF NOT EXISTS ${CATALOG} (slot INT PRIMARY KEY, database_name VARCHAR(64), reset_json LONGTEXT)`);
      const {rows} = await this.#db.query(`SELECT database_name, reset_json FROM ${CATALOG} WHERE slot = 1`);
      if (!rows?.length) return {databaseName: null, reset: null};
      const row = rows[0];
      const databaseName = row.database_name === null ? null : requireDatabaseName(row.database_name);
      const reset = row.reset_json === null ? null : resetIntent(row.reset_json);
      return {databaseName, reset};
    });
  }

  beginReset(oldName, newName) {
    return this.#run(async () => {
      const oldDatabase = oldName === null || oldName === '' ? null : requireDatabaseName(oldName);
      const newDatabase = requireDatabaseName(newName);
      if (oldDatabase === newDatabase) throw new Error('重置前后数据库不能相同。');
      const reset = serialize({oldDatabase, newDatabase}, 'reset_json');
      await this.#db.exec(`REPLACE INTO ${CATALOG} (slot, database_name, reset_json) VALUES (1, ${oldDatabase === null ? 'NULL' : literal(oldDatabase)}, ${literal(reset)})`);
    });
  }

  finishReset(newName) {
    return this.#run(async () => {
      requireDatabaseName(newName);
      await this.#db.exec(`REPLACE INTO ${CATALOG} (slot, database_name, reset_json) VALUES (1, ${literal(newName)}, NULL)`);
    });
  }

  initGame(name) {
    return this.#run(async () => {
      requireDatabaseName(name);
      await this.#db.exec(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
      await this.#db.exec(`CREATE TABLE IF NOT EXISTS ${table(name, 'naval_current')} (slot INT PRIMARY KEY, schema_version INT, revision BIGINT, payload_json LONGTEXT, pending_json LONGTEXT, updated_at VARCHAR(40))`);
      await this.#db.exec(`CREATE TABLE IF NOT EXISTS ${table(name, 'naval_history')} (revision BIGINT PRIMARY KEY, label VARCHAR(80), payload_json LONGTEXT, pending_json LONGTEXT, sql_json LONGTEXT, created_at VARCHAR(40))`);
      if (this.#revisionDatabase !== name) {
        this.#revisionDatabase = name;
        this.revision = 0;
      }
    });
  }

  load(name) {
    return this.#run(async () => {
      const {rows} = await this.#db.query(`SELECT schema_version, revision, payload_json, pending_json FROM ${table(name, 'naval_current')} WHERE slot = 1`);
      if (!rows?.length) {
        this.#revisionDatabase = name;
        this.revision = 0;
        return null;
      }
      const row = rows[0];
      if (Number(row.schema_version) !== SCHEMA_VERSION) throw new Error(`不支持的航海日志格式版本：${row.schema_version}。`);
      const revision = revisionNumber(row.revision);
      const payload = parseJson(row.payload_json, 'payload_json');
      const pending = row.pending_json === null ? null : parseJson(row.pending_json, 'pending_json');
      this.#revisionDatabase = name;
      this.revision = revision;
      return {payload, pending, revision};
    });
  }

  save(name, payload, {pending = null, label = '自动存档', sql = []} = {}) {
    return this.#run(async () => {
      const currentTable = table(name, 'naval_current');
      const historyTable = table(name, 'naval_history');
      if (typeof label !== 'string') throw new TypeError('航海日志标题必须是字符串。');
      if (!Array.isArray(sql)) throw new TypeError('航海日志 SQL 记录必须是数组。');
      const payloadJson = literal(serialize(payload, 'payload_json'));
      const pendingJson = pending === null ? 'NULL' : literal(serialize(pending, 'pending_json'));
      const sqlJson = literal(serialize(sql, 'sql_json'));
      const revision = revisionNumber(this.#revisionDatabase === name ? this.revision : 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('航海日志版本号超出安全范围。');
      const timestamp = literal(new Date().toISOString());
      try {
        await this.#db.exec('BEGIN');
        await this.#db.exec(`REPLACE INTO ${currentTable} (slot, schema_version, revision, payload_json, pending_json, updated_at) VALUES (1, ${SCHEMA_VERSION}, ${revision}, ${payloadJson}, ${pendingJson}, ${timestamp})`);
        await this.#db.exec(`INSERT INTO ${historyTable} (revision, label, payload_json, pending_json, sql_json, created_at) VALUES (${revision}, ${literal(label)}, ${payloadJson}, ${pendingJson}, ${sqlJson}, ${timestamp})`);
        await this.#db.exec('COMMIT');
      } catch (error) {
        // 保留原始错误；回滚本身失败不能把写入失败伪装成另一类结果。
        try { await this.#db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      this.#revisionDatabase = name;
      this.revision = revision;
      return {revision};
    });
  }

  history(name, limit = 20) {
    return this.#run(async () => {
      const historyTable = table(name, 'naval_history');
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('航海日志条数必须是正整数。');
      const {rows} = await this.#db.query(`SELECT revision, label, payload_json, pending_json, sql_json, created_at FROM ${historyTable} ORDER BY revision DESC LIMIT ${limit}`);
      return rows;
    });
  }
}
