import base64, gzip, hashlib, importlib.util, json, pathlib, re, tempfile, unittest

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
            self.assertEqual(len(engine['chunks']), 2)
            merged = bytearray()
            for index, chunk in enumerate(engine['chunks']):
                self.assertEqual(chunk['path'], f'assets/engine-{key}-{index:03d}.bin')
                data = (site/chunk['path']).read_bytes()
                self.assertEqual(len(data), chunk['bytes'])
                self.assertLessEqual(len(data), 1024*1024)
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
