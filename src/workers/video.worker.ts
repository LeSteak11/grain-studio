// Renders a trimmed clip with the full edit pipeline: demux -> decode -> GPU shader -> encode -> mux.
// Uses WebCodecs, so encoding is hardware accelerated and the output matches the editor exactly.
import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { Renderer } from '../gl/renderer';
import { outputDims } from '../lib/geometry';
import type { Lut } from '../lib/luts';
import type { EditState } from '../lib/types';

interface Job {
  id: number;
  bytes: ArrayBuffer;
  edit: EditState;
  lut: Lut | null;
  start: number;
  end: number;
  /** Cap on the long edge, 0 = source size. */
  maxEdge: number;
  /** 0..1, scales the bitrate. */
  quality: number;
  audio: { channels: Float32Array[]; sampleRate: number } | null;
  text: ImageBitmap | null;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sample {
  cts: number;
  duration: number;
  timescale: number;
  is_sync: boolean;
  data: Uint8Array;
}

/** Codec setup bytes (avcC/hvcC/...) that VideoDecoder needs. */
function descriptionOf(file: ReturnType<typeof createFile>, trackId: number): Uint8Array {
  const trak = (file as unknown as { getTrackById: (id: number) => any }).getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer.slice(8)); // drop the box header
    }
  }
  throw new Error('unsupported video codec in this file');
}

/** Display rotation from the track matrix, in 90° steps clockwise. */
function rotationSteps(track: any): number {
  const m = track?.matrix;
  if (!m) return 0;
  const a = m[0] / 65536;
  const b = m[1] / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return ((Math.round(deg / 90) % 4) + 4) % 4;
}

function demux(bytes: ArrayBuffer) {
  const file = createFile();
  let track: any = null;
  const samples: Sample[] = [];
  let error: string | null = null;
  (file as any).onError = (e: unknown) => {
    error = String(e);
  };
  (file as any).onReady = (info: any) => {
    track = info.videoTracks?.[0] ?? null;
    if (track) {
      (file as any).setExtractionOptions(track.id, null, { nbSamples: 1_000_000 });
      (file as any).start();
    }
  };
  (file as any).onSamples = (_id: number, _user: unknown, s: Sample[]) => {
    for (const x of s) samples.push(x);
  };
  (file as any).appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes, 0));
  (file as any).flush();
  if (error) throw new Error(error);
  if (!track) throw new Error('no video track found');
  return { track, samples, description: descriptionOf(file, track.id) };
}

