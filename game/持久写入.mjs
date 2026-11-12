const defaultWait = ms => new Promise(resolve => setTimeout(resolve, ms));
const isMemstorePressure = error => error?.code === 4030 || error?.code === '4030';

/**
 * 仅重试已自行 ROLLBACK 的原子事务，或可安全重复的幂等写入/恢复操作。
 * 不能用于任意尚未回滚的事务、非幂等 DDL 或含不可重复副作用的函数。
 * 仅触发一次 Memstore 刷盘，不删除历史、不增大内存预算。
 */
export async function persistentWrite(db, work, {
  onRetry = () => {}, wait = defaultWait, maxWaitMs = 15000, intervalMs = 250,
} = {}) {
  if (typeof db?.exec !== 'function' || typeof work !== 'function') {
    throw new TypeError('持久写入需要数据库 exec 和可重试的 work 函数。');
  }
  if (typeof onRetry !== 'function' || typeof wait !== 'function') {
    throw new TypeError('持久写入的 onRetry 和 wait 必须是函数。');
  }
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('持久写入的等待预算和间隔必须是正数。');
  }
  const maxAttempts = Math.ceil(maxWaitMs / intervalMs);
  if (!Number.isSafeInteger(maxAttempts)) throw new RangeError('持久写入的重试次数超出安全范围。');

  let firstError;
  try {
    return await work();
  } catch (error) {
    if (!isMemstorePressure(error)) throw error;
    firstError = error;
  }

  try {
    await db.exec('ALTER SYSTEM MINOR FREEZE');
  } catch (error) {
    throw new AggregateError([firstError, error], '持久写入重试前的 Memstore 刷盘失败。', {cause: error});
  }

  let lastError = firstError;
  let waitedMs = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 状态提示失效不能更改数据库写入的结果。
    try { await onRetry({attempt, lastError}); } catch {}
    const delay = Math.min(intervalMs, maxWaitMs - waitedMs);
    await wait(delay);
    waitedMs += delay;
    try {
      return await work();
    } catch (error) {
      if (!isMemstorePressure(error)) throw error;
      lastError = error;
    }
  }
  throw firstError;
}
