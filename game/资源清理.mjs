/** 仅管理本游戏生成的临时表；SQL由调用方执行，固定业务表不进入登记表。 */
const DYNAMIC_NAME = /^(?:notes_main_\d+|(?:live|checkpoint|notes_work|checkpoint_edit|live_restore|notes_after)_\d+_\d+_\d+)$/;
const validName = name => typeof name === 'string' && name.match(DYNAMIC_NAME)?.[0] === name;

export class DynamicTableResources {
  #tables = new Map();

  get size() { return this.#tables.size; }

  entries() { return [...this.#tables].map(([name, parent]) => ({ name, parent })); }

  restore(entries = []) {
    const next = new Map();
    for (const {name, parent} of entries) {
      if (!validName(name) || (parent !== null && !validName(parent)) || next.has(name)) throw new Error('存档中的分支登记无效');
      next.set(name, parent);
    }
    for (const name of next.keys()) {
      const visited = new Set(); let current = name;
      while (current !== null) {
        if (!next.has(current) || visited.has(current)) throw new Error('存档中的分支父链无效');
        visited.add(current); current = next.get(current);
      }
    }
    this.#tables = next;
  }

  async create(name, create, parent = null) {
    if (!validName(name)) throw new TypeError('只允许登记本游戏生成的动态表');
    if (this.#tables.has(name)) throw new Error('动态表重复登记');
    if (parent !== null && !this.#tables.has(parent)) throw new Error('Fork父表尚未登记');
    if (typeof create !== 'function') throw new TypeError('缺少动态表创建操作');
    const result = await create();
    // 登记表独立于游戏快照，动作回滚后仍能找到已经成功创建的孤立表。
    this.#tables.set(name, parent);
    return result;
  }

  async cleanup({ keep = [], drop, warn = () => {} } = {}) {
    if (typeof drop !== 'function') throw new TypeError('缺少动态表删除操作');
    const protectedNames = new Set();
    for (const name of keep) {
      let current = name;
      while (this.#tables.has(current) && !protectedNames.has(current)) {
        protectedNames.add(current);
        current = this.#tables.get(current);
      }
    }
    const attempted = new Set(), dropped = [], failures = [];
    for (;;) {
      // 所有仍存在的子表都保护父源，包括本次DROP失败而等待重试的分支。
      const parents = new Set(this.#tables.values());
      const leaves = [...this.#tables.keys()].filter(name => !protectedNames.has(name)
        && !parents.has(name) && !attempted.has(name));
      if (!leaves.length) break;
      for (const name of leaves) {
        attempted.add(name);
        try {
          await drop(name);
          this.#tables.delete(name);
          dropped.push(name);
        } catch (error) {
          failures.push({ name, error });
          // 清理失败不能令成功动作回滚到可能已经删除的旧表。
          try { warn(name, error); } catch { /* 警告回调也不能改变游戏动作结果。 */ }
        }
      }
    }
    return { dropped, failures, remaining: [...this.#tables.keys()] };
  }
}
