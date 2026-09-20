import { FRAG_BLUR, FRAG_LUMA, FRAG_MAIN, VERT } from './shaders';
import { autoScale, orientedDims } from '../lib/geometry';
import { hasCurve, type Crop, type Curves, type EditState } from '../lib/types';
import { spline } from '../lib/looks';
import type { Lut } from '../lib/luts';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type ImgSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement | HTMLVideoElement | VideoFrame;

function srcDims(s: ImgSource): [number, number] {
  if (typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement) return [s.videoWidth, s.videoHeight];
  if (typeof VideoFrame !== 'undefined' && s instanceof VideoFrame) return [s.displayWidth, s.displayHeight];
  const e = s as { width: number; height: number };
  return [e.width, e.height];
}

class Program {
  readonly p: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(private gl: WebGL2RenderingContext, vs: string, fs: string) {
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    this.p = p;
  }
  u(name: string) {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.p, name));
    return this.locs.get(name)!;
  }
}

export interface RenderOpts {
  /** Override the crop (crop mode shows the full straightened frame). */
  crop?: Crop;
  /** Sub-rect of the crop to show (zoom), in crop space. */
  view?: [number, number, number, number];
  original?: boolean;
  /** Before/after divider (0..1 of the output width); left side shows the original. */
  split?: number | null;
}

