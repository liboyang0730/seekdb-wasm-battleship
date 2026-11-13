import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';

const base = 'https://example.github.io/seekdb-wasm-battleship/';
const file = name => new URL(name, import.meta.url);
const sha = data => createHash('sha256').update(data).digest('hex');
const gameBody = Buffer.from('<html>真实构建的游戏</html>');
const chunkBodies = new Map(['chrome','webkit'].flatMap(engine=>Array.from({length:6},(_,i)=>
  [`assets/engine-${engine}-${String(i).padStart(3,'0')}.bin`,Buffer.from(`${engine}-gzip-part-${i}`)])));
const manifest = {version:'v0.2.1',game:{path:'game.html',bytes:gameBody.length,sha256:sha(gameBody)},
  engines:Object.fromEntries(['chrome','webkit'].map(engine=>{
    const entries=[...chunkBodies].filter(([path])=>path.includes(`-${engine}-`));
    return [engine,{chunks:entries.map(([path,body])=>({path,bytes:body.length,sha256:sha(body)})),
      gzipBytes:entries.reduce((n,[,body])=>n+body.length,0),gzipSha256:sha(Buffer.concat(entries.map(([,body])=>body)))}];
  }))};

// 用标准 Request/Response 执行真实 SW 代码；仅替代 Node 没有的浏览器事件与缓存容器。
function worker({offline = false, failGame = false, failChunk = '', failOnce = '', corruptChunk = '', badManifest = null, delayed = false, timeoutChunk = ''} = {}) {
  assert.ok(existsSync(file('service-worker.js')), '尚未实现网页隔离与离线缓存');
  const events = {}, stores = new Map(), requested = [],attempts=new Map();
  let active=0,maxActive=0,timerSerial=0;
  const virtualTimers=new Map(),timeoutDelays=[];
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async put(key, value) { store.set(typeof key === 'string' ? key : key.url, new Response(await value.arrayBuffer(), {headers:value.headers, status:value.status})); },
        async delete(key) {return store.delete(typeof key==='string'?key:key.url);},
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const context = vm.createContext({URL, Request, Response, Headers, AbortController, crypto:webcrypto,
    setTimeout:timeoutChunk?(fn,delay)=>{const id=++timerSerial;virtualTimers.set(id,fn);timeoutDelays.push(delay);return id;}:setTimeout,
    clearTimeout:timeoutChunk?id=>virtualTimers.delete(id):clearTimeout,caches, console,
    self: {registration:{scope:base}, clients:{claim:async()=>{}}, addEventListener:(name, fn)=>{events[name]=fn;}},
    fetch:async input => {
      const url = typeof input === 'string' ? input : input.url;
      requested.push(url);
      if (offline) throw new Error('模拟断网');
      const path=url.slice(base.length), count=(attempts.get(path)||0)+1;attempts.set(path,count);
      if(path===timeoutChunk){
        const fire=virtualTimers.get(timerSerial);
        return new Promise((_,reject)=>{
          input.signal.addEventListener('abort',()=>reject(Object.assign(new Error('模拟请求超时'),{name:'AbortError'})),{once:true});
          queueMicrotask(fire);
        });
      }
      if(delayed&&chunkBodies.has(path)){active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setImmediate(resolve));active--;}
      const chunk=chunkBodies.get(path);
      let body=path==='assets.json'?JSON.stringify(badManifest||manifest):chunk|| (path==='game.html'?gameBody:'shell');
      if(path===corruptChunk){body=Buffer.from(body);body[0]^=1;}
      return new Response(body, {
        status:failGame&&path==='game.html'||path===failChunk||path===failOnce&&count===1 ? 503 : 200,
        headers:{'Content-Type':path==='assets.json'?'application/json':url.endsWith('.html') ? 'text/html' : chunk?'application/octet-stream':'text/plain'},
      });
    },
  });
  vm.runInContext(readFileSync(file('service-worker.js'), 'utf8'), context);
  return {events, stores, requested, caches, attempts,stats:()=>({maxActive,timeoutDelays}),setOffline:value=>{offline=value;},setFailChunk:value=>{failChunk=value;},
    async lifecycle(name) { let pending; events[name]({waitUntil:p=>{pending=p;}}); await pending; },
    async response(url, options={}) { let pending; events.fetch({request:new Request(url, options), respondWith:p=>{pending=p;}, waitUntil:()=>{}}); return pending ? await pending : null; },
    async prepare(engineKey='chrome') { let pending, reply;const progress=[]; events.message({data:{type:'prepare-game',engineKey},source:{url:base},ports:[{postMessage:value=>{if(typeof value.ok==='boolean')reply=value;else progress.push(value);}}],waitUntil:p=>{pending=p;}}); await pending; return {...reply,progress}; },
  };
}

