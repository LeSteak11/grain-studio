// Capture chart for turning presets from your own VSCO account into LUTs.
// Every RGB lattice point (33^3) gets a 16x16 patch aligned to JPEG blocks, so chroma
// subsampling and compression don't bleed between colors. We sample each patch's center.
import type { Lut } from './luts';

export const CHART = { n: 33, patch: 16, cols: 198, rows: 182 };
export const CHART_W = CHART.cols * CHART.patch; // 3168
export const CHART_H = CHART.rows * CHART.patch; // 2912

export async function makeChartPng(): Promise<Uint8Array> {
  const { n, patch, cols, rows } = CHART;
  const c = new OffscreenCanvas(CHART_W, CHART_H);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(CHART_W, CHART_H);
  const d = img.data;
  const total = n * n * n;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      let r = 128;
      let g = 128;
      let b = 128;
      if (i < total) {
        r = Math.round(((i % n) * 255) / (n - 1));
        g = Math.round(((Math.floor(i / n) % n) * 255) / (n - 1));
        b = Math.round((Math.floor(i / (n * n)) * 255) / (n - 1));
      }
      for (let y = 0; y < patch; y++) {
        let o = ((row * patch + y) * CHART_W + col * patch) * 4;
        for (let x = 0; x < patch; x++, o += 4) {
          d[o] = r;
          d[o + 1] = g;
          d[o + 2] = b;
          d[o + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Reads an exported (preset-applied) chart back into a 33^3 LUT. Tolerates resizing. */
export function extractLut(img: ImageData): Lut {
  const { width: w, height: h, data } = img;
  const want = CHART_W / CHART_H;
  if (Math.abs(w / h / want - 1) > 0.02) {
    throw new Error(`This isn't the capture chart (got ${w}×${h}, expected ${CHART_W}×${CHART_H}). Don't crop or rotate it in VSCO.`);
  }
  const { n, patch, cols } = CHART;
  const sx = w / CHART_W;
  const sy = h / CHART_H;
  const out = new Uint8Array(n * n * n * 3);
  for (let i = 0; i < n * n * n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x0 = Math.floor((col * patch + 4) * sx);
    const x1 = Math.max(x0 + 1, Math.floor((col * patch + 12) * sx));
    const y0 = Math.floor((row * patch + 4) * sy);
    const y1 = Math.max(y0 + 1, Math.floor((row * patch + 12) * sy));
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let cnt = 0;
    for (let y = y0; y < y1; y++) {
      let o = (y * w + x0) * 4;
      for (let x = x0; x < x1; x++, o += 4) {
        sr += data[o];
        sg += data[o + 1];
        sb += data[o + 2];
        cnt++;
      }
    }
    out[i * 3] = Math.round(sr / cnt);
    out[i * 3 + 1] = Math.round(sg / cnt);
    out[i * 3 + 2] = Math.round(sb / cnt);
  }
  return { size: n, data: out };
}

export async function extractLutFromBytes(bytes: Uint8Array): Promise<Lut> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return extractLut(ctx.getImageData(0, 0, c.width, c.height));
}