/** 256-entry RGB table: master curve then per-channel curve. */
export function curveTable(c: Curves): Uint8Array {
  const m = spline(c.rgb);
  const fr = spline(c.r);
  const fg = spline(c.g);
  const fb = spline(c.b);
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = m(i / 255);
    out[i * 4] = q(fr(x));
    out[i * 4 + 1] = q(fg(x));
    out[i * 4 + 2] = q(fb(x));
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** GPU edit pipeline: one fragment pass per frame, plus a one-time blur per image for clarity. */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: AnyCanvas;
  readonly maxTex: number;
  srcW = 0;
  srcH = 0;
  private main: Program;
  private luma: Program;
  private blur: Program;
  private vao: WebGLVertexArrayObject;
  private src: WebGLTexture | null = null;
  private targets: { tex: WebGLTexture; fb: WebGLFramebuffer }[] = [];
  private lutTex = new Map<Lut, WebGLTexture>();
  private identity: WebGLTexture;
  private aniso: EXT_texture_filter_anisotropic | null;
  private curveTex: WebGLTexture;
  private curveKey = '';

  constructor(canvas: AnyCanvas, preserve = false) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: preserve,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.canvas = canvas;
    this.main = new Program(gl, VERT, FRAG_MAIN);
    this.luma = new Program(gl, VERT, FRAG_LUMA);
    this.blur = new Program(gl, VERT, FRAG_BLUR);
    this.vao = gl.createVertexArray()!;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.curveTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.identity = this.makeLutTex({ size: 2, data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 0, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255]) });
  }

  get hasImage() {
    return this.src !== null;
  }

  resize(w: number, h: number) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /** Upload a new video frame into the existing texture (cheaper than rebuilding it every frame). */
  updateFrame(src: ImgSource) {
    const [w, h] = srcDims(src);
    if (!w || !h) return;
    if (!this.src || w !== this.srcW || h !== this.srcH) {
      this.setImage(src);
      return;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.computeBlur();
  }

  setImage(img: ImgSource) {
    const gl = this.gl;
    const [w, h] = srcDims(img);
    if (this.src) gl.deleteTexture(this.src);
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, img as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    this.src = t;
    this.srcW = w;
    this.srcH = h;
    this.computeBlur();
  }

  private makeTarget(w: number, h: number) {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  }

  /** Low-res blurred luminance used for clarity. Sized relative to the image so preview == export. */
  computeBlur() {
    const gl = this.gl;
    for (const t of this.targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    const k = Math.min(1, 768 / Math.max(this.srcW, this.srcH));
    const bw = Math.max(1, Math.round(this.srcW * k));
    const bh = Math.max(1, Math.round(this.srcH * k));
    const a = this.makeTarget(bw, bh);
    const b = this.makeTarget(bw, bh);
    this.targets = [a, b];
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, bw, bh);
    gl.activeTexture(gl.TEXTURE0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
    gl.useProgram(this.luma.p);
    gl.uniform1i(this.luma.u('uSrc'), 0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.blur.p);
    gl.uniform1i(this.blur.u('uTex'), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.uniform2f(this.blur.u('uDir'), 2 / bw, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
    gl.bindTexture(gl.TEXTURE_2D, b.tex);
    gl.uniform2f(this.blur.u('uDir'), 0, 2 / bh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private makeLutTex(l: Lut) {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (l.data.length === l.size ** 3 * 4) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, l.size, l.size, l.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, l.data);
    } else {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, l.size, l.size, l.size, 0, gl.RGB, gl.UNSIGNED_BYTE, l.data);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return t;
  }

  render(e: EditState, lut: Lut | null, o: RenderOpts = {}) {
    const gl = this.gl;
    if (!this.src) return;
    const P = this.main;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(P.p);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.targets[0].tex);
    gl.activeTexture(gl.TEXTURE2);
    let tex = this.identity;
    if (lut) {
      tex = this.lutTex.get(lut) ?? this.makeLutTex(lut);
      this.lutTex.set(lut, tex);
    }
    gl.bindTexture(gl.TEXTURE_3D, tex);
    const curveOn = hasCurve(e);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    if (curveOn) {
      const key = JSON.stringify(e.curve);
      if (key !== this.curveKey) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, curveTable(e.curve));
        this.curveKey = key;
      }
    }
    gl.uniform1i(P.u('uSrc'), 0);
    gl.uniform1i(P.u('uBlur'), 1);
    gl.uniform1i(P.u('uLut'), 2);
    gl.uniform1i(P.u('uCurve'), 3);
    gl.uniform1f(P.u('uCurveOn'), curveOn ? 1 : 0);
    gl.uniform1f(P.u('uSplitPos'), o.split ?? -1);
    gl.uniform1f(P.u('uLutSize'), lut ? lut.size : 2);
    gl.uniform1f(P.u('uLutAmt'), lut && e.preset ? e.strength : 0);

    const [W, H] = orientedDims(e.rotate, this.srcW, this.srcH);
    const crop = o.crop ?? e.crop;
    const view = o.view ?? [0, 0, 1, 1];
    gl.uniform2f(P.u('uSrcSize'), this.srcW, this.srcH);
    gl.uniform2f(P.u('uOriSize'), W, H);
    gl.uniform4f(P.u('uCrop'), crop.x, crop.y, crop.w, crop.h);
    gl.uniform4f(P.u('uView'), view[0], view[1], view[2], view[3]);
    gl.uniform1i(P.u('uRot'), ((e.rotate % 4) + 4) % 4);
    gl.uniform1f(P.u('uFlip'), e.flip ? 1 : 0);
    gl.uniform1f(P.u('uAngle'), (e.straighten * Math.PI) / 180);
    gl.uniform1f(P.u('uScale'), autoScale(e.straighten, W, H));
    gl.uniform1f(P.u('uCropAspect'), (crop.w * W) / (crop.h * H));
    gl.uniform1f(P.u('uOriginal'), o.original ? 1 : 0);

    gl.uniform1f(P.u('uExposure'), e.exposure);
    gl.uniform1f(P.u('uContrast'), e.contrast);
    gl.uniform1f(P.u('uHighlights'), e.highlights);
    gl.uniform1f(P.u('uShadows'), e.shadows);
    gl.uniform1f(P.u('uClarity'), e.clarity);
    gl.uniform1f(P.u('uSharpen'), e.sharpen);
    gl.uniform1f(P.u('uSat'), e.saturation);
    gl.uniform1f(P.u('uTemp'), e.temperature);
    gl.uniform1f(P.u('uTint'), e.tint);
    gl.uniform1f(P.u('uSkin'), e.skin);
    gl.uniform1f(P.u('uFade'), e.fade);
    gl.uniform1f(P.u('uVignette'), e.vignette);
    gl.uniform1f(P.u('uGrain'), e.grain);
    gl.uniform1f(P.u('uGrainSize'), e.grainSize);
    gl.uniform4f(P.u('uSplit'), e.splitShadowHue, e.splitShadow, e.splitHighlightHue, e.splitHighlight);
    gl.uniform3fv(P.u('uHsl'), new Float32Array(e.hsl));

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    const gl = this.gl;
    if (this.src) gl.deleteTexture(this.src);
    for (const t of this.targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    for (const t of this.lutTex.values()) gl.deleteTexture(t);
    this.lutTex.clear();
    this.src = null;
  }
}
