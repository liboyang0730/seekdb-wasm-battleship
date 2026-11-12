// 方案 A：蓝色静态海面与暖色战术标记，颜色不编码情报或舰位。
export const SEA_PALETTE = Object.freeze({
  water: '#1683b5',
  deep: '#1177a4',
  crest: '#38a2ca',
  foam: '#8ccadf',
  grid: '#102c45',
  frame: '#0c2238',
  ink: '#102c45',
  ship: '#fff1c6',
  hit: '#f16f50',
  sunk: '#ffe071',
  radarYes: '#ffe071',
  radarNo: '#fff1c6',
});

// 填整格海色，不绘制网格。调用方在全部海格之后统一画网格和标记。
// 纹理只按行列奇偶交替两种，无时间、随机数或情报输入，未攻击棋盘帧保持稳定。
// 10px 格中心保留 5×5 纯水色，15px 格中心保留 7×7 纯水色。
export function drawSeaCell(ctx, x, y, step, col, row) {
  const size = Math.floor(step);
  if (!Number.isFinite(size) || size < 4) return;
  const left = Math.floor(x), top = Math.floor(y);
  const phase = (((col | 0) + (row | 0)) & 1);
  ctx.save();
  ctx.fillStyle = SEA_PALETTE.water;
  ctx.fillRect(left, top, size, size);
  if (size >= 10) {
    const start = 2 + (phase & 1), waveY = size >= 14 ? 2 : 1;
    ctx.fillStyle = SEA_PALETTE.deep;
    ctx.fillRect(left + start, top + waveY + 1, 3, 1);
    ctx.fillStyle = SEA_PALETTE.crest;
    ctx.fillRect(left + start, top + waveY, 2, 1);
    ctx.fillRect(left + start + 2, top + waveY + 1, 2, 1);
    ctx.fillStyle = SEA_PALETTE.foam;
    ctx.fillRect(left + start + 1, top + waveY, 1, 1);
    const lowerY = size >= 14 ? size - 3 : size - 2;
    ctx.fillStyle = SEA_PALETTE.crest;
    ctx.fillRect(left + size - 6 + phase, top + lowerY, 3, 1);
    ctx.fillStyle = phase & 1 ? SEA_PALETTE.deep : SEA_PALETTE.foam;
    ctx.fillRect(left + size - 5, top + lowerY, 1, 1);
  }
  ctx.restore();
}
