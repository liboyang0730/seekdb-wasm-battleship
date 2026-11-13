import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

const base = 'https://example.github.io/seekdb-wasm-battleship/';
const file = name => new URL(name, import.meta.url);
const sha = data => createHash('sha256').update(data).digest('hex');
const gameBody = Buffer.from('<html>真实构建的游戏</html>');
const gameBodies = new Map(Array.from({length:3},(_,i)=>
  [`assets/game-${String(i).padStart(3,'0')}.bin`,gameBody.subarray(Math.floor(i*gameBody.length/3),Math.floor((i+1)*gameBody.length/3))]));
const chunkBodies = new Map(['chrome','webkit'].flatMap(engine=>Array.from({length:6},(_,i)=>
  [`assets/engine-${engine}-${String(i).padStart(3,'0')}.bin`,Buffer.from(`${engine}-gzip-part-${i}`)])));
const manifest = {version:'v0.2.1',game:{path:'game.html',bytes:gameBody.length,sha256:sha(gameBody),
  chunks:[...gameBodies].map(([path,body])=>({path,bytes:body.length,sha256:sha(body)}))},
  engines:Object.fromEntries(['chrome','webkit'].map(engine=>{
    const entries=[...chunkBodies].filter(([path])=>path.includes(`-${engine}-`));
    return [engine,{chunks:entries.map(([path,body])=>({path,bytes:body.length,sha256:sha(body)})),
      gzipBytes:entries.reduce((n,[,body])=>n+body.length,0),gzipSha256:sha(Buffer.concat(entries.map(([,body])=>body)))}];
  }))};

