// 同一个 SW 负责隔离响应头和分块缓存；不打开数据库，也不接触 OPFS 存档。
const VERSION = 'v0.2.1';
const CACHE_PREFIX = 'seekdb-battleship-static-';
const ROOT = new URL(self.registration.scope);
const SCOPE_CACHE_PREFIX = `${CACHE_PREFIX}${encodeURIComponent(ROOT.pathname)}:`;
const CACHE_NAME = `${SCOPE_CACHE_PREFIX}${VERSION}-__BUILD_ID__`;
// 块用内容SHA寻址，代码或文案更新不会迫使官方引擎重新下载。
const BLOCK_CACHE = 'seekdb-battleship-blocks-v1';
const BLOCK_ROOT = new URL('__seekdb_blocks__/', ROOT);
const SHELL = ['index.html', 'launch.js', 'styles.css', 'logo.svg', 'assets.json'];
const MANIFEST = new URL('assets.json', ROOT).href;
const jobs = new Map();
const verifiedBlocks = new Set(), blockJobs = new Map(), verifiedGames = new Set();
let manifestPromise;
const SHA256 = /^[a-f0-9]{64}$/;
// 候选镜像默认关闭；仅固定提交的完整资源描述指纹一致时允许尝试。
const CDN_ROOT = new URL('https://cdn.jsdelivr.net/gh/liboyang0730/seekdb-wasm-battleship@c124fb775e397e24bee71b95901302434c4a1dde/');
const CDN_MANIFEST_SIGNATURE = '160d3aac69d34e89065988809394e17927ed4b2e74d8c09e688e80b7965e593e';

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
  function blocks(items,pattern,kind,expectedBytes) {
    if (!Array.isArray(items) || !items.length) throw new Error('分块清单无效。');
    let bytes=0;
    for (let index=0;index<items.length;index++) {
      const item=items[index],path=`assets/${pattern}-${String(index).padStart(3,'0')}.bin`;
      if (item.path!==path || !Number.isSafeInteger(item.bytes) || item.bytes<1 || item.bytes>262144 || !SHA256.test(item.sha256)) {
        throw new Error('分块路径、大小或校验信息无效。');
      }
      const url=new URL(item.path,ROOT);
      if (!inScope(url) || files.has(url.href)) throw new Error('分块路径越过scope或重复。');
      files.set(url.href,{...item,kind});bytes+=item.bytes;
    }
    if (!Number.isSafeInteger(expectedBytes) || bytes!==expectedBytes) throw new Error('分块总大小不匹配。');
  }
  blocks(value.game.chunks,'game','game-chunk',value.game.bytes);
  for (const key of ['chrome','webkit']) {
    const engine = value.engines?.[key];
    if (!SHA256.test(engine?.gzipSha256)) throw new Error('引擎分块清单无效。');
    blocks(engine.chunks,`engine-${key}`,'chunk',engine.gzipBytes);
  }
  return {manifest:value,files,CACHED_SET:new Set(files.keys())};
}

