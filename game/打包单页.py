#!/usr/bin/env python3
"""把当前游戏与两种官方seekdb引擎封装为离线单页；只改写内存中的分发副本。"""
import argparse
import base64
import gzip
import hashlib
import json
import mimetypes
import os
import pathlib
import posixpath
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_OUTPUT = ROOT.parent / 'seekdb大海戦.html'
DEFAULT_MANIFEST = ROOT.parent / 'seekdb大海戦-多浏览器离线试玩-构建清单.json'
PROTECTED_OUTPUTS = {ROOT.parent / name for name in [
    'seekdb大海戦-同事试玩.html', 'seekdb大海戦-离线试玩-Mac.zip', 'seekdb大海戦-离线试玩-Windows.zip']}
WASMS = {'chrome': 'engine/seekdb_wasm_database.wasm',
         'webkit': 'engine/seekdb_wasm_database.webkit.wasm'}
FONT = 'assets/fusion-pixel-12px.woff2'
LOGO = 'assets/branding/seekdb-logo.png'
QUOTED = r'(?P<literal>(?P<quote>[\'\"])(?P<ref>[^\'\"]+)(?P=quote))'
STATIC_IMPORT = re.compile(r'\b(?:import|export)\s+[\w$*\s{},]+?\s+from\s*' + QUOTED)
SIDE_IMPORT = re.compile(r'\bimport\s*' + QUOTED)
DYNAMIC_IMPORT = re.compile(r'\bimport\s*\(\s*' + QUOTED + r'\s*\)')
RELATIVE_URL = re.compile(r'new\s+URL\s*\(\s*' + QUOTED + r'\s*,\s*import\.meta\.url\s*\)')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(data):
    return base64.b64encode(data).decode('ascii')


def json_script(value):
    # 防止来源说明或代码片段里的HTML结束标签截断内嵌JSON。
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')


BOOTSTRAP = r'''
<script type="module">
const status = document.getElementById('singlefile-status');
const report = text => { status.textContent = text; };
try {
  if (location.protocol === 'file:' || !globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    throw new Error('请双击随包的免Python原生启动器，或访问启用COOP/COEP的HTTPS地址。本游戏使用真实seekdb多线程引擎，双击file://文件不能直接运行。');
  }
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器缺少gzip解压能力。请尝试新版桌面Chrome、Edge、Safari或Firefox，实际兼容性以验证结果为准。');
  const element = document.getElementById('seekdb-bundle-payload');
  const payload = JSON.parse(element.textContent);
  const manifest = JSON.parse(document.getElementById('seekdb-bundle-manifest').textContent);
  globalThis.seekdbSingleFileManifest = manifest;
  const urls = new Map();
  const decoder = new TextDecoder();
  const decode = data => {
    const binary = atob(data), result = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
    return result;
  };
  // 与正式数据库模块使用同一vendor判断，只解压当前浏览器需要的官方构建。
  const engineKey = navigator.vendor === 'Apple Computer, Inc.' ? 'webkit' : 'chrome';
  const engine = manifest.engines[engineKey];
  if (!engine || payload.nodes[engine.path]?.kind !== 'wasm-gzip') throw new Error('缺少当前浏览器需要的内嵌seekdb引擎。');
  globalThis.seekdbSingleFileEngine = {key: engineKey, path: engine.path};
  report('正在解压真实seekdb引擎（' + (engineKey === 'webkit' ? 'WebKit' : '标准') + '构建），请稍候…');
  const compressed = decode(payload.nodes[engine.path].data);
  const uncompressed = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if (uncompressed.byteLength !== engine.bytes) throw new Error('内嵌WASM解压长度不符，请重新获取完整试玩文件。');
  const wasmHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', uncompressed))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (wasmHash !== engine.sha256) throw new Error('内嵌WASM校验失败，请重新获取完整试玩文件。');
  globalThis.seekdbSingleFileEngine = {key: engineKey, path: engine.path,
    bytes: uncompressed.byteLength, sha256: wasmHash, verified: true};
  urls.set(engine.path, URL.createObjectURL(new Blob([uncompressed], {type: 'application/wasm'})));
  // 资源引用在数据库分支实际执行时解析，避免依赖闭包提前展开另一个大引擎。
  globalThis.seekdbSingleFileWasmURL = id => {
    if (id !== engine.path || !urls.has(id)) throw new Error('请求了未选择的seekdb引擎：' + id);
    return urls.get(id);
  };
  for (const variant of Object.values(manifest.engines)) payload.nodes[variant.path].data = null;
  const building = new Set();
  function moduleURL(id) {
    if (urls.has(id)) return urls.get(id);
    if (building.has(id)) throw new Error('打包依赖出现循环：' + id);
    const node = payload.nodes[id];
    if (!node) throw new Error('缺少内嵌资源：' + id);
    building.add(id);
    let blob;
    if (node.kind === 'module') {
      const source = node.parts.map(part => {
        if (typeof part === 'string') return part;
        if (payload.nodes[part.ref]?.kind === 'wasm-gzip') {
          return 'globalThis.seekdbSingleFileWasmURL(' + JSON.stringify(part.ref) + ')';
        }
        return JSON.stringify(moduleURL(part.ref));
      }).join('');
      blob = new Blob([source], {type: 'text/javascript'});
    } else if (node.kind === 'wasm-gzip') throw new Error('未选择的引擎不能提前展开：' + id);
    else blob = new Blob([decode(node.data)], {type: node.mime});
    const url = URL.createObjectURL(blob);
    urls.set(id, url); building.delete(id);
    node.data = null;
    return url;
  }
  report('正在装入舰队与SQL模块…');
  const entry = moduleURL(manifest.entry);
  element.remove();
  status.remove();
  await import(entry);
} catch (error) {
  if (!status.isConnected) document.body.append(status);
  status.setAttribute('role', 'alert');
  status.style.color = '#9b302a';
  report('试玩文件尚未启动：' + (error?.message ?? error));
  console.error(error);
}
</script>
'''


