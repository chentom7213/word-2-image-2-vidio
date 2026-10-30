import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../env.js';

/** Longest side of a sidebar thumbnail, in pixels. Smaller sources are not enlarged. */
export const THUMBNAIL_MAX_EDGE = 320;

export type ThumbnailScaleInput = {
  sourcePath: string;
  destPath: string;
  width: number;
  height: number;
};

/** Test hook. Production scales with ffmpeg and never requires the caller to install a fake. */
export type ThumbnailScaler = (input: ThumbnailScaleInput) => Promise<void>;

/**
 * Fit inside a square of `maxEdge` without enlarging.
 * Returns null when the source size is missing or not positive.
 */
export function fitThumbnailEdge(
  width: number | null | undefined,
  height: number | null | undefined,
  maxEdge = THUMBNAIL_MAX_EDGE,
): { width: number; height: number } | null {
  if (width == null || height == null) return null;
  const sourceWidth = Math.round(Number(width));
  const sourceHeight = Math.round(Number(height));
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return null;
  }
  if (Math.max(sourceWidth, sourceHeight) <= maxEdge) {
    return { width: sourceWidth, height: sourceHeight };
  }
  if (sourceWidth >= sourceHeight) {
    return {
      width: maxEdge,
      height: Math.min(maxEdge, Math.max(1, Math.round((sourceHeight * maxEdge) / sourceWidth))),
    };
  }
  return {
    width: Math.min(maxEdge, Math.max(1, Math.round((sourceWidth * maxEdge) / sourceHeight))),
    height: maxEdge,
  };
}

/** ffmpeg argv for a single JPEG frame. Unknown sizes use a decrease-only box so small inputs stay small. */
export function buildThumbnailFfmpegArgs(sourcePath: string, destPath: string, width: number, height: number): string[] {
  const scale =
    width > 0 && height > 0
      ? `scale=${width}:${height}`
      : `scale=${THUMBNAIL_MAX_EDGE}:${THUMBNAIL_MAX_EDGE}:force_original_aspect_ratio=decrease`;
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-frames:v', '1', '-vf', scale, '-q:v', '3', destPath];
}

/**
 * Write a JPEG thumbnail next to `sourcePath`. An already-aborted signal writes nothing.
 * The scaler is injected by tests; production uses ffmpeg. Failures throw and leave the source untouched.
 */
export async function createThumbnailFile(input: {
  sourcePath: string;
  width: number | null;
  height: number | null;
  signal?: AbortSignal;
  scale?: ThumbnailScaler;
}): Promise<{ path: string; width: number | null; height: number | null } | null> {
  if (input.signal?.aborted) return null;
  const fitted = fitThumbnailEdge(input.width, input.height);
  const destPath = join(tmpdir(), `thumb-${randomUUID()}.jpg`);
  const scale = input.scale ?? ((request: ThumbnailScaleInput) => scaleWithFfmpeg(request, input.signal));
  try {
    await scale({
      sourcePath: input.sourcePath,
      destPath,
      width: fitted?.width ?? 0,
      height: fitted?.height ?? 0,
    });
    if (input.signal?.aborted) {
      rmSync(destPath, { force: true });
      return null;
    }
    if (!existsSync(destPath) || statSync(destPath).size < 1) {
      rmSync(destPath, { force: true });
      throw new Error('ffmpeg 未写出缩略图');
    }
    return { path: destPath, width: fitted?.width ?? null, height: fitted?.height ?? null };
  } catch (err) {
    rmSync(destPath, { force: true });
    throw err;
  }
}

function scaleWithFfmpeg(input: ThumbnailScaleInput, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  const args = buildThumbnailFfmpegArgs(input.sourcePath, input.destPath, input.width, input.height);
  return new Promise((resolve, reject) => {
    const proc = spawn(env.render.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg 缩略图超时'));
    }, env.render.timeoutMs);
    timer.unref?.();

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      proc.kill('SIGKILL');
      finish(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });
    proc.on('error', (err) => finish(new Error(`无法启动 ffmpeg：${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-400) || '未知错误'}`));
    });
  });
}

function abortError(): Error {
  return new DOMException('缩略图已取消', 'AbortError');
}
