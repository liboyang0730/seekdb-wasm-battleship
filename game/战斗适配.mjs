/* 只管理桌面战斗画面的整体缩放与节点归位，不读取游戏状态或更改浏览器缩放。 */
const installed = new WeakMap();

export function setupBattleFit() {
  const doc = globalThis.document;
  if (!doc?.body) return null;
  if (installed.has(doc)) return installed.get(doc);
  const body = doc.body;
  const shell = doc.querySelector('.terminal-shell');
  const masthead = doc.querySelector('.masthead');
  const manual = doc.querySelector('.quick-rule-section');
  const core = doc.querySelector('.navy-game-screen');
  if (!shell || !masthead || !manual || !core) return null;
  const win = doc.defaultView;
  const host = doc.createElement('section');
  host.className = 'battle-fit-host';
  host.setAttribute('aria-label', '战斗画面显示方式');
  host.hidden = true;
  const tools = doc.createElement('div');
  tools.className = 'battle-fit-toolbar';
  const fitButton = doc.createElement('button');
  const originalButton = doc.createElement('button');
  for (const button of [fitButton, originalButton]) {
    button.type = 'button';
    button.className = 'button battle-fit-button';
  }
  fitButton.textContent = '适应屏幕';
  originalButton.textContent = '原始大小';
  const hint = doc.createElement('p');
  hint.className = 'battle-fit-hint';
  hint.setAttribute('role', 'status');
  hint.hidden = true;
  tools.append(fitButton, originalButton, hint);
  const viewport = doc.createElement('div');
  viewport.className = 'battle-fit-viewport';
  const stage = doc.createElement('div');
  stage.className = 'battle-fit-stage';
  const manualSlot = doc.createElement('div');
  manualSlot.className = 'battle-fit-manual-slot';
  const coreSlot = doc.createElement('div');
  coreSlot.className = 'battle-fit-core-slot';
  stage.append(manualSlot, coreSlot);
  viewport.append(stage);
  host.append(tools, viewport);
  shell.prepend(host);
  const radarDetails = core.querySelector('.radar-details');
  const radarReport = core.querySelector('#radar-report');
  const radarRecords = doc.createElement('section');
  radarRecords.className = 'battle-fit-radar-records';
  radarRecords.setAttribute('aria-label', '雷达逐格结果与实际 SQL');
  radarRecords.hidden = true;
  host.after(radarRecords);
  let mode = 'fit';
  let previousView = body.dataset.view;
  let frame = 0;
  let mounted = false;
  let destroyed = false;
  let anchorPending = false;
  let positions = [];
  const modifier = /Mac/i.test(win.navigator.platform) ? '⌘' : 'Ctrl';
  if (!body.dataset.battleFitColumns) body.dataset.battleFitColumns = '3';
  body.dataset.battleFitReady = 'true';

  function mount() {
    if (mounted) return;
    positions = [masthead, manual, core, radarDetails].filter(Boolean).map(node => {
      const placeholder = doc.createComment('战斗适配归位点');
      node.before(placeholder);
      return { node, placeholder };
    });
    stage.prepend(masthead);
    manualSlot.append(manual);
    coreSlot.append(core);
    if (radarDetails) radarRecords.append(radarDetails);
    mounted = true;
  }

  function restore() {
    if (!mounted) return;
    // 先还原雷达明细，再还原其上层战斗节点，避免遗漏子树。
    for (const {node, placeholder} of [...positions].reverse()) {
      if (placeholder.parentNode) placeholder.replaceWith(node);
    }
    positions = [];
    mounted = false;
    radarRecords.hidden = true;
  }

  function update() {
    frame = 0;
    const inBattle = body.dataset.view === 'battle';
    const active = inBattle && mode === 'fit';
    host.hidden = !inBattle;
    body.dataset.battleFitActive = String(active);
    body.dataset.battleFitMode = mode;
    fitButton.setAttribute('aria-pressed', String(mode === 'fit'));
    originalButton.setAttribute('aria-pressed', String(mode === 'original'));
    viewport.hidden = !active;
    if (!active) {
      restore();
      body.dataset.battleFitScale = '1';
      hint.hidden = !inBattle;
      hint.textContent = `原始大小：可用 ${modifier} + 加号放大。${modifier}− 缩小，${modifier}0 恢复浏览器比例。`;
      if (inBattle && anchorPending) win.scrollTo({top: 0, behavior: 'instant'});
      anchorPending = false;
      return;
    }
    mount();
    const columns = body.dataset.battleFitColumns === '2' ? 2 : 3;
    const nativeWidth = columns === 3 ? 1664 : 1536;
    stage.style.width = `${nativeWidth}px`;
    const top = host.getBoundingClientRect().top + win.scrollY;
    const availableHeight = Math.max(1, win.innerHeight - top - tools.getBoundingClientRect().height - 8 - 12);
    const nativeHeight = stage.offsetHeight;
    if (!nativeHeight || !viewport.clientWidth) return;
    // CSS zoom只作用于这一组，原有字号、留白和像素图形按同一比例缩放。
    const ratio = Math.min(1, viewport.clientWidth / nativeWidth, availableHeight / nativeHeight);
    const scale = Math.max(0.1, Math.floor(ratio * 1000) / 1000);
    const previousScale = host.style.getPropertyValue('--battle-fit-scale');
    if (previousScale !== String(scale)) host.style.setProperty('--battle-fit-scale', String(scale));
    body.dataset.battleFitScale = String(scale);
    hint.hidden = scale >= 0.65;
    hint.textContent = `当前显示 ${Math.round(scale * 100)}%。放大窗口更清楚；也可选原始大小，按 ${modifier}− 缩小、${modifier}0 恢复。`;
    radarRecords.hidden = !radarDetails || !radarReport || radarReport.hidden;
    if (anchorPending) win.scrollTo({top: 0, behavior: 'instant'});
    anchorPending = false;
  }

  function refresh() {
    if (destroyed) return;
    // 比动画下一帧更早设定标记，让主程序停止旧的自动滚动。
    body.dataset.battleFitActive = String(body.dataset.view === 'battle' && mode === 'fit');
    if (!frame) frame = win.requestAnimationFrame(update);
  }
  function choose(next) {
    mode = next;
    anchorPending = true;
    refresh();
  }
  const onFit = () => choose('fit');
  const onOriginal = () => choose('original');
  fitButton.addEventListener('click', onFit);
  originalButton.addEventListener('click', onOriginal);
  const views = new MutationObserver(records => {
    const nextView = body.dataset.view;
    // renderFlow每轮会重写同一个data-view，只有实际切屏才允许重新定位。
    if (nextView !== previousView) {
      anchorPending = nextView === 'battle';
      previousView = nextView;
      if (nextView !== 'battle') { restore(); host.hidden = true; }
    }
    refresh();
  });
  views.observe(body, {attributes: true, attributeFilter: ['data-view', 'data-battle-fit-columns']});
  const content = new MutationObserver(refresh);
  for (const node of [masthead, manual, core]) {
    content.observe(node, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden']});
  }
  const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
  sizes?.observe(stage);
  sizes?.observe(host);
  win.addEventListener('resize', refresh);
  doc.fonts?.ready.then(refresh).catch(() => {});
  const api = {
    refresh,
    setMode(value) { if (value === 'fit' || value === 'original') choose(value); },
    destroy() {
      destroyed = true;
      if (frame) win.cancelAnimationFrame(frame);
      views.disconnect(); content.disconnect(); sizes?.disconnect();
      win.removeEventListener('resize', refresh);
      fitButton.removeEventListener('click', onFit); originalButton.removeEventListener('click', onOriginal);
      restore(); host.remove(); radarRecords.remove();
      for (const name of ['battleFitActive', 'battleFitScale', 'battleFitMode', 'battleFitReady']) delete body.dataset[name];
      installed.delete(doc);
    },
  };
  installed.set(doc, api);
  anchorPending = body.dataset.view === 'battle';
  refresh();
  return api;
}