async function digestHex(data) {
  const digest=await crypto.subtle.digest('SHA-256',data);
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

async function mirrorPolicy(manifest,useCDN) {
  let enabled=false;
  if(useCDN===true) {
    const signature=[
      [manifest.game.path,manifest.game.bytes,manifest.game.sha256],
      manifest.game.chunks.map(item=>[item.path,item.bytes,item.sha256]),
      ...['chrome','webkit'].map(key=>[key,manifest.engines[key].gzipBytes,manifest.engines[key].gzipSha256,
        manifest.engines[key].chunks.map(item=>[item.path,item.bytes,item.sha256])]),
    ];
    enabled=await digestHex(await new Response(JSON.stringify(signature)).arrayBuffer())===CDN_MANIFEST_SIGNATURE;
  }
  return {enabled,failed:false,cdn:0,sameOrigin:0,fallback:0};
}

function mirrorURL(item) {
  if(!['chunk','game-chunk'].includes(item?.kind)||!/^assets\/(?:game|engine-chrome|engine-webkit)-\d{3}\.bin$/.test(item.path)) {
    throw new Error('拒绝不在固定镜像白名单中的资源。');
  }
  return new URL(item.path,CDN_ROOT).href;
}

async function verify(data, expected) {
  if (!expected) return;
  if (data.byteLength !== expected.bytes) throw new Error('资源大小校验失败。');
  if (expected.sha256) {
    const actual = await digestHex(data);
    if (actual !== expected.sha256) throw new Error('资源SHA-256校验失败。');
  }
}

async function download(url, cache, expected = null, cdn = false) {
  if(cdn ? url!==mirrorURL(expected) : !inScope(new URL(url)))throw new Error('拒绝缓存此试玩站点以外的资源。');
  const idleMs=cdn?8000:40000,absoluteMs=cdn?20000:180000,attemptLimit=cdn?1:2;
  let failure;
  for (let attempt=0;attempt<attemptLimit;attempt++) {
    const controller = new AbortController();
    let idleTimer,reader;
    const abort = message=>controller.abort(Object.assign(new Error(message),{name:'AbortError'}));
    const resetIdle = ()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>abort(`${idleMs/1000}秒未收到新数据，下载超时。`),idleMs);};
    const absoluteTimer=setTimeout(()=>abort(`下载达到${absoluteMs/1000}秒总时限。`),absoluteMs);
    const aborted=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
    resetIdle();
    try {
      // 内容SHA块允许复用HTTP缓存；若失败或校验不符，第二次必须绕过旧HTTP缓存。
      const cacheMode=attempt===0&&(expected?.kind==='chunk'||expected?.kind==='game-chunk')?'default':'reload';
      const options={cache:cacheMode,redirect:'error',signal:controller.signal};
      if(cdn){options.mode='cors';options.credentials='omit';}
      const response = await Promise.race([fetch(new Request(url,options)),aborted]);
      if (!response.ok || response.status !== 200) throw new Error(`资源下载失败（HTTP ${response.status}）。`);
      resetIdle();
      reader=response.body.getReader();
      const parts=[];let received=0;
      for (;;) {
        const {done,value}=await Promise.race([reader.read(),aborted]);
        if (done) break;
        if (value.byteLength) {
          received+=value.byteLength;
          if (expected && received>expected.bytes) throw new Error('接收到的资源超出声明大小。');
          parts.push(value);resetIdle();
        }
      }
      // 网络完成后停止网络计时；本地SHA与Cache写入不再被误判为网络闲置。
      clearTimeout(idleTimer);clearTimeout(absoluteTimer);
      const data=new Uint8Array(received);let offset=0;
      for (const part of parts) {data.set(part,offset);offset+=part.byteLength;}
      await verify(data,expected);
      if (url === MANIFEST) validateManifest(JSON.parse(await new Response(data).text()));
      // fetch已解码HTTP传输压缩；重建响应时不要再保留传输编码标记。
      const headers = new Headers(response.headers);
      headers.delete('Content-Encoding');headers.set('Content-Length',String(data.byteLength));
      const target=expected?.kind==='chunk'||expected?.kind==='game-chunk'?blockKey(expected):url;
      await cache.put(target,new Response(data,{status:200,headers}));
      return new Response(data,{status:200,headers});
    } catch(error) {failure=error;} finally {
      clearTimeout(idleTimer);clearTimeout(absoluteTimer);
      if(reader)void reader.cancel().catch(()=>{});
      else if(!controller.signal.aborted)controller.abort();
    }
  }
  throw new Error(`${failure?.message||'资源下载失败'}${cdn?'':' 已重试一次，可点击“重试准备”继续。'}`);
}

async function resource(url,cache,expected = null) {
  if (expected?.kind==='chunk'||expected?.kind==='game-chunk') return block(expected);
  const cached = await cache.match(url);
  if (cached) {
    if (!expected) return cached;
    try {
      const data=await cached.arrayBuffer();await verify(data,expected);
      return new Response(data,{status:200,headers:cached.headers});
    }
    catch {await cache.delete(url);}
  }
  return download(url,cache,expected);
}

async function readManifest(cache) {
  if (!manifestPromise) manifestPromise=(async()=>{
    const response=await resource(MANIFEST,cache);
    return validateManifest(await response.json());
  })().catch(error=>{manifestPromise=null;throw error;});
  return manifestPromise;
}

function blockKey(item) {return new URL(item.sha256,BLOCK_ROOT).href;}

async function block(item,transport = null) {
  const key=blockKey(item),cache=await caches.open(BLOCK_CACHE);
  const cached=await cache.match(key);
  if(cached) {
    if(verifiedBlocks.has(key)) return cached;
    try {
      const data=await cached.arrayBuffer();await verify(data,item);verifiedBlocks.add(key);
      return new Response(data,{status:200,headers:cached.headers});
    }catch {await cache.delete(key);verifiedBlocks.delete(key);}
  }
  let task=blockJobs.get(key);
  if(!task) {
    task=(async()=>{
      if(transport?.enabled&&!transport.failed) {
        transport.cdn++;
        try{return await download(mirrorURL(item),cache,item,true);}
        catch {
          // 一块失败即熔断本次准备，已在途的最多四块各自完成或回退。
          transport.failed=true;transport.fallback++;
        }
      }
      if(transport)transport.sameOrigin++;
      return download(new URL(item.path,ROOT).href,cache,item);
    })().then(response=>{verifiedBlocks.add(key);return response;})
      .finally(()=>blockJobs.delete(key));
    blockJobs.set(key,task);
  }
  await task;
  return cache.match(key);
}

async function cacheBlocks(items,files,progress,transport = null) {
  let completed=0,next=0,failure;progress(completed,items.length);
  const fetchNext=async()=>{
    while(next<items.length&&!failure) {
      const item=items[next++];
      try {await block(files.get(new URL(item.path,ROOT).href),transport);completed++;progress(completed,items.length);}
      catch(error){failure ||= error;}
    }
  };
  await Promise.all(Array.from({length:Math.min(4,items.length)},fetchNext));
  if(failure)throw failure;
}

