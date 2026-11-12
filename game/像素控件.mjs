/* 像素控件只处理展示与键盘操作，库存和解锁判断由主程序传入。 */
const brandImages = new Map();

/** 用原生按钮展示武器，不调用系统下拉菜单。 */
export function renderWeaponChoices({ container, options = [], value, onChoose }) {
  if (!container) throw new TypeError('缺少武器选择容器。');
  const doc = container.ownerDocument;
  const focusedValue = container.contains(doc.activeElement)
    ? doc.activeElement.dataset.weaponId : null;
  container.setAttribute('role', 'radiogroup');
  if (!container.hasAttribute('aria-label')) container.setAttribute('aria-label', '选择武器');
  const buttons = options.map(option => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'weapon-choice-card';
    button.dataset.weaponId = String(option.value);
    button.disabled = Boolean(option.disabled);
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(String(option.value) === String(value)));
    button.tabIndex = -1;
    const icon = doc.createElement('canvas');
    icon.width = 32;
    icon.height = 32;
    icon.dataset.pixelIcon = String(option.icon ?? option.value);
    icon.setAttribute('aria-hidden', 'true');
    const label = doc.createElement('span');
    label.className = 'weapon-choice-label';
    const valueLabel=String(option.label??option.value),separator=valueLabel.lastIndexOf(' · ');
    if(separator<0)label.textContent=valueLabel;
    else {
      const name=doc.createElement('span'),stock=doc.createElement('span');
      name.className='weapon-choice-name';name.textContent=valueLabel.slice(0,separator);
      stock.className='weapon-choice-stock';stock.textContent=valueLabel.slice(separator+3);
      label.append(name,stock);
    }
    button.append(icon, label);
    button.addEventListener('click', () => {
      // 同步选中反馈，主程序随后可按真实库存重新渲染。
      for (const item of buttons) {
        const selected = item === button;
        item.setAttribute('aria-checked', String(selected));
        item.tabIndex = selected ? 0 : -1;
      }
      onChoose?.(option.value);
    });
    button.addEventListener('keydown', event => {
      const available = buttons.filter(item => !item.disabled);
      const index = available.indexOf(button);
      let next;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % available.length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + available.length) % available.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = available.length - 1;
      if (next === undefined || !available.length) return;
      // 方向键只移焦点，按 Enter 或空格确认，避免意外换装与页面滚动。
      event.preventDefault();
      event.stopPropagation();
      for (const item of buttons) item.tabIndex = item === available[next] ? 0 : -1;
      available[next].focus({ preventScroll: true });
    });
    return button;
  });
  const tabStop = buttons.find(button => !button.disabled && button.getAttribute('aria-checked') === 'true')
    ?? buttons.find(button => !button.disabled);
  if (tabStop) tabStop.tabIndex = 0;
  container.replaceChildren(...buttons);
  if (focusedValue !== null) {
    const restored = buttons.find(button => !button.disabled && button.dataset.weaponId === focusedValue) ?? tabStop;
    if (restored) {
      for (const item of buttons) item.tabIndex = item === restored ? 0 : -1;
      restored.focus({ preventScroll: true });
    }
  }
  return buttons;
}

/** 从用户原始品牌 PNG 生成低分辨率二值像素版，保留品牌蓝点。 */
export async function paintPixelBrand(canvas, {
  source = new URL('./assets/branding/seekdb-logo.png', import.meta.url).href,
  blue = [1, 129, 253],
} = {}) {
  if (!canvas) throw new TypeError('缺少品牌画布。');
  const doc = canvas.ownerDocument;
  const url = String(source);
  if (!brandImages.has(url)) {
    brandImages.set(url, new Promise((resolve, reject) => {
      const image = new doc.defaultView.Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('品牌原图载入失败。'));
      image.src = url;
    }).catch(error => { brandImages.delete(url); throw error; }));
  }
  const image = await brandImages.get(url);
  canvas.width = 72;
  canvas.height = 17;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, 72, 17);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const height = image.naturalHeight * 72 / image.naturalWidth;
  ctx.drawImage(image, 0, (17 - height) / 2, 72, height);
  const pixels = ctx.getImageData(0, 0, 72, 17);
  let inkPixels = 0;
  let bluePixels = 0;
  for (let index = 0; index < pixels.data.length; index += 4) {
    const [r, g, b, alpha] = pixels.data.subarray(index, index + 4);
    if (alpha < 112) {
      pixels.data.fill(0, index, index + 4);
      continue;
    }
    const isBlue = b > r + 64 && b > g + 32;
    pixels.data[index] = isBlue ? blue[0] : 0;
    pixels.data[index + 1] = isBlue ? blue[1] : 0;
    pixels.data[index + 2] = isBlue ? blue[2] : 0;
    pixels.data[index + 3] = 255;
    if (isBlue) bluePixels += 1;
    else inkPixels += 1;
  }
  ctx.putImageData(pixels, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return { width: 72, height: 17, inkPixels, bluePixels };
}
