#!/usr/bin/env python3
"""将正式离线单页转换为网页专用站点；HTML与双引擎分块，不改离线构建器。"""
import argparse
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

CHUNK_BYTES = 256 * 1024
VERSION = 'v0.2.1'
ORIGINAL_COMPRESSED = 'const compressed = decode(payload.nodes[engine.path].data);'
WEB_COMPRESSED = r'''const compressed = await (async () => {
    const node = payload.nodes[engine.path], chunks = node.chunks;
    if (!Array.isArray(chunks) || !chunks.length || node.gzipBytes !== engine.gzipBytes ||
        node.gzipSha256 !== engine.gzipSha256) throw new Error('引擎分块清单不完整。');
    const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const parts = new Array(chunks.length);
    let cursor = 0, stopped = false;
    async function download() {
      while (!stopped && cursor < chunks.length) {
        const index = cursor++, chunk = chunks[index];
        try {
          const expectedPath = `assets/engine-${engineKey}-${String(index).padStart(3, '0')}.bin`;
          if (chunk.path !== expectedPath || !Number.isInteger(chunk.bytes) ||
              chunk.bytes < 1 || chunk.bytes > 1048576 || !/^[a-f0-9]{64}$/.test(chunk.sha256)) {
            throw new Error('引擎分块路径或校验信息无效。');
          }
          const url = new URL(chunk.path, document.baseURI);
          if (url.origin !== location.origin) throw new Error('拒绝加载站点以外的引擎分块。');
          const response = await fetch(url, {mode:'same-origin', credentials:'same-origin', redirect:'error'});
          if (!response.ok || response.status !== 200) throw new Error(`引擎分块下载失败（HTTP ${response.status}）。`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength !== chunk.bytes || await digest(bytes) !== chunk.sha256) {
            throw new Error('引擎分块校验失败，请返回入口重试准备。');
          }
          parts[index] = bytes;
        } catch (error) { stopped = true; throw error; }
      }
    }
    await Promise.all(Array.from({length:Math.min(4, chunks.length)}, download));
    const total = parts.reduce((size, part) => size + part.byteLength, 0);
    if (total !== engine.gzipBytes) throw new Error('引擎压缩资源长度不符。');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    if (await digest(bytes) !== engine.gzipSha256) throw new Error('完整引擎压缩资源校验失败。');
    return bytes;
  })();'''


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_json(value):
    # JSON 内的结束标签不能截断 HTML 的 script 元素。
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')


def json_element(html, identifier):
    pattern = re.compile(r'<script\b[^>]*\bid=["\']' + re.escape(identifier) +
                         r'["\'][^>]*>(.*?)</script\s*>', re.DOTALL | re.IGNORECASE)
    matches = list(pattern.finditer(html))
    if len(matches) != 1:
        raise ValueError(f'{identifier} 必须且只能出现一次')
    match = matches[0]
    return json.loads(match.group(1)), match.span(1)


def inside(site, relative):
    path = site / relative
    if not path.resolve().is_relative_to(site):
        raise ValueError(f'输出路径越出站点目录：{relative}')
    return path


def write(site, relative, data):
    path = inside(site, relative)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 原子替换不会通过已有硬链接改写站点外的文件。
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.web-build-', delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
        temporary.chmod(0o644)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def build(game, site):
    game, site = Path(game).resolve(), Path(site).resolve()
    html = game.read_text(encoding='utf-8')
    if html.count(ORIGINAL_COMPRESSED) != 1:
        raise ValueError('正式单页引擎解码行不是唯一匹配，拒绝生成混合版本')
    manifest, _ = json_element(html, 'seekdb-bundle-manifest')
    payload, span = json_element(html, 'seekdb-bundle-payload')
    engines, nodes = manifest['engines'], payload['nodes']
    if set(engines) != {'chrome', 'webkit'}:
        raise ValueError('正式单页必须包含 Chrome 和 WebKit 两种引擎')
    wasm_paths = {node_path for node_path, node in nodes.items() if node.get('kind') == 'wasm-gzip'}
    if wasm_paths != {engine['path'] for engine in engines.values()} or len(wasm_paths) != 2:
        raise ValueError('载荷的 Wasm 节点与引擎清单不一致')
    assets = {'version': VERSION, 'game': {}, 'engines': {}}
    outputs = []
    for key in ('chrome', 'webkit'):
        engine = engines[key]
        node = nodes[engine['path']]
        try:
            compressed = base64.b64decode(node['data'], validate=True)
        except (KeyError, ValueError, binascii.Error) as error:
            raise ValueError(f'{key} 没有有效的内嵌引擎 gzip') from error
        if not compressed or any(item.get('gzipBytes') != len(compressed) or
                                 item.get('gzipSha256') != sha(compressed) for item in (node, engine)):
            raise ValueError(f'{key} 压缩长度或 SHA-256 与正式清单不符')
        chunks = []
        for index, start in enumerate(range(0, len(compressed), CHUNK_BYTES)):
            data = compressed[start:start + CHUNK_BYTES]
            relative = f'assets/engine-{key}-{index:03d}.bin'
            chunks.append({'path': relative, 'bytes': len(data), 'sha256': sha(data)})
            outputs.append((relative, data))
        del node['data']
        node['chunks'] = chunks
        assets['engines'][key] = {'chunks': chunks, 'gzipBytes': len(compressed),
                                  'gzipSha256': sha(compressed)}
    html = html[:span[0]] + safe_json(payload) + html[span[1]:]
    html = html.replace(ORIGINAL_COMPRESSED, WEB_COMPRESSED, 1)
    page = html.encode('utf-8')
    game_chunks = []
    for index, start in enumerate(range(0, len(page), CHUNK_BYTES)):
        data = page[start:start + CHUNK_BYTES]
        relative = f'assets/game-{index:03d}.bin'
        game_chunks.append({'path': relative, 'bytes': len(data), 'sha256': sha(data)})
        outputs.append((relative, data))
    assets['game'] = {'path': 'game.html', 'bytes': len(page), 'sha256': sha(page), 'chunks': game_chunks}
    outputs.extend([('game.html', page), ('assets.json', (safe_json(assets) + '\n').encode('utf-8'))])
    # 所有路径先核验，再写文件，拒绝 assets/ 或目标文件的越界软链接。
    for relative, _ in outputs:
        inside(site, relative)
    site.mkdir(parents=True, exist_ok=True)
    for relative, data in outputs:
        write(site, relative, data)
    return assets


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, required=True)
    parser.add_argument('--site', type=Path, required=True)
    arguments = parser.parse_args()
    result = build(arguments.game, arguments.site)
    print(json.dumps({'version': result['version'], 'game': result['game'],
                      'chunks': {key: len(value['chunks']) for key, value in result['engines'].items()}},
                     ensure_ascii=False, indent=2))
