// 只适配 observer 日志轮转，以及 local/allocation.tmp 的关闭前删除。
// allocation.tmp 是 Rust KV 开库时重建的临时分配表；data、lock、CLOG、SST 不适用延迟删除。
const LOG_NAME = /^observer\.log(?:\..*)?$/;
const logAccessFiles = new Map();
const accessFileHandles = new Map();
// fileID和accessID都可复用；每次登记都生成新对象，防止await后把新FD当成原FD。
const accessOwners = new Map();
const pendingRuntimeDeletes = new Set();

export function trackLogAccess(accessID, fileID, fileHandle) {
  logAccessFiles.set(accessID, fileID);
  accessOwners.set(accessID, {fileID, closedForMove:false});
  if (fileHandle) accessFileHandles.set(accessID, fileHandle);
  else accessFileHandles.delete(accessID);
}

export function untrackLogAccess(accessID) {
  logAccessFiles.delete(accessID);
  accessFileHandles.delete(accessID);
  accessOwners.delete(accessID);
}

function ownsSlot(accessID, owner, allocator, handle) {
  return accessOwners.get(accessID) === owner && allocator.allocated[accessID] === handle;
}

async function runtimeAccessIDs(fileHandle) {
  const ids = [];
  for (const [id, handle] of accessFileHandles) {
    if (handle.name === 'allocation.tmp' && await handle.isSameEntry(fileHandle)) ids.push(id);
  }
  return ids;
}

async function pendingAtPath(parent, name) {
  for (const pending of pendingRuntimeDeletes) {
    if (pending.name === name && (pending.parent === parent
      || await pending.parent.isSameEntry(parent))) return pending;
  }
  return null;
}

function replacedTemporaryFile() {
  return new Error('待删除的 allocation.tmp 已被同名条目替换，未删除替代文件。');
}

async function finishRuntimeDelete(pending) {
  if ((await runtimeAccessIDs(pending.fileHandle)).length) return;
  let current;
  try {
    current = await pending.parent.getFileHandle(pending.name);
  } catch (error) {
    // 仅已登记的延迟删除允许把条目消失视为完成。
    if (error?.name !== 'NotFoundError') throw error;
    pendingRuntimeDeletes.delete(pending);
    return;
  }
  if (!await pending.fileHandle.isSameEntry(current)) throw replacedTemporaryFile();
  await pending.parent.removeEntry(pending.name);
  pendingRuntimeDeletes.delete(pending);
}

export async function removeRuntimeChild(parent, name) {
  if (parent.name !== 'local' || name !== 'allocation.tmp') return await parent.removeEntry(name);

  const previous = await pendingAtPath(parent, name);
  let fileHandle;
  try {
    fileHandle = await parent.getFileHandle(name);
  } catch (error) {
    if (!previous || error?.name !== 'NotFoundError') throw error;
    pendingRuntimeDeletes.delete(previous);
    return;
  }
  if (previous && !await previous.fileHandle.isSameEntry(fileHandle)) throw replacedTemporaryFile();
  const ids = await runtimeAccessIDs(fileHandle);
  if (ids.length) {
    if (!previous) pendingRuntimeDeletes.add({parent, name, fileHandle});
    // Rust Allocation::drop 返回后立即关闭其 file 字段，最后一次 close 再完成实际 unlink。
    return;
  }
  if (previous) return await finishRuntimeDelete(previous);
  return await parent.removeEntry(name);
}

export async function closeTrackedAccess(accessID, allocator) {
  const owner = accessOwners.get(accessID);
  // 轮转已临时关闭同步句柄，但C++此时仍可主动关闭其原逻辑FD。
  if (owner?.closedForMove && ownsSlot(accessID, owner, allocator, undefined)) {
    untrackLogAccess(accessID);
    allocator.free(accessID);
    return;
  }
  const access = allocator.get(accessID);
  const handle = accessFileHandles.get(accessID);
  const pending = [];
  if (handle?.name === 'allocation.tmp') {
    for (const entry of pendingRuntimeDeletes) {
      const same = await handle.isSameEntry(entry.fileHandle);
      if (!ownsSlot(accessID, owner, allocator, access)) return;
      if (same) pending.push(entry);
    }
  }
  try {
    await access.close();
  } catch (error) {
    // 只有参与延迟删除的临时文件保留槽位以便重试；其余沿用原 loader 报错后仍 free 的行为。
    if (!pending.length && ownsSlot(accessID, owner, allocator, access)) {
      untrackLogAccess(accessID); allocator.free(accessID);
    }
    throw error;
  }
  if (ownsSlot(accessID, owner, allocator, access)) {
    untrackLogAccess(accessID);
    allocator.free(accessID);
  }
  try {
    for (const entry of pending) await finishRuntimeDelete(entry);
  } catch (error) {
    // 句柄已经关闭并释放，保留待删登记；调用方不能再次 free，可重新调用 removeRuntimeChild 重试。
    const failure = new Error('OPFS 临时文件句柄已关闭，但延迟删除未完成。', {cause: error});
    failure.accessClosed = true;
    throw failure;
  }
}

export async function moveWithLogHandles(fileID, fileHandle, newDir, name, allocator) {
  if (!LOG_NAME.test(fileHandle.name) && !LOG_NAME.test(name)) {
    return await fileHandle.move(newDir, name);
  }

  const accessIDs = [...logAccessFiles].filter(([, trackedFile]) => trackedFile === fileID).map(([id]) => id);
  const closedIDs = [];
  const reopenErrors = [];
  let failure = null;
  let result;
  try {
    for (const id of accessIDs) {
      const owner = accessOwners.get(id);
      if (!owner || owner.fileID !== fileID) continue;
      const access = allocator.get(id);
      await access.flush();
      if (!ownsSlot(id, owner, allocator, access)) continue;
      // 即使 close 报错，也尝试恢复该槽位；恢复失败会明确上抛。
      const entry = {id, owner, expectedSlot:access};
      closedIDs.push(entry);
      await access.close();
      if (ownsSlot(id, owner, allocator, access)) {
        owner.closedForMove = true;
        allocator.allocated[id] = undefined;
        entry.expectedSlot = undefined;
      }
    }
    result = await fileHandle.move(newDir, name);
  } catch (error) {
    failure = {error};
  } finally {
    for (const {id, owner, expectedSlot} of closedIDs) {
      // 若调用方在 await 期间已关闭或复用槽位，不复活旧 FD。
      if (!ownsSlot(id, owner, allocator, expectedSlot)) continue;
      try {
        const access = fileHandle.createSyncAccessHandle.length === 0
          ? await fileHandle.createSyncAccessHandle()
          : await fileHandle.createSyncAccessHandle({mode: 'in-place'});
        if (!ownsSlot(id, owner, allocator, expectedSlot)) {
          // 新句柄属于本次过期的重开请求，关闭失败也必须作为恢复失败向上报告。
          await access.close();
          continue;
        }
        // C++ 仍持有原 FD 的逻辑偏移，只替换同步访问句柄，不重新分配 ID。
        allocator.allocated[id] = access;
        owner.closedForMove = false;
      } catch (error) {
        reopenErrors.push(error);
      }
    }
  }

  if (reopenErrors.length) {
    const errors = [...(failure ? [failure.error] : []), ...reopenErrors];
    throw new AggregateError(errors, 'OPFS 日志移动后的访问句柄未能完整恢复。', {cause: failure ? failure.error : reopenErrors[0]});
  }
  if (failure) throw failure.error;
  return result;
}
