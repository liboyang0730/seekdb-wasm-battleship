// 同一个 SW 负责隔离响应头和分块缓存；不打开数据库，也不接触 OPFS 存档。
const VERSION = 'v0.2.1';
const CACHE_PREFIX = 'seekdb-battleship-static-';
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}-__BUILD_ID__`;
const ROOT = new URL(self.registration.scope);
const SHELL = ['index.html', 'launch.js', 'styles.css', 'logo.svg', 'assets.json'];
const MANIFEST = new URL('assets.json', ROOT).href;
const jobs = new Map();
const SHA256 = /^[a-f0-9]{64}$/;

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

function validateManifest(value) {
  if (value?.version !== VERSION || value.game?.path !== 'game.html'
      || !Number.isSafeInteger(value.game.bytes) || value.game.bytes < 1 || !SHA256.test(value.game.sha256)) {
    throw new Error('游戏资源清单格式或版本不匹配。');
  }
  const files = new Map(SHELL.map(path=>[new URL(path, ROOT).href,null]));
  files.set(new URL(value.game.path, ROOT).href,{...value.game,kind:'game'});
  for (const key of ['chrome','webkit']) {
    const engine = value.engines?.[key];
    if (!Array.isArray(engine?.chunks) || !engine.chunks.length || !SHA256.test(engine.gzipSha256)) throw new Error('引擎分块清单无效。');
    let bytes = 0;
    for (const item of engine.chunks) {
      if (typeof item.path !== 'string' || !new RegExp(`^assets/engine-${key}-[0-9]{3,}\\.bin$`).test(item.path)
          || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 1048576 || !SHA256.test(item.sha256)) {
        throw new Error('引擎分块路径、大小或校验信息无效。');
      }
      const url = new URL(item.path,ROOT);
      if (!inScope(url) || files.has(url.href)) throw new Error('分块路径越过scope或重复。');
      files.set(url.href,{...item,kind:'chunk'});bytes+=item.bytes;
    }
    if (!Number.isSafeInteger(engine.gzipBytes) || bytes !== engine.gzipBytes) throw new Error('引擎分块总大小不匹配。');
  }
  return {manifest:value,files,CACHED_SET:new Set(files.keys())};
}

async function verify(data, expected) {
  if (!expected) return;
  if (data.byteLength !== expected.bytes) throw new Error('资源大小校验失败。');
  if (expected.kind === 'chunk') {
    const digest = await crypto.subtle.digest('SHA-256',data);
    const actual = [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    if (actual !== expected.sha256) throw new Error('引擎分块SHA-256校验失败。');
  }
}

async function download(url, cache, expected = null) {
  if (!inScope(new URL(url))) throw new Error('拒绝缓存此试玩站点以外的资源。');
  let failure;
  for (let attempt=0;attempt<2;attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),40000);
    try {
      const response = await fetch(new Request(url,{cache:'reload',redirect:'error',signal:controller.signal}));
      if (!response.ok || response.status !== 200) throw new Error(`资源下载失败（HTTP ${response.status}）。`);
      if (expected?.kind === 'game' && !response.headers.get('Content-Type')?.includes('text/html')) throw new Error('游戏资源不是有效的HTML。');
      const data = await response.arrayBuffer();
      await verify(data,expected);
      if (url === MANIFEST) validateManifest(JSON.parse(await new Response(data).text()));
      // fetch已解码HTTP传输压缩；重建响应时不要再保留传输编码标记。
      const headers = new Headers(response.headers);
      headers.delete('Content-Encoding');headers.set('Content-Length',String(data.byteLength));
      const complete = new Response(data,{status:200,headers});
      await cache.put(url,complete.clone());
      return complete;
    } catch(error) {failure=error;} finally {clearTimeout(timer);}
  }
  throw new Error(`${failure?.name==='AbortError'?'资源下载超时（每次最多40秒）':failure?.message||'资源下载失败'} 已重试一次，可点击“重试准备”继续。`);
}

async function resource(url,cache,expected = null) {
  const cached = await cache.match(url);
  if (cached) {
    try {await verify(await cached.clone().arrayBuffer(),expected);return cached;}
    catch {await cache.delete(url);}
  }
  return download(url,cache,expected);
}

async function readManifest(cache) {
  const response = await resource(MANIFEST,cache);
  return validateManifest(await response.json());
}

async function prepareGame(key,notify) {
  if (!['chrome','webkit'].includes(key)) throw new Error('请选择有效的浏览器引擎。');
  let job = jobs.get(key);
  if (!job) {
    job = {listeners:new Set(),progress:null};jobs.set(key,job);
    const progress = value=>{
      job.progress={type:'progress',engineKey:key,...value};
      for (const listener of job.listeners) {try {listener(job.progress);} catch {/* 关闭的入口不影响已开始的缓存。 */}}
    };
    job.promise=(async()=>{
      const cache=await caches.open(CACHE_NAME),{manifest,files}=await readManifest(cache),chunks=manifest.engines[key].chunks;
      const total=chunks.length;let completed=0,next=0,failure;
      progress({stage:'game',completed,total});
      const gameURL=new URL(manifest.game.path,ROOT).href;
      await resource(gameURL,cache,files.get(gameURL));
      progress({stage:'chunks',completed,total});
      const fetchNext=async()=>{
        while(next<total&&!failure){
          const item=chunks[next++],url=new URL(item.path,ROOT).href;
          try {await resource(url,cache,files.get(url));completed++;progress({stage:'chunks',completed,total});}
          catch(error){failure ||= error;}
        }
      };
      await Promise.all(Array.from({length:Math.min(4,total)},fetchNext));
      if(failure)throw failure;
      return {ok:true,version:VERSION,engineKey:key,completed,total};
    })().finally(()=>jobs.delete(key));
  }
  job.listeners.add(notify);
  if(job.progress)notify(job.progress);
  try{return await job.promise;}finally{job.listeners.delete(notify);}
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
  event.waitUntil(prepareGame(event.data.engineKey,progress=>event.ports[0].postMessage(progress)).then(
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
      const key=cacheKey(url),cache=await caches.open(CACHE_NAME),{files,CACHED_SET}=await readManifest(cache);
      const response=CACHED_SET.has(key)?await resource(key,cache,files.get(key)):await fetch(request);
      // 从缓存读取时同样补头，保证断网导航仍有跨源隔离。
      return isolated(response);
    } catch {
      return isolated(new Response('游戏资源尚未完整缓存。请联网后返回试玩入口，点击“重试准备”。', {
        status:503, headers:{'Content-Type':'text/plain; charset=utf-8'},
      }));
    }
  })());
});
