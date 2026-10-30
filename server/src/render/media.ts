import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { encodePng } from './raster.js';
import { buildScene, renderFrame, stampProvenance } from './scene.js';

export type RenderRequest = {
  prompt: string;
  width: number;
  height: number;
  duration: number;
  count: number;
  seed: string;
  fps: number;
  onProgress?: (pct: number) => void | Promise<void>;
  signal?: AbortSignal;
};

function abortError() {
  return new DOMException('渲染已取消', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

export type RenderOutputFile = {
  kind: 'image' | 'video' | 'poster';
  path: string;
  mime: string;
  width: number;
  height: number;
  duration: number;
  bytes: number;
};

/** Target pixel budget: keep frames cheap to rasterize no matter the request. */
function internalSize(width: number, height: number) {
  const w = Math.max(64, width || 1024);
  const h = Math.max(64, height || 576);
  const pixels = w * h;
  const cap = env.render.maxRenderPixels;
  const k = pixels > cap ? Math.sqrt(cap / pixels) : 1;
  // ffmpeg requires even dimensions for yuv420p.
  const rw = Math.max(64, Math.round((w * k) / 2) * 2);
  const rh = Math.max(64, Math.round((h * k) / 2) * 2);
  return { rw, rh };
}

function tempPath(ext: string) {
  const dir = join(tmpdir(), 'benchu-render');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.${ext}`);
}

export async function renderImage(req: RenderRequest): Promise<RenderOutputFile[]> {
  const { rw, rh } = internalSize(req.width, req.height);
  const out: RenderOutputFile[] = [];
  try {
    for (let i = 0; i < req.count; i++) {
      throwIfAborted(req.signal);
      const scene = buildScene(rw, rh, req.prompt, req.seed, i);
      const raster = renderFrame(scene, 0);
      stampProvenance(raster);
      const path = tempPath('png');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, encodePng(raster));
      out.push({
        kind: 'image',
        path,
        mime: 'image/png',
        width: rw,
        height: rh,
        duration: 0,
        bytes: statSync(path).size,
      });
      throwIfAborted(req.signal);
      await req.onProgress?.(Math.round(((i + 1) / req.count) * 90));
    }
    return out;
  } catch (err) {
    out.forEach((file) => rmSync(file.path, { force: true }));
    throw err;
  }
}

type FfmpegOpts = {
  inW: number;
  inH: number;
  outW: number;
  outH: number;
  fps: number;
  seconds: number;
  outPath: string;
};

export const buildFfmpegArgs = (o: FfmpegOpts) => [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'rawvideo',
  '-pix_fmt',
  'rgb24',
  '-s',
  `${o.inW}x${o.inH}`,
  '-r',
  String(o.fps),
  '-i',
  'pipe:0',
  '-an',
  '-vf',
  `scale=${o.outW}:${o.outH}:flags=bicubic,format=yuv420p`,
  '-c:v',
  'libx264',
  '-threads',
  String(env.render.ffmpegThreads),
  '-preset',
  'veryfast',
  '-crf',
  '23',
  '-movflags',
  '+faststart',
  '-t',
  String(o.seconds),
  '-y',
  o.outPath,
];

/**
 * Streams raw RGB frames into ffmpeg over stdin, so a 15s clip never has to
 * exist in memory as a whole. Resolves with the encoded mp4 path.
 */
export function renderVideo(req: RenderRequest): Promise<RenderOutputFile> {
  const { rw, rh } = internalSize(req.width, req.height);
  const totalFrames = Math.max(1, Math.round(req.duration * req.fps));
  const outW = Math.max(64, Math.round((req.width || rw) / 2) * 2);
  const outH = Math.max(64, Math.round((req.height || rh) / 2) * 2);
  const outPath = tempPath('mp4');
  mkdirSync(dirname(outPath), { recursive: true });

  const args = buildFfmpegArgs({
    inW: rw,
    inH: rh,
    outW,
    outH,
    fps: req.fps,
    seconds: req.duration,
    outPath,
  });

  return new Promise((resolve, reject) => {
    if (req.signal?.aborted) {
      reject(abortError());
      return;
    }
    const proc = spawn(env.render.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let finished = false;

    const cleanup = () => {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      proc.stdin.destroy();
      proc.kill('SIGKILL');
      rmSync(outPath, { force: true });
      reject(abortError());
    };

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      req.signal?.removeEventListener('abort', onAbort);
      proc.kill('SIGKILL');
      rmSync(outPath, { force: true });
      reject(new Error(`渲染超时（>${Math.round(env.render.timeoutMs / 1000)}s）`));
    }, env.render.timeoutMs);
    req.signal?.addEventListener('abort', onAbort, { once: true });

    proc.stderr.on('data', (b) => {
      stderr += String(b);
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(`无法启动 ffmpeg：${err.message}`));
    });

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (code !== 0) {
        rmSync(outPath, { force: true });
        reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-400) || '未知错误'}`));
        return;
      }
      try {
        resolve({
          kind: 'video',
          path: outPath,
          mime: 'video/mp4',
          width: outW,
          height: outH,
          duration: req.duration,
          bytes: statSync(outPath).size,
        });
      } catch (err) {
        reject(err);
      }
    });

    // Feed frames sequentially; honour backpressure so memory stays flat.
    (async () => {
      try {
        for (let i = 0; i < totalFrames; i++) {
          throwIfAborted(req.signal);
          if (proc.exitCode !== null) return;
          const t = i / req.fps;
          const scene = buildScene(rw, rh, req.prompt, req.seed);
          const raster = renderFrame(scene, t);
          const buf = Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength);
          if (!proc.stdin.write(buf)) {
            await new Promise<void>((resolveDrain, rejectDrain) => {
              const onDrain = () => {
                req.signal?.removeEventListener('abort', onDrainAbort);
                resolveDrain();
              };
              const onDrainAbort = () => {
                proc.stdin.removeListener('drain', onDrain);
                rejectDrain(abortError());
              };
              proc.stdin.once('drain', onDrain);
              req.signal?.addEventListener('abort', onDrainAbort, { once: true });
            });
          }
          if (i % 4 === 0) {
            await req.onProgress?.(Math.min(92, Math.round(((i + 1) / totalFrames) * 92)));
          }
        }
        proc.stdin.end();
      } catch (err) {
        if (!finished) {
          finished = true;
          cleanup();
          proc.kill('SIGKILL');
          rmSync(outPath, { force: true });
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    })();
  });
}

/** First frame of a clip, upscaled to the output size, used as a video poster. */
export async function renderPoster(req: RenderRequest): Promise<RenderOutputFile> {
  throwIfAborted(req.signal);
  const outW = Math.max(64, Math.round((req.width || 1024) / 2) * 2);
  const outH = Math.max(64, Math.round((req.height || 576) / 2) * 2);
  const { rw, rh } = internalSize(outW, outH);
  const scene = buildScene(rw, rh, req.prompt, req.seed);
  const raster = renderFrame(scene, 0);
  stampProvenance(raster);
  const path = tempPath('png');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, encodePng(raster));
  if (req.signal?.aborted) {
    rmSync(path, { force: true });
    throw abortError();
  }
  return {
    kind: 'poster',
    path,
    mime: 'image/png',
    width: rw,
    height: rh,
    duration: 0,
    bytes: statSync(path).size,
  };
}