// 用标准 Request/Response 执行真实 SW 代码；仅替代 Node 没有的浏览器事件与缓存容器。
function worker({offline = false, failGame = false, failChunk = '', failOnce = '', corruptChunk = '', badManifest = null,
  delayed = false, streamPath = '', streamDelays = [], headerDelay = 0,sharedStores = new Map(), buildId = 'A'} = {}) {
  assert.ok(existsSync(file('service-worker.js')), '尚未实现网页隔离与离线缓存');
  const events = {}, stores = sharedStores, requested = [],attempts=new Map(),abortedRequests=[];
  let active=0,maxActive=0,timerSerial=0,now=0;
  const virtualTimers=new Map(),blocks=new Map([...gameBodies,...chunkBodies]);
  const timer=(fn,delay)=>{const id=++timerSerial;virtualTimers.set(id,{fn,at:now+delay});return id;};
  const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));for(let i=0;i<20;i++)await Promise.resolve();};
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async put(key, value) { store.set(typeof key === 'string' ? key : key.url, new Response(await value.arrayBuffer(), {headers:value.headers, status:value.status})); },
        async delete(key) {return store.delete(typeof key==='string'?key:key.url);},
        async keys() {return [...store.keys()].map(key=>new Request(key));},
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const context = vm.createContext({URL, Request, Response, Headers, AbortController,
    crypto:{subtle:{async digest(algorithm,data){assert.equal(algorithm,'SHA-256');return Uint8Array.from(createHash('sha256').update(new Uint8Array(data)).digest()).buffer;}}},
    setTimeout:streamPath?timer:setTimeout,clearTimeout:streamPath?id=>virtualTimers.delete(id):clearTimeout,caches, console,
    self: {registration:{scope:base}, clients:{claim:async()=>{}}, addEventListener:(name, fn)=>{events[name]=fn;}},
    fetch:async input => {
      const url = typeof input === 'string' ? input : input.url;
      requested.push(url);
      if (offline) throw new Error('模拟断网');
      const path=url.slice(base.length), count=(attempts.get(path)||0)+1;attempts.set(path,count);
      input.signal.addEventListener('abort',()=>abortedRequests.push(path),{once:true});
      if(path===streamPath&&headerDelay)await new Promise(resolve=>timer(resolve,headerDelay));
      if(delayed&&blocks.has(path)){active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setImmediate(resolve));active--;}
      const chunk=blocks.get(path);
      let body=path==='assets.json'?JSON.stringify(badManifest||manifest):chunk|| (path==='game.html'?gameBody:'shell');
      if(path===corruptChunk){body=Buffer.from(body);body[0]^=1;}
      if(path===streamPath){
        let scheduled,index=0,closed=false;
        body=new ReadableStream({start(controller){
          const emit=()=>{
            if(closed)return;
            const start=Math.floor(index*chunk.length/streamDelays.length),end=Math.floor((index+1)*chunk.length/streamDelays.length);
            controller.enqueue(new Uint8Array(chunk.subarray(start,end)));index++;
            if(index===streamDelays.length){closed=true;controller.close();}
            else scheduled=timer(emit,streamDelays[index]);
          };
          scheduled=timer(emit,streamDelays[0]);
          input.signal.addEventListener('abort',()=>{
            if(closed)return;closed=true;virtualTimers.delete(scheduled);controller.error(input.signal.reason);
          },{once:true});
        },cancel(){closed=true;virtualTimers.delete(scheduled);}});
      }
      return new Response(body, {
        status:failGame&&gameBodies.has(path)||path===failChunk||path===failOnce&&count===1 ? 503 : 200,
        headers:{'Content-Type':path==='assets.json'?'application/json':url.endsWith('.html') ? 'text/html' : chunk?'application/octet-stream':'text/plain'},
      });
    },
  });
  vm.runInContext(readFileSync(file('service-worker.js'), 'utf8').replace('__BUILD_ID__',buildId), context);
  return {events, stores, requested, caches, attempts,stats:()=>({maxActive,now,abortedRequests}),setOffline:value=>{offline=value;},setFailChunk:value=>{failChunk=value;},
    async advance(milliseconds){
      const target=now+milliseconds;await settle();
      for(;;){
        const next=[...virtualTimers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next)break;
        now=next[1].at;virtualTimers.delete(next[0]);next[1].fn();await settle();
      }
      now=target;await settle();
    },
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
  const parts=w.requested.filter(url=>url.includes('/engine-')&&url.endsWith('.bin'));
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

test('慢流总计90秒但每30秒都有数据，不能在40秒墙钟误中止',async()=>{
  const path=manifest.engines.chrome.chunks[0].path,w=worker({streamPath:path,streamDelays:[30000,30000,30000]});await w.lifecycle('install');
  const pending=w.prepare();await w.advance(90001);const reply=await pending;
  assert.equal(reply.ok,true);assert.equal(w.attempts.get(path),1);
});

test('40秒确实无新字节则Abort，重试一次后失败',async()=>{
  const path=manifest.engines.chrome.chunks[0].path,w=worker({streamPath:path,streamDelays:[41000]});await w.lifecycle('install');
  const pending=w.prepare();await w.advance(80001);const reply=await pending;
  assert.equal(reply.ok,false);assert.match(reply.error,/40秒|超时/);assert.equal(w.attempts.get(path),2);
});

test('等待响应头30秒后，首段再等20秒仍应成功',async()=>{
  const path=manifest.engines.chrome.chunks[0].path,w=worker({streamPath:path,headerDelay:30000,streamDelays:[20000]});await w.lifecycle('install');
  const pending=w.prepare();await w.advance(100001);const reply=await pending;
  assert.equal(reply.ok,true);assert.equal(w.attempts.get(path),1);
});

test('HTTP失败先中止尚未读取的响应体，再开始重试',async()=>{
  const path=manifest.engines.chrome.chunks[0].path,w=worker({failOnce:path});await w.lifecycle('install');
  assert.equal((await w.prepare()).ok,true);assert.ok(w.stats().abortedRequests.includes(path));
});

test('持续有数据也有180秒绝对上限，最多两次请求',async()=>{
  const path=manifest.engines.chrome.chunks[0].path,w=worker({streamPath:path,streamDelays:Array(7).fill(35000)});await w.lifecycle('install');
  const pending=w.prepare();await w.advance(360001);const reply=await pending;
  assert.equal(reply.ok,false);assert.match(reply.error,/180秒|总时限/);assert.equal(w.attempts.get(path),2);
});

test('game按UTF8原始字节重组，完整HTML SHA不符拒绝完成',async()=>{
  const w=worker();await w.lifecycle('install');assert.equal((await w.prepare()).ok,true);
  assert.equal(await (await w.response(base+'game.html')).text(),gameBody.toString());
  assert.ok(!w.requested.includes(base+'game.html'),'不能再从网络下载完整HTML');
  const bad=structuredClone(manifest);bad.game.sha256='0'.repeat(64);
  const broken=worker({badManifest:bad});await broken.lifecycle('install');const reply=await broken.prepare();
  assert.equal(reply.ok,false);assert.match(reply.error,/HTML|SHA|校验/);
});

test('跨构建静态缓存隔离，不变块按SHA共享，不再次下载',async()=>{
  const first=worker({buildId:'first'});await first.lifecycle('install');await first.prepare();
  const next=worker({sharedStores:first.stores,buildId:'next'});await next.lifecycle('install');await next.lifecycle('activate');
  assert.equal((await next.prepare()).ok,true);
  assert.equal(next.requested.filter(url=>url.endsWith('.bin')).length,0);
  assert.equal(await (await next.response(base+'game.html')).text(),gameBody.toString());
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

test('新静态缓存按完整scope路径区分，同origin项目不能共用build缓存名',async()=>{
  const w=worker();await w.lifecycle('install');
  assert.ok((await w.caches.keys()).some(name=>name.startsWith(`seekdb-battleship-static-${encodeURIComponent(new URL(base).pathname)}:`)));
});

test('升级只清本scope，旧通用缓存中的其他项目条目必须保留',async()=>{
  const w=worker();await w.lifecycle('install');
  const other='https://example.github.io/other-game/';
  const scopedName=`seekdb-battleship-static-${encodeURIComponent('/other-game/')}:v0.2.1-old`;
  const scoped=await w.caches.open(scopedName);await scoped.put(other+'index.html',new Response('other'));
  const legacyName='seekdb-battleship-static-v0.2.1-legacy',legacy=await w.caches.open(legacyName);
  await legacy.put(base+'index.html',new Response('our-old'));await legacy.put(other+'index.html',new Response('other-old'));
  const onlyOursName='seekdb-battleship-static-v0.2.1-only-ours',onlyOurs=await w.caches.open(onlyOursName);
  await onlyOurs.put(base+'index.html',new Response('our-old'));
  await w.lifecycle('activate');
  const names=await w.caches.keys();assert.ok(names.includes(scopedName));assert.ok(names.includes(legacyName));assert.ok(!names.includes(onlyOursName));
  assert.equal(await (await scoped.match(other+'index.html')).text(),'other');
  assert.equal(await legacy.match(base+'index.html'),undefined);
  assert.equal(await (await legacy.match(other+'index.html')).text(),'other-old');
});

test('嵌套-b项目的scope缓存和legacy条目不能被父scope前缀吞掉',async()=>{
  const w=worker();await w.lifecycle('install');
  const nested=new URL('-b/',base),name=`seekdb-battleship-static-${encodeURIComponent(nested.pathname)}:v0.2.1-other`;
  const separate=await w.caches.open(name);await separate.put(new URL('index.html',nested).href,new Response('nested'));
  const legacyName='seekdb-battleship-static-v0.2.1-mixed',legacy=await w.caches.open(legacyName);
  await legacy.put(base+'index.html',new Response('our-old'));
  await legacy.put(new URL('index.html',nested).href,new Response('nested-old'));
  await legacy.put(base+'unknown-old.js',new Response('unknown'));
  await w.lifecycle('activate');
  assert.ok((await w.caches.keys()).includes(name));
  assert.equal(await (await separate.match(new URL('index.html',nested).href)).text(),'nested');
  assert.equal(await legacy.match(base+'index.html'),undefined);
  assert.equal(await (await legacy.match(new URL('index.html',nested).href)).text(),'nested-old');
  assert.equal(await (await legacy.match(base+'unknown-old.js')).text(),'unknown');
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
function launcher({releaseAt=Infinity,vendor='',progressOnly=false,progress={type:'progress',stage:'chunks',completed:1,total:3}}={}) {
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
      ports[0].complete(progress);
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

test('game阶段显示HTML分块进度，不提前结束准备',async()=>{
  const app=launcher({releaseAt:0,progressOnly:true,progress:{type:'progress',stage:'game',completed:2,total:7}});await app.settle();
  assert.equal(app.elements['launch-start'].disabled,true);assert.equal(app.elements['launch-retry'].hidden,true);
  assert.match(app.elements['launch-status'].textContent,/2.*7/);
});