test('项目子路径的安装清单全部同源同 scope，且不自动启动数据库', async()=>{
  const w=worker(); await w.lifecycle('install');
  assert.ok(w.requested.length >= 4);
  assert.ok(w.requested.every(url=>url.startsWith(base)));
  assert.ok(w.requested.every(url=>!url.includes('game.html')));
  assert.ok(w.requested.includes(base+'assets.json'));
  assert.ok(w.requested.every(url=>!url.endsWith('.bin')));
});

test('首次游戏下载成功后可断网重访，缓存及网络回执均含固定隔离头', async()=>{
  const w=worker();await w.lifecycle('install');
  assert.equal((await w.prepare()).ok, true);
  w.setOffline(true);
  for(const name of ['index.html','game.html']) {
    const response=await w.response(base+name);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('Cross-Origin-Opener-Policy'),'same-origin');
    assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'),'require-corp');
    assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
  }
});

test('缓存根导航按 index.html 读取，游戏测试参数不重复下载整包', async()=>{
  const w=worker();await w.lifecycle('install');await w.prepare();w.setOffline(true);
  assert.equal((await w.response(base)).status,200);
  assert.match(await (await w.response(base+'game.html?test=1')).text(),/真实构建/);
});

test('跨 origin、scope 邻居及非 GET 请求不被 SW 接管', async()=>{
  const w=worker();
  for(const [url,options] of [['https://elsewhere.invalid/game.html',{}],['https://example.github.io/other/game.html',{}],[base+'game.html',{method:'POST',body:'x'}]]) {
    assert.equal(await w.response(url,options),null);
  }
  assert.equal(w.requested.length,0);
});

test('下载失败返回可重试错误，不能宣称已离线就绪', async()=>{
  const w=worker({failGame:true});await w.lifecycle('install');
  const reply=await w.prepare();assert.equal(reply.ok,false);assert.match(reply.error,/503/);
  w.setOffline(true);const response=await w.response(base+'game.html');assert.equal(response.status,503);
});

test('无网安装失败不会创建假的成功缓存', async()=>{
  const w=worker({offline:true});await assert.rejects(w.lifecycle('install'),/断网/);
});

test('只下载指定引擎分块，进度多次回传且最终完成才ok',async()=>{
  const w=worker();await w.lifecycle('install');const reply=await w.prepare('webkit');
  assert.equal(reply.ok,true);assert.ok(reply.progress.length>=3);
  const parts=w.requested.filter(url=>url.endsWith('.bin'));
  assert.equal(parts.length,manifest.engines.webkit.chunks.length);
  assert.ok(parts.every(url=>url.includes('engine-webkit-')));
  assert.equal(reply.progress.at(-1).completed,manifest.engines.webkit.chunks.length);
  assert.equal(reply.progress.at(-1).total,manifest.engines.webkit.chunks.length);
});

test('单块失败仅重试一次，下一次准备复用先前成功且校验过的块',async()=>{
  const path=manifest.engines.chrome.chunks[1].path,w=worker({failChunk:path});await w.lifecycle('install');
  assert.equal((await w.prepare()).ok,false);assert.equal(w.attempts.get(path),2);
  const before=new Map(w.attempts);w.setFailChunk('');
  assert.equal((await w.prepare()).ok,true);assert.equal(w.attempts.get(path),3);
  for(const item of manifest.engines.chrome.chunks.filter(c=>c.path!==path&&before.has(c.path)))assert.equal(w.attempts.get(item.path),before.get(item.path));
  const total=w.requested.length;w.setOffline(true);assert.equal((await w.prepare()).ok,true);assert.equal(w.requested.length,total);
});