def build(output, manifest_path, cache, webkit_cache=None):
    if output.resolve() in PROTECTED_OUTPUTS or manifest_path.resolve() in PROTECTED_OUTPUTS:
        raise ValueError('旧试玩HTML与封存ZIP只读，请使用独立的新产物路径')
    if output.resolve() == manifest_path.resolve():
        raise ValueError('HTML与构建清单必须使用不同路径')
    originals = {}
    nodes = {}
    active = set()
    patches = []

    def read(name):
        if name not in originals:
            originals[name] = (ROOT / name).read_bytes()
        return originals[name]

    def once(source, before, after, name, purpose):
        if source.count(before) != 1:
            raise ValueError(f'{name}精确改写位置不是唯一：{purpose}')
        preview = lambda value: value if len(value) <= 240 else value[:220] + '…'
        patches.append({'file': name, 'purpose': purpose, 'before': preview(before), 'after': preview(after),
                        'beforeSha256': sha(before.encode('utf-8')), 'afterSha256': sha(after.encode('utf-8')), 'count': 1})
        return source.replace(before, after, 1)

    def dependency(owner, ref):
        if re.match(r'^[a-zA-Z][\w+.-]*:', ref):
            if ref.startswith('node:'):
                return None  # 原引擎的Node分支在浏览器不执行。
            raise ValueError(f'模块不可依赖外部地址：{owner} -> {ref}')
        name = posixpath.normpath(posixpath.join(posixpath.dirname(owner), ref))
        if name.startswith('../') or name.startswith('/'):
            raise ValueError(f'资源越出游戏目录：{name}')
        return name

    def visit(name):
        if name in active:
            raise ValueError(f'模块依赖出现循环：{name}')
        if name in nodes:
            return
        active.add(name)
        data = read(name)
        if name in WASMS.values():
            gzip_cache = webkit_cache if name == WASMS['webkit'] else cache
            packed = gzip_cache.read_bytes() if gzip_cache and gzip_cache.is_file() else gzip.compress(data, compresslevel=9, mtime=0)
            if gzip.decompress(packed) != data:
                raise ValueError('WASM gzip缓存与当前正式引擎不一致')
            nodes[name] = {'kind': 'wasm-gzip', 'data': encoded(packed), 'mime': 'application/wasm',
                           'gzipBytes': len(packed), 'gzipSha256': sha(packed)}
        elif name.endswith('.mjs'):
            source = data.decode('utf-8')
            if name == '数据库.mjs':
                selection = re.search(r"const wasmFile = navigator\.vendor === 'Apple Computer, Inc\.'\s*\? '[^']+webkit\.wasm' : '[^']+\.wasm';", source)
                if not selection:
                    raise ValueError('未找到正式NavalDB的双引擎选择表达式')
                if any(f"'./{path}'" not in selection.group() for path in WASMS.values()):
                    raise ValueError('正式NavalDB的引擎路径与封装配置不一致')
                source = once(source, 'new URL(wasmFile, import.meta.url)',
                              "wasmFile === './engine/seekdb_wasm_database.webkit.wasm'\n"
                              "      ? new URL('./engine/seekdb_wasm_database.webkit.wasm', import.meta.url)\n"
                              "      : new URL('./engine/seekdb_wasm_database.wasm', import.meta.url)",
                              name, '保留正式vendor选择，通过两个静态URL重定位双引擎')
            if name == 'engine/seekdb_wasm_database.mjs':
                source = once(source, 'new Worker(new URL("seekdb_wasm_database.mjs",import.meta.url),',
                              'new Worker(import.meta.url,', name, 'pthread直接加载同一Blob模块，保留线程名称与真实引擎')
            references = {}
            for regex in [STATIC_IMPORT, SIDE_IMPORT, DYNAMIC_IMPORT, RELATIVE_URL]:
                for match in regex.finditer(source):
                    ref = match.group('ref')
                    target = dependency(name, ref)
                    if target is not None:
                        references[match.span('literal')] = target
            parts, cursor = [], 0
            refs = sorted(references.items())
            for (start, end), target in refs:
                if start < cursor:
                    raise ValueError(f'模块引用范围相互重叠：{name}')
                visit(target)
                parts.extend([source[cursor:start], {'ref': target}])
                cursor = end
            parts.append(source[cursor:])
            nodes[name] = {'kind': 'module', 'parts': parts, 'dependencies': sorted(set(references.values()))}
        else:
            nodes[name] = {'kind': 'asset', 'data': encoded(data), 'mime': mimetypes.guess_type(name)[0] or 'application/octet-stream'}
        active.remove(name)

    visit('游戏逻辑.mjs')
    if any(path not in nodes for path in WASMS.values()) or 'engine/database-worker.mjs' not in nodes:
        raise ValueError('打包闭包缺少双引擎WASM或数据库Worker')
    html = read('游戏.html').decode('utf-8')
    css = read('游戏样式.css').decode('utf-8')
    font_url = 'data:font/woff2;base64,' + encoded(read(FONT))
    logo_url = 'data:image/png;base64,' + encoded(read(LOGO))
    css, count = re.subn(r'url\([\'\"]\./assets/fusion-pixel-12px\.woff2[\'\"]\)', lambda _: f'url("{font_url}")', css)
    if count != 1:
        raise ValueError('像素字体URL改写位置不唯一')
    html, count = re.subn(r'\s*<link\b[^>]*href="\./assets/fusion-pixel-12px\.woff2"[^>]*>', '', html)
    if count != 1:
        raise ValueError('字体预载位置不唯一')
    html = once(html, '<link rel="stylesheet" href="./游戏样式.css">', '<style>\n' + css + '\n</style>', '游戏.html', '内联CSS与像素字体')
    html = once(html, 'src="./assets/branding/seekdb-logo.png"', 'src="' + logo_url + '"', '游戏.html', '内联页脚logo')
    attribution = []
    for name in ['engine/LICENSE', 'engine/NOTICE', 'engine/来源.json', 'engine/public-third-party.json', 'engine/OPFS日志兼容修改.json', 'assets/字体许可证.txt', 'assets/字体来源.json', '离线启动器/LICENSE-Go.txt']:
        attribution.append({'path': name, 'text': read(name).decode('utf-8')})
    entry_script = '<script type="module" src="./游戏逻辑.mjs"></script>'
    if html.count(entry_script) != 1:
        raise ValueError('游戏启动模块位置不是唯一')
    patches.append({'file': '游戏.html', 'purpose': '启动内嵌模块依赖闭包', 'before': entry_script,
                    'after': '内嵌manifest、资源载荷与Blob模块启动器', 'count': 1})
    sources = [{'path': name, 'bytes': len(value), 'sha256': sha(value)} for name, value in sorted(originals.items())]
    engines = {key: {'path': path, 'bytes': len(read(path)), 'sha256': sha(read(path)),
                     'gzipBytes': nodes[path]['gzipBytes'], 'gzipSha256': nodes[path]['gzipSha256']}
               for key, path in WASMS.items()}
    manifest = {'format': 'seekdb-naval-single-html-v2', 'browserTargets': ['Chrome', 'Edge', 'Safari', 'Firefox'],
                'entry': '游戏逻辑.mjs', 'engines': engines,
                'engineSelection': {'property': 'navigator.vendor', 'webkitValue': 'Apple Computer, Inc.',
                                    'otherwise': 'chrome'},
                'moduleCount': sum(node['kind'] == 'module' for node in nodes.values()),
                'sources': sources, 'packagedPatches': patches, 'attribution': attribution,
                'requirements': ['现代桌面Chrome、Edge、Safari或Firefox，实际支持以QA结果为准',
                                 'localhost HTTP或HTTPS', 'COOP: same-origin', 'COEP: require-corp',
                                 'SharedArrayBuffer与WebAssembly线程', 'OPFS与同步文件访问句柄',
                                 'DecompressionStream(gzip)', 'crypto.subtle SHA-256'],
                'notes': ['所有SQL由真实seekdb WASM执行；整局数据使用OPFS持久化，不演示集群。',
                          '双引擎均gzip内嵌，按正式vendor逻辑只解压及校验所需构建；不引入polyfill。',
                          '资源无需外网；Blob模块保留至页面关闭，外部官网链接仅由用户主动点击。']}
    node_binary = shutil.which('node')
    if node_binary:
        for name, node in nodes.items():
            if node['kind'] != 'module':
                continue
            check = ''.join(part if isinstance(part, str) else
                            f'globalThis.seekdbSingleFileWasmURL({json.dumps(part["ref"])})'
                            if nodes[part['ref']]['kind'] == 'wasm-gzip' else
                            json.dumps('blob:https://bundle.invalid/asset', ensure_ascii=False)
                            for part in node['parts'])
            result = subprocess.run([node_binary, '--input-type=module', '--check'], input=check, text=True, capture_output=True)
            if result.returncode:
                raise ValueError(f'封装模块语法错误：{name}\n{result.stderr}')
        bootstrap_source = BOOTSTRAP.split('<script type="module">', 1)[1].rsplit('</script>', 1)[0]
        result = subprocess.run([node_binary, '--input-type=module', '--check'], input=bootstrap_source, text=True, capture_output=True)
        if result.returncode:
            raise ValueError(f'单页启动器语法错误：\n{result.stderr}')
    manifest['syntaxCheckedModules'] = manifest['moduleCount'] if node_binary else 0
    status = '<div id="singlefile-status" role="status" style="position:fixed;z-index:99999;inset:20% 12%;padding:32px;background:#f7f4df;color:#183c50;border:4px solid #245265;font:20px/1.7 monospace;overflow:auto">正在准备多浏览器离线试玩版，内含真实seekdb引擎…</div>'
    html = html.replace('<body>', '<body>\n' + status, 1)
    package = '<script id="seekdb-bundle-manifest" type="application/json">' + json_script(manifest) + '</script>\n'
    package += '<script id="seekdb-bundle-payload" type="application/json">' + json_script({'nodes': nodes}) + '</script>\n' + BOOTSTRAP
    html = html.replace(entry_script, package, 1)
    # 完成构建后逐个重新核对正式资源，防止打包期间并发修改造成混合版本。
    for name, before in originals.items():
        if (ROOT / name).read_bytes() != before:
            raise ValueError(f'构建期间源文件改变，请重跑：{name}')
    output_bytes = html.encode('utf-8')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.single-html-', delete=False) as temporary:
        temporary.write(output_bytes)
        temporary_name = temporary.name
    os.replace(temporary_name, output)
    manifest.update({'output': str(output), 'outputBytes': len(output_bytes), 'outputSha256': sha(output_bytes),
                     'originalSourcesUnchanged': True})
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: manifest[key] for key in ['output', 'outputBytes', 'outputSha256', 'moduleCount',
          'syntaxCheckedModules', 'engines', 'originalSourcesUnchanged']}, ensure_ascii=False, indent=2))
    print('manifest:', manifest_path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--manifest', type=pathlib.Path, default=DEFAULT_MANIFEST)
    parser.add_argument('--wasm-gzip-cache', type=pathlib.Path, default=pathlib.Path(tempfile.gettempdir()) / 'seekdb-chrome.wasm.gz')
    parser.add_argument('--webkit-wasm-gzip-cache', type=pathlib.Path, default=pathlib.Path(tempfile.gettempdir()) / 'seekdb-webkit.wasm.gz')
    options = parser.parse_args()
    build(options.output.resolve(), options.manifest.resolve(), options.wasm_gzip_cache.resolve(),
          options.webkit_wasm_gzip_cache.resolve())
