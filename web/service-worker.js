// 同一个 SW 负责隔离响应头和静态缓存；不打开数据库，也不接触 OPFS 存档。
const CACHE_PREFIX = 'seekdb-battleship-static-';
const CACHE_NAME = `${CACHE_PREFIX}v0.2.1-__BUILD_ID__`;
const ROOT = new URL(self.registration.scope);
const SHELL = ['index.html', 'launch.js', 'styles.css', 'logo.svg'];
const GAME = new URL('game.html', ROOT).href;
const CACHED_URLS = new Set([...SHELL.map(name => new URL(name, ROOT).href), GAME]);
let preparingGame;

function inScope(url) {
  return url.origin === ROOT.origin && url.pathname.startsWith(ROOT.pathname);
}

function cacheKey(url) {
  const key = new URL(url);
  key.search = ''; key.hash = '';
  if (key.pathname === ROOT.pathname) return new URL('index.html', ROOT).href;
  return key.href;
}

function isolated(response) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {status:response.status, statusText:response.statusText, headers});
}

async function download(url, cache) {
  if (!inScope(new URL(url))) throw new Error('拒绝缓存此试玩站点以外的资源。');
  const response = await fetch(new Request(url, {cache:'reload', redirect:'error'}));
  if (!response.ok || response.status !== 200) throw new Error(`资源下载失败（HTTP ${response.status}）。`);
  if (url === GAME && !response.headers.get('Content-Type')?.includes('text/html')) {
    throw new Error('游戏资源不是有效的 HTML，请稍后重试。');
  }
  // put 完成才表示响应体已完整缓存，失败时不报告“离线就绪”。
  await cache.put(url, response.clone());
  return response;
}

async function prepareGame() {
  if (preparingGame) return preparingGame;
  preparingGame = (async()=>{
    const cache = await caches.open(CACHE_NAME);
    if (!await cache.match(GAME)) await download(GAME, cache);
    return {ok:true, version:'v0.2.1'};
  })();
  try { return await preparingGame; }
  finally { preparingGame = null; }
}

self.addEventListener('install', event => {
  // 不调用 skipWaiting：新版本等待旧页面关闭，不中断正在玩的战役。
  event.waitUntil((async()=>{
    const cache = await caches.open(CACHE_NAME);
    for (const name of SHELL) await download(new URL(name, ROOT).href, cache);
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async()=>{
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'prepare-game' || !event.ports?.[0]) return;
  try { if (!event.source?.url || !inScope(new URL(event.source.url))) return; }
  catch { return; }
  event.waitUntil(prepareGame().then(
    result => event.ports[0].postMessage(result),
    error => event.ports[0].postMessage({ok:false, error:error.message || '游戏下载失败。'}),
  ));
});

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || !inScope(url)) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith((async()=>{
    try {
      const key = cacheKey(url), cache = await caches.open(CACHE_NAME);
      let response = CACHED_URLS.has(key) ? await cache.match(key) : null;
      if (!response) response = CACHED_URLS.has(key) ? await download(key, cache) : await fetch(request);
      // 从缓存读取时同样补头，保证断网导航仍有跨源隔离。
      return isolated(response);
    } catch {
      return isolated(new Response('游戏资源尚未完整缓存。请联网后返回试玩入口，点击“重试准备”。', {
        status:503, headers:{'Content-Type':'text/plain; charset=utf-8'},
      }));
    }
  })());
});
