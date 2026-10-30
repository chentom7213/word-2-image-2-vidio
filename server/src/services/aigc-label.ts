import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { env } from '../env.js';

/** PNG tEXt keyword required by the implicit AIGC label. */
export const AIGC_KEYWORD = 'AIGC';

/** Visible / metadata label text. Built-in pixels already say "AI GENERATED". */
export const AIGC_LABEL = 'AI 生成';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class AigcLabelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AigcLabelError';
  }
}

export type AigcCommandBuilder = (inputPath: string, outputPath: string, comment: string) => readonly string[];

export type AigcCommandRunner = (args: readonly string[]) => Promise<void> | void;

export type ApplyAigcLabelInput = {
  path: string;
  mime: string;
  /** `plans.features.watermark`. Free is true, paid is false. */
  watermarkRequired?: boolean;
  /** Used when `watermarkRequired` is omitted. */
  features?: unknown;
  /**
   * Upstream provider output. When the plan does not require a watermark the
   * file bytes stay as stored. Built-in renders already paint "AI GENERATED";
   * this module never paints that text again.
   */
  remote?: boolean;
  commandBuilder?: AigcCommandBuilder;
  runCommand?: AigcCommandRunner;
  /** Test hook. Production writes the labeled PNG itself. */
  writeFile?: (path: string, data: Buffer) => void;
};

type PngChunk = { type: string; data: Buffer; raw: Buffer };

/**
 * JSON stored in the PNG `AIGC` tEXt chunk and in the video `comment` metadata.
 * `Label` is the explicit 「AI 生成」 mark.
 */
export function aigcMetadataJson(): string {
  return JSON.stringify({ Label: AIGC_LABEL });
}

/** True only when the plan catalogue says a watermark is required. */
export function planWatermarkRequired(features: unknown): boolean {
  const record = asRecord(features);
  return record.watermark === true;
}

/**
 * ffmpeg arguments that copy the streams and set `comment` to the AIGC JSON.
 * Tests inject this builder (or a replacement) and never spawn ffmpeg.
 */
export function buildAigcFfmpegArgs(inputPath: string, outputPath: string, comment: string): string[] {
  return ['-y', '-i', inputPath, '-c', 'copy', '-metadata', `comment=${comment}`, outputPath];
}

/** Every PNG tEXt value whose keyword is `AIGC`, in file order. */
export function readAigcMetadata(png: Buffer): string[] {
  return parsePng(png).flatMap((chunk) => {
    if (chunk.type !== 'tEXt') return [];
    const text = decodeText(chunk.data);
    return text?.keyword === AIGC_KEYWORD ? [text.value] : [];
  });
}

/**
 * Attach the implicit AIGC label, or leave the file alone.
 *
 * Returns `watermarked: 1` only after the file actually carries the label.
 * A plan that does not require a watermark returns `0` and does not rewrite
 * bytes. Construction or write failures throw, so the caller must not store
 * the unlabeled remote object as a success or mark it watermarked.
 */
export async function applyAigcLabel(input: ApplyAigcLabelInput): Promise<{ watermarked: 0 | 1 }> {
  const watermarkRequired =
    typeof input.watermarkRequired === 'boolean' ? input.watermarkRequired : planWatermarkRequired(input.features);

  if (!watermarkRequired) {
    // Remote provider bytes stay as delivered. Built-in frames already show
    // "AI GENERATED"; do not paint that text again. Neither case is watermarked.
    return { watermarked: 0 };
  }

  const comment = aigcMetadataJson();
  try {
    if (isPng(input.mime)) {
      writePngLabel(input.path, comment, input.writeFile);
    } else if (isVideo(input.mime)) {
      await writeVideoComment(input.path, comment, input.commandBuilder, input.runCommand);
    } else {
      throw new Error(`无法为 ${input.mime || '未知类型'} 写入 AIGC 标识`);
    }
  } catch (err) {
    throw asLabelError(err);
  }
  return { watermarked: 1 };
}

function writePngLabel(path: string, comment: string, writeFile?: ApplyAigcLabelInput['writeFile']): void {
  const original = readFileSync(path);
  const next = insertPngAigc(original, comment);
  if (next.equals(original)) return;
  replaceFile(path, next, writeFile);
}