async function assembleGame(game,cache,files,transport = null) {
  const url=new URL(game.path,ROOT).href,known=await cache.match(url);
  if(known) {
    if(verifiedGames.has(game.sha256))return known;
    try {
      const data=await known.arrayBuffer();await verify(data,game);verifiedGames.add(game.sha256);
      return new Response(data,{status:200,headers:known.headers});
    }catch {await cache.delete(url);}
  }
  const data=new Uint8Array(game.bytes);let offset=0;
  for(const item of game.chunks) {
    const response=await block(files.get(new URL(item.path,ROOT).href),transport),part=new Uint8Array(await response.arrayBuffer());
    data.set(part,offset);offset+=part.byteLength;
  }
  if(offset!==game.bytes)throw new Error('完整HTML大小不匹配。');
  await verify(data,game);
  const headers={'Content-Type':'text/html; charset=utf-8','Content-Length':String(data.byteLength)};
  await cache.put(url,new Response(data,{headers}));verifiedGames.add(game.sha256);
  return new Response(data,{headers});
}

async function prepareGame(key,notify,useCDN = false) {
  if (!['chrome','webkit'].includes(key)) throw new Error('请选择有效的浏览器引擎。');
  let job = jobs.get(key);
  if (!job) {
    if(jobs.size)throw new Error('另一套浏览器引擎正在缓存，请等待完成后重试。');
    job = {listeners:new Set(),progress:null};jobs.set(key,job);
    const progress = value=>{
      job.progress={type:'progress',engineKey:key,...value};
      for (const listener of job.listeners) {try {listener(job.progress);} catch {/* 关闭的入口不影响已开始的缓存。 */}}
    };
    job.promise=(async()=>{
      const cache=await caches.open(CACHE_NAME),{manifest,files}=await readManifest(cache),chunks=manifest.engines[key].chunks;
      const transport=await mirrorPolicy(manifest,useCDN);
      const counts=()=>({cdn:transport.cdn,sameOrigin:transport.sameOrigin,fallback:transport.fallback,
        source:transport.cdn?(transport.sameOrigin?'mixed':'cdn'):'same-origin'});
      await cacheBlocks(manifest.game.chunks,files,(completed,total)=>progress({stage:'game',completed,total,...counts()}),transport);
      await assembleGame(manifest.game,cache,files,transport);
      await cacheBlocks(chunks,files,(completed,total)=>progress({stage:'chunks',completed,total,...counts()}),transport);
      return {ok:true,version:VERSION,engineKey:key,completed:chunks.length,total:chunks.length,...counts()};
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
    const cache=await caches.open(CACHE_NAME),{files}=await readManifest(cache);
    const keep=new Set([...files.values()].filter(item=>item?.kind==='chunk'||item?.kind==='game-chunk').map(blockKey));
    const blocks=await caches.open(BLOCK_CACHE);
    for(const request of await blocks.keys()) {
      const url=new URL(request.url);
      if(url.origin===ROOT.origin&&url.pathname.startsWith(BLOCK_ROOT.pathname)&&!keep.has(url.href))await blocks.delete(request);
    }
    for (const name of await caches.keys()) {
      if(name===CACHE_NAME)continue;
      if(name.startsWith(SCOPE_CACHE_PREFIX))await caches.delete(name);
      else if(name.startsWith(CACHE_PREFIX)&&!/^%2f/i.test(name.slice(CACHE_PREFIX.length))) {
        // 旧通用cache可能混有嵌套项目；只删当前清单已知的精确URL，保留未知旧条目。
        const legacy=await caches.open(name);
        for(const request of await legacy.keys())if(files.has(cacheKey(request.url)))await legacy.delete(request);
        if(!(await legacy.keys()).length)await caches.delete(name);
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'prepare-game' || !event.ports?.[0]) return;
  try { if (!event.source?.url || !inScope(new URL(event.source.url))) return; }
  catch { return; }
  event.waitUntil(prepareGame(event.data.engineKey,progress=>event.ports[0].postMessage(progress),event.data.useCDN===true).then(
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
      const key=cacheKey(url),cache=await caches.open(CACHE_NAME),{manifest,files,CACHED_SET}=await readManifest(cache);
      const response=key===new URL(manifest.game.path,ROOT).href?await assembleGame(manifest.game,cache,files):
        CACHED_SET.has(key)?await resource(key,cache,files.get(key)):await fetch(request);
      // 从缓存读取时同样补头，保证断网导航仍有跨源隔离。
      return isolated(response);
    } catch {
      return isolated(new Response('游戏资源尚未完整缓存。请联网后返回试玩入口，点击“重试准备”。', {
        status:503, headers:{'Content-Type':'text/plain; charset=utf-8'},
      }));
    }
  })());
});