test('分块SHA不匹配不能标缓存成功，坏块最多尝试两次',async()=>{
  const path=manifest.engines.chrome.chunks[0].path,w=worker({corruptChunk:path});await w.lifecycle('install');
  const reply=await w.prepare();assert.equal(reply.ok,false);assert.match(reply.error,/SHA|校验/);assert.equal(w.attempts.get(path),2);
});

test('临时HTTP失败可有界重试后成功，不下载另一种引擎',async()=>{
  const path=manifest.engines.chrome.chunks[0].path,w=worker({failOnce:path});await w.lifecycle('install');
  assert.equal((await w.prepare()).ok,true);assert.equal(w.attempts.get(path),2);
  assert.ok(w.requested.every(url=>!url.includes('engine-webkit-')));
});

test('manifest路径越过scope时拒绝安装，不可进入缓存白名单',async()=>{
  const bad=structuredClone(manifest);bad.engines.chrome.chunks[0].path='../outside.bin';
  const w=worker({badManifest:bad});await assert.rejects(w.lifecycle('install'),/路径|scope|范围|分块/);
  assert.ok(w.requested.every(url=>url.startsWith(base)));
});

test('引擎分块即使同时准备也最多4个并发网络请求',async()=>{
  const w=worker({delayed:true});await w.lifecycle('install');assert.equal((await w.prepare()).ok,true);
  assert.equal(w.stats().maxActive,4);
});

test('单块40秒超时使用AbortController，重试一次后明确失败',async()=>{
  const path=manifest.engines.chrome.chunks[0].path,w=worker({timeoutChunk:path});await w.lifecycle('install');
  const reply=await w.prepare();assert.equal(reply.ok,false);assert.match(reply.error,/40秒|超时/);
  assert.equal(w.attempts.get(path),2);assert.ok(w.stats().timeoutDelays.every(delay=>delay===40000));
});

