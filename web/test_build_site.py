import base64, gzip, hashlib, importlib.util, json, pathlib, re, subprocess, sys, tempfile, unittest

SCRIPT = pathlib.Path(__file__).with_name('build-site.py')

class BuildSiteTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), '缺少网页专用分块构建脚本')
        spec = importlib.util.spec_from_file_location('web_build_site', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory(prefix='seekdb-build-site-fixture-')
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.source = self.root / 'offline.html'
        self.packed = {}
        engines, nodes = {}, {}
        for key in ('chrome', 'webkit'):
            raw = hashlib.shake_256(key.encode()).digest(1100000)
            packed = gzip.compress(raw, mtime=0)
            self.packed[key] = packed
            path = f'engine/{key}.wasm'
            digest = hashlib.sha256(packed).hexdigest()
            engines[key] = {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'gzipBytes': len(packed), 'gzipSha256': digest}
            nodes[path] = {'kind': 'wasm-gzip', 'data': base64.b64encode(packed).decode(), 'gzipBytes': len(packed), 'gzipSha256': digest}
        nodes['module.mjs'] = {'kind': 'module', 'parts': ['const text="</script><script>bad</script>";']}
        self.payload = {'nodes': nodes}
        self.manifest = {'engines': engines}
        self.write_fixture()

    def write_fixture(self, marker=None):
        marker = marker if marker is not None else 'const compressed = decode(payload.nodes[engine.path].data);'
        safe = lambda value: json.dumps(value, ensure_ascii=False).replace('<', '\\u003c')
        self.source.write_text('<html><script id="seekdb-bundle-manifest" type="application/json">'+safe(self.manifest)+'</script><script id="seekdb-bundle-payload" type="application/json">'+safe(self.payload)+'</script><script type="module">'+marker+'</script></html>')

    def test_chunks_hashes_and_input_preserved(self):
        before = self.source.read_bytes()
        site = self.root / 'site'
        result = self.module.build(self.source, site)
        manifest = json.loads((site/'assets.json').read_text())
        self.assertEqual(result, manifest)
        self.assertEqual(manifest['version'], 'v0.2.1')
        output = (site/'game.html').read_bytes()
        self.assertEqual(before, self.source.read_bytes())
        self.assertEqual(hashlib.sha256(output).hexdigest(), manifest['game']['sha256'])
        self.assertEqual(len(output), manifest['game']['bytes'])
        self.assertEqual(manifest['game']['path'], 'game.html')
        payload = json.loads(re.search(r'<script id="seekdb-bundle-payload" type="application/json">(.*?)</script>', output.decode()).group(1))
        self.assertEqual(payload['nodes']['module.mjs'], self.payload['nodes']['module.mjs'])
        for key in ('chrome', 'webkit'):
            engine = manifest['engines'][key]
            self.assertEqual(len(engine['chunks']), (len(self.packed[key]) + 256*1024 - 1) // (256*1024))
            merged = bytearray()
            for index, chunk in enumerate(engine['chunks']):
                self.assertEqual(chunk['path'], f'assets/engine-{key}-{index:03d}.bin')
                data = (site/chunk['path']).read_bytes()
                self.assertEqual(len(data), chunk['bytes'])
                self.assertLessEqual(len(data), 256*1024)
                self.assertEqual(hashlib.sha256(data).hexdigest(), chunk['sha256'])
                merged.extend(data)
            self.assertEqual(merged, self.packed[key])
            self.assertEqual(hashlib.sha256(merged).hexdigest(), engine['gzipSha256'])
            node = payload['nodes'][self.manifest['engines'][key]['path']]
            self.assertNotIn('data', node)
            self.assertEqual(node['chunks'], engine['chunks'])
        self.assertIn('Math.min(4, chunks.length)', output.decode())
        self.assertNotIn('const compressed = decode(payload.nodes[engine.path].data);', output.decode())

    def test_workflow_game_can_be_replaced_in_site(self):
        site = self.root/'site';site.mkdir()
        source = site/'game.html';source.write_bytes(self.source.read_bytes())
        self.module.build(source, site)
        self.assertTrue((site/'assets.json').is_file())

    def test_256k_game_and_engine_chunks_reassemble_and_cli_preserves_content(self):
        # 使用真实字节构建多块HTML，避免只用很小的页面漏掉game分块边界。
        self.payload['nodes']['content.bin'] = {
            'kind': 'asset',
            'data': base64.b64encode(hashlib.shake_256(b'html-content').digest(600000)).decode(),
        }
        self.write_fixture()
        before = self.source.read_bytes()
        limit = 256 * 1024

        # 旧引擎分块配置只作字节参照，非引擎内容及网页bootstrap应保持不变。
        configured = self.module.CHUNK_BYTES
        try:
            self.module.CHUNK_BYTES = 1024 * 1024
            self.module.build(self.source, self.root/'legacy-limit')
        finally:
            self.module.CHUNK_BYTES = configured
        site = self.root/'small-chunks'
        manifest = self.module.build(self.source, site)
        for key, engine in manifest['engines'].items():
            merged = b''
            for chunk in engine['chunks']:
                data = (site/chunk['path']).read_bytes()
                self.assertGreater(len(data), 0)
                self.assertLessEqual(len(data), limit, '引擎分块不得超过256KiB')
                self.assertEqual(len(data), chunk['bytes'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), chunk['sha256'])
                merged += data
            self.assertEqual(merged, self.packed[key])
            self.assertEqual(hashlib.sha256(merged).hexdigest(), engine['gzipSha256'])
            raw = gzip.decompress(merged)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), self.manifest['engines'][key]['sha256'])
            self.assertEqual(len(raw), self.manifest['engines'][key]['bytes'])
        html = (site/'game.html').read_bytes()
        game = manifest['game']
        self.assertGreater(len(game['chunks']), 1)
        merged = b''
        for index, chunk in enumerate(game['chunks']):
            self.assertEqual(chunk['path'], f'assets/game-{index:03d}.bin')
            data = (site/chunk['path']).read_bytes()
            self.assertGreater(len(data), 0)
            self.assertLessEqual(len(data), limit, 'HTML分块不得超过256KiB')
            self.assertEqual(len(data), chunk['bytes'])
            self.assertEqual(hashlib.sha256(data).hexdigest(), chunk['sha256'])
            merged += data
        self.assertEqual(merged, html, 'game分块重组必须还原逐字节相同HTML')
        self.assertEqual(len(merged), game['bytes'])
        self.assertEqual(hashlib.sha256(merged).hexdigest(), game['sha256'])
        legacy = (self.root/'legacy-limit'/'game.html').read_text()
        current = html.decode()
        old_payload, old_span = self.module.json_element(legacy, 'seekdb-bundle-payload')
        new_payload, new_span = self.module.json_element(current, 'seekdb-bundle-payload')
        self.assertEqual(legacy[:old_span[0]] + '<payload>' + legacy[old_span[1]:],
                         current[:new_span[0]] + '<payload>' + current[new_span[1]:])
        for path, node in self.payload['nodes'].items():
            if node['kind'] != 'wasm-gzip':
                self.assertEqual(old_payload['nodes'][path], node)
                self.assertEqual(new_payload['nodes'][path], node)
        self.assertEqual(self.module.json_element(current, 'seekdb-bundle-manifest')[0], self.manifest)
        self.assertEqual(self.source.read_bytes(), before)
        cli_site = self.root/'cli-site'
        result = subprocess.run([sys.executable, str(SCRIPT), '--game', str(self.source), '--site', str(cli_site)],
                                capture_output=True, text=True, check=True)
        summary = json.loads(result.stdout)
        self.assertEqual(summary['version'], 'v0.2.1')
        self.assertEqual(summary['game'], game)
        self.assertEqual((cli_site/'game.html').read_bytes(), html)
        self.assertEqual(json.loads((cli_site/'assets.json').read_text()), manifest)

    def test_rejects_symlink_output_escape(self):
        site = self.root/'site';site.mkdir()
        outside = self.root/'outside';outside.mkdir()
        (site/'assets').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): self.module.build(self.source, site)
        self.assertEqual(list(outside.iterdir()), [])

    def test_rejects_bootstrap_mismatch(self):
        self.write_fixture('const compressed = null;')
        with self.assertRaises(ValueError): self.module.build(self.source, self.root/'site')

    def test_rejects_corrupted_gzip_digest(self):
        self.payload['nodes']['engine/chrome.wasm']['gzipSha256'] = '0'*64
        self.write_fixture()
        with self.assertRaises(ValueError): self.module.build(self.source, self.root/'site')

    def test_rejects_extra_wasm_node(self):
        self.payload['nodes']['../escape.wasm'] = {'kind':'wasm-gzip','data':'AA=='}
        self.write_fixture()
        with self.assertRaises(ValueError): self.module.build(self.source, self.root/'site')

if __name__ == '__main__': unittest.main()
