import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import vm from 'node:vm';

const base = 'https://example.github.io/seekdb-wasm-battleship/';
const file = name => new URL(name, import.meta.url);

// 用标准 Request/Response 执行真实 SW 代码；仅替代 Node 没有的浏览器事件与缓存容器。
function worker({offline = false, failGame = false} = {}) {
  assert.ok(existsSync(file('service-worker.js')), '尚未实现网页隔离与离线缓存');
  const events = {}, stores = new Map(), requested = [];
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async put(key, value) { store.set(typeof key === 'string' ? key : key.url, new Response(await value.arrayBuffer(), {headers:value.headers, status:value.status})); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const context = vm.createContext({URL, Request, Response, Headers, caches, console,
    self: {registration:{scope:base}, clients:{claim:async()=>{}}, addEventListener:(name, fn)=>{events[name]=fn;}},
    fetch:async input => {
      const url = typeof input === 'string' ? input : input.url;
      requested.push(url);
      if (offline) throw new Error('模拟断网');
      return new Response(url.endsWith('game.html') ? '<html>真实构建的游戏</html>' : 'shell', {
        status:failGame && url.endsWith('game.html') ? 503 : 200,
        headers:{'Content-Type':url.endsWith('.html') ? 'text/html' : 'text/plain'},
      });
    },
  });
  vm.runInContext(readFileSync(file('service-worker.js'), 'utf8'), context);
  return {events, stores, requested, caches, setOffline:value=>{offline=value;},
    async lifecycle(name) { let pending; events[name]({waitUntil:p=>{pending=p;}}); await pending; },
    async response(url, options={}) { let pending; events.fetch({request:new Request(url, options), respondWith:p=>{pending=p;}, waitUntil:()=>{}}); return pending ? await pending : null; },
    async prepare() { let pending, reply; events.message({data:{type:'prepare-game'},source:{url:base},ports:[{postMessage:value=>{reply=value;}}],waitUntil:p=>{pending=p;}}); await pending; return reply; },
  };
}

test('项目子路径的安装清单全部同源同 scope，且不自动启动数据库', async()=>{
  const w=worker(); await w.lifecycle('install');
  assert.ok(w.requested.length >= 4);
  assert.ok(w.requested.every(url=>url.startsWith(base)));
  assert.ok(w.requested.every(url=>!url.includes('game.html')));
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