async function run(job: Job) {
  const { track, samples, description } = demux(job.bytes);
  if (!samples.length) throw new Error('no frames found');

  const startUs = job.start * 1e6;
  const endUs = job.end * 1e6;
  const tsOf = (s: Sample) => (s.cts / s.timescale) * 1e6;

  // Start from the keyframe at or before the trim point.
  let from = 0;
  for (let i = 0; i < samples.length; i++) {
    const ts = tsOf(samples[i]);
    if (ts > startUs) break;
    if (samples[i].is_sync) from = i;
  }
  const expected = samples.filter((s) => tsOf(s) >= startUs - 1 && tsOf(s) < endUs).length || 1;

  const spin = rotationSteps(track);
  const edit: EditState = spin ? { ...job.edit, rotate: (job.edit.rotate + spin) % 4 } : job.edit;
  const fps = Math.max(1, Math.min(120, Math.round(1 / (samples[0].duration / samples[0].timescale || 1 / 30))));

  const r = new Renderer(new OffscreenCanvas(16, 16), true);
  // Held in one object: they're created lazily inside the decoder callback.
  const st: { muxer?: Muxer<ArrayBufferTarget>; encoder?: VideoEncoder; target?: ArrayBufferTarget } = {};
  let failure: Error | null = null;
  let encoded = 0;
  let lastProgress = 0;

  const setup = (codedW: number, codedH: number) => {
    const [ow, oh] = outputDims(edit, codedW, codedH);
    const k = job.maxEdge ? Math.min(1, job.maxEdge / Math.max(ow, oh)) : 1;
    const W = Math.max(2, Math.round((ow * k) / 2) * 2);
    const H = Math.max(2, Math.round((oh * k) / 2) * 2);
    r.resize(W, H);
    r.setTextLayer(job.text ?? null);
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: W, height: H, frameRate: fps },
      audio: job.audio ? { codec: 'aac', numberOfChannels: job.audio.channels.length, sampleRate: job.audio.sampleRate } : undefined,
      fastStart: 'in-memory',
      // Encoders emit decode timestamps that don't start exactly at zero (B-frames); let the muxer rebase them.
      firstTimestampBehavior: 'offset',
    });
    const bitrate = Math.round(Math.min(60e6, W * H * fps * (0.06 + 0.1 * job.quality)));
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
        } catch (e) {
          failure = e as Error;
        }
      },
      error: (e) => (failure = e as Error),
    });
    encoder.configure({ codec: 'avc1.640028', width: W, height: H, bitrate, framerate: fps, hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' } });
    st.muxer = muxer;
    st.encoder = encoder;
    st.target = target;
  };

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const ts = frame.timestamp;
        if (ts < startUs - 1 || ts >= endUs) return;
        if (!st.encoder) setup(frame.codedWidth, frame.codedHeight);
        r.updateFrame(frame);
        r.render(edit, job.lut);
        const out = new VideoFrame(r.canvas as OffscreenCanvas, {
          timestamp: Math.max(0, Math.round(ts - startUs)),
          duration: frame.duration ?? Math.round(1e6 / fps),
        });
        st.encoder!.encode(out, { keyFrame: encoded % (fps * 3) === 0 });
        out.close();
        encoded++;
        const pct = encoded / expected;
        if (pct - lastProgress > 0.02) {
          lastProgress = pct;
          ctx.postMessage({ id: job.id, progress: Math.min(0.99, pct) });
        }
      } catch (e) {
        failure = e as Error;
      } finally {
        frame.close();
      }
    },
    error: (e) => (failure = e as Error),
  });
  decoder.configure({ codec: track.codec, codedWidth: track.video?.width ?? track.track_width, codedHeight: track.video?.height ?? track.track_height, description });

  for (let i = from; i < samples.length; i++) {
    if (failure) throw failure;
    const s = samples[i];
    const ts = tsOf(s);
    if (ts >= endUs) break;
    decoder.decode(
      new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round(ts),
        duration: Math.round((s.duration / s.timescale) * 1e6),
        data: s.data,
      }),
    );
    while (decoder.decodeQueueSize > 8 || (st.encoder?.encodeQueueSize ?? 0) > 8) await sleep(4);
  }
  await decoder.flush();
  decoder.close();
  if (failure) throw failure;
  const { encoder, muxer, target } = st;
  if (!encoder || !muxer || !target) throw new Error('no frames in this range');
  await encoder.flush();
  encoder.close();

  // Audio: encode the trimmed PCM the main thread handed us.
  if (job.audio) {
    const { channels, sampleRate } = job.audio;
    const chCount = channels.length;
    const total = channels[0]?.length ?? 0;
    const aenc = new AudioEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addAudioChunk(chunk, meta);
        } catch (e) {
          failure = e as Error;
        }
      },
      error: (e) => (failure = e as Error),
    });
    aenc.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: chCount, bitrate: 160_000 });
    const N = 1024;
    for (let off = 0; off < total; off += N) {
      if (failure) break;
      const n = Math.min(N, total - off);
      const data = new Float32Array(n * chCount);
      for (let c = 0; c < chCount; c++) data.set(channels[c].subarray(off, off + n), c * n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: chCount, timestamp: Math.round((off / sampleRate) * 1e6), data });
      aenc.encode(ad);
      ad.close();
      if (aenc.encodeQueueSize > 24) await sleep(2);
    }
    await aenc.flush();
    aenc.close();
  }
  if (failure) throw failure;

  muxer.finalize();
  const buf = target.buffer;
  r.dispose();
  ctx.postMessage({ id: job.id, ok: true, buf, frames: encoded }, [buf]);
}

ctx.onmessage = (e) => {
  const job = e.data;
  run(job).catch((err) => ctx.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) }));
};
