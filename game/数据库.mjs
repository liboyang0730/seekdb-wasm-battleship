import {Database} from './engine/database.mjs';

// 只使用本地 seekdb WebAssembly 引擎；每条 SQL 在同一会话中依次执行。
export class NavalDB {
  #database;
  #session;
  #queue = Promise.resolve();
  #decoder = new TextDecoder();
  engineVersion = '';
  onQuery = null;

  static async open(onProgress = () => {}) {
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      throw new Error('请通过“启动游戏.command”打开游戏，本地服务需要启用 COOP/COEP。');
    }
    onProgress('正在加载真实 seekdb WebAssembly 引擎…');
    const instance = new NavalDB();
    const moduleURL = new URL('./engine/seekdb_wasm_database.mjs', import.meta.url);
    // 与官方 shell 一致，为 Safari 选择 WebKit 引擎构建。
    const wasmFile = navigator.vendor === 'Apple Computer, Inc.'
      ? './engine/seekdb_wasm_database.webkit.wasm' : './engine/seekdb_wasm_database.wasm';
    const wasmURL = new URL(wasmFile, import.meta.url);
    instance.#database = await Database.open({moduleURL, wasmURL, storage: 'opfs'});
    onProgress('正在连接浏览器内的 seekdb SQL 会话…');
    instance.#session = await instance.#database.connect();
    const version = await instance.query('SELECT VERSION() AS version');
    instance.engineVersion = version.rows[0]?.version ?? 'seekdb WebAssembly';
    onProgress(`seekdb ${instance.engineVersion} 已就绪`);
    return instance;
  }

  query(sql) {
    const run = async () => {
      const started = performance.now();
      let columns = [];
      const rows = [];
      try { for await (const event of this.#session.query(sql)) {
        if (event.kind === 'columns') {
          columns = event.columns.map(column => this.#decoder.decode(column.name));
        } else if (event.kind === 'row') {
          rows.push(Object.fromEntries(event.values.map((value, index) => [
            columns[index] ?? String(index), value === null ? null : this.#decoder.decode(value),
          ])));
        }
      }
      const result = {rows, elapsedMs: performance.now() - started};
      try { this.onQuery?.({sql, ...result}); } catch { /* 记录失败不能更改SQL结果。 */ }
      return result;
      } catch (error) {
        try { this.onQuery?.({sql, rows: [], elapsedMs: performance.now() - started, error: error.message}); } catch { /* 保留原始SQL异常。 */ }
        throw error;
      }
    };
    const result = this.#queue.then(run);
    // 单条 SQL 报错后，后续队列仍可继续；错误原样交给调用方。
    this.#queue = result.catch(() => {});
    return result;
  }

  exec(sql) { return this.query(sql); }

  async close() {
    await this.#queue;
    await this.#session.close();
    await this.#database.close();
  }
}
