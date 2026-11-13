(() => {
  'use strict';
  const base = new URL('./', document.baseURI);
  const workerURL = new URL('service-worker.js', base);
  const engineKey = navigator.vendor === 'Apple Computer, Inc.' ? 'webkit' : 'chrome';
  const reloadKey = `seekdb-battleship-coi:${base.pathname}`;
  const status = document.getElementById('launch-status');
  const start = document.getElementById('launch-start');
  const retry = document.getElementById('launch-retry');
  let preparing = false, ready = false;

  function message(text, failed = false) {
    status.textContent = text;
    status.dataset.tone = failed ? 'error' : 'info';
  }

  function timeout(promise, milliseconds, text) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(text)), milliseconds);
    })]).finally(() => clearTimeout(timer));
  }

  function ourController() {
    const script = navigator.serviceWorker.controller?.scriptURL;
    return Boolean(script && new URL(script).href === workerURL.href);
  }

  async function checkGameLock() {
    if (typeof navigator.locks?.query !== 'function') return;
    const occupied = '同一浏览器已有游戏正在运行。请先关闭原游戏标签页，稍候再点击“重试准备”；不要清理网站数据。';
    const deadline = performance.now() + 3500;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(occupied);
      const {held} = await timeout(navigator.locks.query(), remaining, occupied);
      if (!held.some(lock => lock.name === 'seekdb-wasm-opfs')) return;
      // 页面离开后旧 Worker 可能稍晚才释放锁；仅查询等待，不申请锁或打开数据库。
      const wait = Math.min(150, deadline - performance.now());
      if (wait <= 0) throw new Error(occupied);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }

  function waitForController() {
    if (ourController()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', changed);
        error ? reject(error) : resolve();
      };
      const changed = () => { if (ourController()) finish(); };
      const timer = setTimeout(() => finish(new Error('网页隔离尚未接管，请点击“重试准备”。')), 15000);
      navigator.serviceWorker.addEventListener('controllerchange', changed);
      changed();
    });
  }

  function cacheGame() {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      let finished = false;
      const timer = setTimeout(() => finish(new Error('游戏下载超时。请检查网络后点击“重试准备”，已成功的分块会继续复用；已保存的战役不受影响。')), 600000);
      function finish(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer); channel.port1.close(); channel.port2.close();
        error ? reject(error) : resolve();
      }
      channel.port1.onmessage = event => {
        if (finished) return;
        const data = event.data;
        if (data?.type === 'progress') {
          if (data.stage === 'game') message('正在缓存游戏界面，随后下载当前浏览器所需的引擎分块…');
          else if (Number.isInteger(data.completed) && Number.isInteger(data.total)) {
            message(`正在准备${engineKey === 'webkit' ? 'Safari' : '当前浏览器'}引擎：已缓存 ${data.completed} / ${data.total} 块。首次约 18 MB；失败后可点击重试，保留已成功的分块。`);
          }
          return;
        }
        if (data?.ok === true) finish();
        else if (data?.ok === false) finish(new Error(data.error || '游戏缓存失败，请重试。'));
      };
      navigator.serviceWorker.controller.postMessage({type:'prepare-game',engineKey}, [channel.port2]);
    });
  }

  async function prepare() {
    if (preparing) return;
    preparing = true; ready = false; start.disabled = true; retry.hidden = true;
    try {
      if (!window.isSecureContext || !('serviceWorker' in navigator)) {
        throw new Error('请通过 HTTPS 试玩网址打开，并使用支持 Service Worker 的现代桌面浏览器。');
      }
      if (!navigator.storage?.getDirectory || !navigator.locks) {
        throw new Error('当前浏览器缺少 OPFS 或 Web Locks，无法安全保存真实 seekdb 战役。请使用新版 Safari、Chrome、Edge 或 Firefox。');
      }
      await checkGameLock();
      message('正在准备浏览器隔离环境，首次打开可能自动刷新一次…');
      // 离线时优先使用已安装的同 scope SW；更新检查失败不妨碍继续旧版。
      const existing = await navigator.serviceWorker.getRegistration(base.href);
      if (existing?.active && existing.scope === base.href && existing.active.scriptURL === workerURL.href) {
        void navigator.serviceWorker.register(workerURL.href, {scope:base.pathname, updateViaCache:'none'}).catch(()=>{});
      } else {
        await timeout(navigator.serviceWorker.register(workerURL.href, {scope:base.pathname, updateViaCache:'none'}), 20000, '隔离组件安装失败或超时，请检查网络后重试。');
      }
      const registration = await timeout(navigator.serviceWorker.ready, 20000, '隔离组件未能激活，请重试。');
      if (registration.scope !== base.href) throw new Error('试玩入口不在正确的隔离范围内，请从项目完整网址打开。');
      await waitForController();
      if (!window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
        if (sessionStorage.getItem(reloadKey)) throw new Error('当前页面未能获得线程隔离，已停止自动刷新。请重试或使用其他现代桌面浏览器；无需修改安全设置。');
        sessionStorage.setItem(reloadKey, '1');
        window.location.reload();
        return;
      }
      sessionStorage.removeItem(reloadKey);
      message('正在准备分块缓存（首次约 18 MB），只下载当前浏览器所需引擎。完成后可断网重访；尚未启动数据库。');
      await cacheGame();
      await checkGameLock();
      ready = true; start.disabled = false;
      message('资源已缓存。点击“进入游戏”后启动真实 seekdb；本网页存档与本地离线包分别保存。');
    } catch (error) {
      message(error.message || '试玩准备失败，请稍后重试。', true);
      retry.hidden = false;
    } finally { preparing = false; }
  }

  start.addEventListener('click', async()=>{
    if (!ready || preparing) return;
    start.disabled = true;
    try {
      await checkGameLock();
      if (!ourController() || !window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('隔离环境已改变，请重试准备。');
      window.location.assign(new URL('game.html', base).href);
    } catch (error) { ready=false;message(error.message,true);retry.hidden=false; }
  });
  retry.addEventListener('click', ()=>{
    try { sessionStorage.removeItem(reloadKey); } catch { /* 存储不可用时由准备流程明确报错。 */ }
    void prepare();
  });
  void prepare();
})();