function insertPngAigc(png: Buffer, comment: string): Buffer {
  const chunks = parsePng(png);
  if (chunks.some((chunk) => chunk.type === 'tEXt' && decodeText(chunk.data)?.keyword === AIGC_KEYWORD)) {
    return png;
  }
  const iend = chunks[chunks.length - 1];
  if (!iend || iend.type !== 'IEND') throw new Error('PNG 缺少 IEND');
  const body = Buffer.concat([Buffer.from(AIGC_KEYWORD, 'latin1'), Buffer.from([0]), Buffer.from(comment, 'utf8')]);
  const text = pngChunk('tEXt', body);
  const iendAt = png.length - iend.raw.length - trailingLength(png, chunks);
  return Buffer.concat([png.subarray(0, iendAt), text, png.subarray(iendAt)]);
}

async function writeVideoComment(
  path: string,
  comment: string,
  commandBuilder: AigcCommandBuilder | undefined,
  runCommand: AigcCommandRunner | undefined,
): Promise<void> {
  const outputPath = `${path}.aigc-tmp${extname(path) || '.mp4'}`;
  const build = commandBuilder ?? buildAigcFfmpegArgs;
  let args: readonly string[];
  try {
    args = build(path, outputPath, comment);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  if (!Array.isArray(args) || args.length === 0 || !args.includes(outputPath)) {
    throw new Error('ffmpeg 参数构造失败');
  }
  const run = runCommand ?? runFfmpeg;
  try {
    await run(args);
    if (!existsSync(outputPath) || statSync(outputPath).size < 1) {
      throw new Error('ffmpeg 未写出带标识的视频');
    }
    copyFileSync(outputPath, path);
  } finally {
    rmSync(outputPath, { force: true });
  }
}

function runFfmpeg(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(env.render.ffmpegPath, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg 写入 AIGC 标识超时'));
    }, env.render.timeoutMs);
    timer.unref?.();
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    proc.stderr.on('data', (chunk: Buffer) => {
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

function replaceFile(path: string, data: Buffer, writeFile?: ApplyAigcLabelInput['writeFile']): void {
  if (writeFile) {
    writeFile(path, data);
    return;
  }
  const tmp = `${path}.aigc-tmp`;
  const backup = `${path}.aigc-bak`;
  writeFileSync(tmp, data);
  copyFileSync(path, backup);
  try {
    copyFileSync(tmp, path);
  } catch (err) {
    try {
      copyFileSync(backup, path);
    } catch {
      // The original backup is still removed below; surface the first failure.
    }
    throw err;
  } finally {
    rmSync(tmp, { force: true });
    rmSync(backup, { force: true });
  }
}

function parsePng(png: Buffer): PngChunk[] {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是合法 PNG');
  }
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) throw new Error('PNG 块被截断');
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = Buffer.from(png.subarray(offset + 8, offset + 8 + length));
    const crc = png.readUInt32BE(offset + 8 + length);
    const expected = crc32(png.subarray(offset + 4, offset + 8 + length));
    if (crc !== expected) throw new Error(`PNG 块 ${type} CRC 错误`);
    const raw = Buffer.from(png.subarray(offset, offset + 12 + length));
    chunks.push({ type, data, raw });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR' || chunks[chunks.length - 1]?.type !== 'IEND') {
    throw new Error('不是合法 PNG');
  }
  return chunks;
}

function trailingLength(png: Buffer, chunks: PngChunk[]): number {
  const used = 8 + chunks.reduce((sum, chunk) => sum + chunk.raw.length, 0);
  return Math.max(0, png.length - used);
}

function decodeText(data: Buffer): { keyword: string; value: string } | null {
  const nul = data.indexOf(0);
  if (nul <= 0 || nul > 79) return null;
  return {
    keyword: data.subarray(0, nul).toString('latin1'),
    value: data.subarray(nul + 1).toString('utf8'),
  };
}

function pngChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])), 0);
  return Buffer.concat([length, typeBuf, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function asRecord(features: unknown): { watermark?: unknown } {
  if (typeof features === 'string') {
    try {
      return asRecord(JSON.parse(features));
    } catch {
      return {};
    }
  }
  if (!features || typeof features !== 'object' || Array.isArray(features)) return {};
  return features as { watermark?: unknown };
}

function isPng(mime: string): boolean {
  return mimeType(mime) === 'image/png';
}

function isVideo(mime: string): boolean {
  return mimeType(mime).startsWith('video/');
}

function mimeType(mime: string): string {
  return mime.split(';')[0]?.trim().toLowerCase() ?? '';
}

function asLabelError(err: unknown): AigcLabelError {
  if (err instanceof AigcLabelError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new AigcLabelError(`AIGC 标识写入失败：${detail}`.slice(0, 500), { cause: err });
}
