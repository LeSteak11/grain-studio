// Histogram of the rendered view: downsample the GL canvas, bin RGB + luma, draw.
const SAMPLE_W = 192;
const SAMPLE_H = 128;
const BINS = 64;
let scratch: CanvasRenderingContext2D | null = null;

export function drawHistogram(source: HTMLCanvasElement, target: HTMLCanvasElement) {
  if (!scratch) {
    const c = document.createElement('canvas');
    c.width = SAMPLE_W;
    c.height = SAMPLE_H;
    scratch = c.getContext('2d', { willReadFrequently: true })!;
  }
  // Must run in the same task as the GL draw (drawing buffer isn't preserved).
  scratch.drawImage(source, 0, 0, SAMPLE_W, SAMPLE_H);
  const d = scratch.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
  const r = new Uint32Array(BINS);
  const g = new Uint32Array(BINS);
  const b = new Uint32Array(BINS);
  const l = new Uint32Array(BINS);
  const sh = 8 - Math.log2(BINS);
  for (let i = 0; i < d.length; i += 4) {
    r[d[i] >> sh]++;
    g[d[i + 1] >> sh]++;
    b[d[i + 2] >> sh]++;
    l[(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) >> sh]++;
  }
  let max = 1;
  for (let i = 1; i < BINS - 1; i++) max = Math.max(max, r[i], g[i], b[i]);
  const ctx = target.getContext('2d')!;
  const W = target.width;
  const H = target.height;
  ctx.clearRect(0, 0, W, H);
  const plot = (arr: Uint32Array, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < BINS; i++) ctx.lineTo((i / (BINS - 1)) * W, H - Math.min(1, arr[i] / max) * H);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  };
  ctx.globalCompositeOperation = 'lighter';
  plot(r, 'rgba(230,70,70,0.55)');
  plot(g, 'rgba(70,200,90,0.55)');
  plot(b, 'rgba(70,120,240,0.55)');
  ctx.globalCompositeOperation = 'source-over';
  plot(l, 'rgba(235,235,230,0.18)');
}
