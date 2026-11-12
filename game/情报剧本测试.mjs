import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignalStory, SIGNAL_FEATURES } from './情报剧本.mjs';

const civil = [0.12, 0.42, 0.36, 0.82, 0.28, 0.54, 0.64, 0.08];
const weather = [0.06, 0.04, 0.01, 0.08, 0.45, 0.03, 0.18, 0.02];
const distance = (a, b) => Math.sqrt(a.reduce((sum, n, i) => sum + (n - b[i]) ** 2, 0));

test('六关各至少六套题面，单张有效回波和监听随seed变化且与主呼号独立', () => {
  const mainCallSigns = new Set(['TERN', 'KITE', 'PETREL', 'GULL', 'HERON', 'KESTREL', 'OSPREY', 'SWIFT']);
  const allTitles = new Set();
  for (let level = 1; level <= 6; level++) {
    const words = new Set(), titles = new Set(), visible = new Set();
    for (let index = 0; index < 128; index++) {
      const story = createSignalStory({ level, seed: `story-${index}` });
      assert.equal(story.echo.name, 'warship');
      assert.equal(story.echo.vector.length, 8);
      assert.match(story.listen.keyword, /^[A-Z]{4,16}$/);
      assert.ok(!mainCallSigns.has(story.listen.keyword));
      assert.ok(story.echo.source && story.echo.text && story.listen.source && story.listen.text);
      assert.ok(story.listen.text.includes(story.listen.keyword));
      assert.equal(story.archiveLines.length, 6);
      assert.equal(new Set(story.archiveLines).size, 6);
      assert.ok(story.feedback.empty && story.feedback.wrongArea);
      assert.doesNotMatch(JSON.stringify(story), /烤鱼|"cells"|"ships"|"fleet"/);
      words.add(story.listen.keyword); titles.add(story.title); allTitles.add(story.title);
      visible.add(JSON.stringify([story.title, story.echo.source, story.echo.text, story.listen.source, story.listen.text]));
    }
    assert.equal(words.size, 6);
    assert.equal(titles.size, 6);
    assert.ok(visible.size >= 70, `第${level}关跨seed实际题面变化过少：${visible.size}`);
  }
  assert.equal(allTitles.size, 36);
});

test('同seed和Fork完全稳定，返回对象相互独立，level数字与对象均可用', () => {
  for (let level = 1; level <= 6; level++) {
    const a = createSignalStory({ level, seed: 'fixed-fork' });
    assert.deepEqual(createSignalStory({ level: { id: level }, seed: 'fixed-fork' }), a);
    assert.deepEqual(createSignalStory({ level, seed: 'fixed-fork' }), a);
    a.echo.vector[0] = -99; a.archiveLines[0] = 'changed';
    const b = createSignalStory({ level, seed: 'fixed-fork' });
    assert.ok(b.echo.vector[0] >= 0); assert.notEqual(b.archiveLines[0], 'changed');
  }
  assert.throws(() => createSignalStory({ level: 0 }), RangeError);
  assert.throws(() => createSignalStory({ level: 7 }), RangeError);
});

test('人工八维特征每关有本质区别，民船与天气显著远离有效回波', () => {
  assert.equal(SIGNAL_FEATURES.length, 8);
  const reference = [];
  for (let level = 1; level <= 6; level++) {
    for (let index = 0; index < 128; index++) {
      const { echo } = createSignalStory({ level, seed: `vector-${index}` });
      assert.deepEqual(echo.features, SIGNAL_FEATURES);
      assert.ok(echo.vector.every(n => Number.isFinite(n) && n >= 0 && n <= 1));
      assert.ok(distance(echo.vector, civil) > 0.8);
      assert.ok(distance(echo.vector, weather) > 0.8);
    }
    reference.push(createSignalStory({ level, seed: 'reference' }).echo.vector);
  }
  for (let i = 0; i < reference.length; i++) for (let j = i + 1; j < reference.length; j++) {
    assert.ok(distance(reference[i], reference[j]) > 0.3, `第${i + 1}/${j + 1}关不应只换文本而沿用回波`);
  }
});