test('更新不强制接管或刷新正在游玩的客户，只清自己的旧静态缓存', async()=>{
  const w=worker();await w.lifecycle('install');
  await w.caches.open('other-product-cache');await w.caches.open('seekdb-battleship-static-old');
  await w.lifecycle('activate');
  const names=await w.caches.keys();assert.ok(names.includes('other-product-cache'));
  assert.ok(!names.includes('seekdb-battleship-static-old'));
  const code=readFileSync(file('service-worker.js'),'utf8');
  assert.doesNotMatch(code,/skipWaiting\s*\(|\.navigate\s*\(|getDirectory\s*\(|indexedDB/);
});

test('入口只在隔离及同源控制器就绪后允许跳转，不含游戏脚本', ()=>{
  assert.ok(existsSync(file('launch.js')), '尚未实现受控网页入口');
  const js=readFileSync(file('launch.js'),'utf8'), html=readFileSync(file('index.html'),'utf8');
  assert.match(js,/crossOriginIsolated/);assert.match(js,/SharedArrayBuffer/);assert.match(js,/seekdb-wasm-opfs/);
  assert.match(js,/controllerchange/);assert.match(js,/sessionStorage/);assert.match(js,/prepare-game/);
  assert.doesNotMatch(html,/游戏逻辑|数据库\.mjs|<iframe|game\.html["']/);
  assert.doesNotMatch(js,/Database\.open|NavalDB\.open/);
});

// 在隔离VM内执行整个入口；虚拟时钟替代真实等待，不给生产代码增加测试全局。
function launcher({releaseAt=Infinity,vendor='',progressOnly=false}={}) {
  let now=0, serial=0, queries=0, requests=0, cached=0, storageOpens=0;
  const timers=new Map(), assigned=[],engineKeys=[];
  const node=props=>({...props,events:{},addEventListener(name,fn){this.events[name]=fn;}});
  const elements={
    'launch-status':node({textContent:'',dataset:{}}),
    'launch-start':node({disabled:true}),
    'launch-retry':node({hidden:true}),
  };
  const scriptURL=new URL('service-worker.js',base).href;
  const registration={scope:base,active:{scriptURL}};
  const controller={scriptURL,postMessage(data,ports){
    assert.equal(data.type,'prepare-game');cached++;engineKeys.push(data.engineKey);
    queueMicrotask(()=>{
      ports[0].complete({type:'progress',stage:'chunks',completed:1,total:3});
      if(!progressOnly)ports[0].complete({ok:true});
    });
  }};
  class Channel {
    constructor(){
      this.port1={onmessage:null,close(){}};
      this.port2={close(){},complete:data=>this.port1.onmessage({data})};
    }
  }
  const session=new Map();
  const context=vm.createContext({URL,console,SharedArrayBuffer,MessageChannel:Channel,
    document:{baseURI:base,getElementById:id=>elements[id]},
    window:{isSecureContext:true,crossOriginIsolated:true,location:{assign:url=>assigned.push(url),reload(){throw new Error('已隔离时不应刷新');}}},
    navigator:{vendor,
      storage:{getDirectory(){storageOpens++;throw new Error('入口不能打开OPFS');}},
      locks:{query:async()=>{queries++;return{held:now<releaseAt?[{name:'seekdb-wasm-opfs'}]:[]};},request(){requests++;throw new Error('入口不能申请数据库锁');}},
      serviceWorker:{controller,ready:Promise.resolve(registration),getRegistration:async()=>registration,register:async()=>registration,
        addEventListener(){},removeEventListener(){}},
    },
    sessionStorage:{getItem:key=>session.get(key),setItem:(key,value)=>session.set(key,value),removeItem:key=>session.delete(key)},
    performance:{now:()=>now},
    setTimeout:(fn,delay)=>{const id=++serial;timers.set(id,{fn,at:now+delay});return id;},
    clearTimeout:id=>timers.delete(id),
  });
  vm.runInContext(readFileSync(file('launch.js'),'utf8'),context);
  const settle=async()=>{for(let i=0;i<35;i++)await Promise.resolve();};
  return {elements,assigned,settle,
    stats:()=>({now,queries,requests,cached,storageOpens,engineKeys}),
    async advance(milliseconds){
      const target=now+milliseconds;await settle();
      for(;;){
        const next=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next)break;
        now=next[1].at;timers.delete(next[0]);next[1].fn();await settle();
      }
      now=target;await settle();
    },
  };
}

test('旧页面锁先held后释放：入口等待后自动ready，不要求用户再次重试',async()=>{
  const app=launcher({releaseAt:300});await app.settle();
  assert.equal(app.elements['launch-retry'].hidden,true,'短暂持锁不应立即显示另一页面占用错误');
  assert.equal(app.elements['launch-start'].disabled,true);
  await app.advance(300);
  assert.equal(app.elements['launch-start'].disabled,false);
  assert.match(app.elements['launch-status'].textContent,/资源已缓存/);
  assert.ok(app.stats().queries>=3);assert.equal(app.stats().cached,1);
  assert.equal(app.stats().requests,0);assert.equal(app.stats().storageOpens,0);
  await app.elements['launch-start'].events.click();
  assert.deepEqual(app.assigned,[new URL('game.html',base).href]);
});

test('另一页面持续held：有界等待后提示占用，不抢锁、不打开数据库或缓存游戏',async()=>{
  const app=launcher();await app.settle();
  assert.equal(app.elements['launch-retry'].hidden,true,'应先等待旧页面异步释放');
  await app.advance(4000);
  assert.equal(app.elements['launch-start'].disabled,true);
  assert.equal(app.elements['launch-retry'].hidden,false);
  assert.match(app.elements['launch-status'].textContent,/同一浏览器已有游戏正在运行/);
  assert.ok(app.stats().queries>2);assert.equal(app.stats().cached,0);
  assert.equal(app.stats().requests,0);assert.equal(app.stats().storageOpens,0);
  const queries=app.stats().queries;await app.advance(10000);
  assert.equal(app.stats().queries,queries,'超时提示后不能继续后台轮询');
});

test('Apple入口只选择webkit，分块progress不提前结束准备',async()=>{
  const app=launcher({releaseAt:0,vendor:'Apple Computer, Inc.',progressOnly:true});await app.settle();
  assert.deepEqual(app.stats().engineKeys,['webkit']);
  assert.equal(app.elements['launch-start'].disabled,true);
  assert.equal(app.elements['launch-retry'].hidden,true);
  assert.match(app.elements['launch-status'].textContent,/1.*3/);
});
