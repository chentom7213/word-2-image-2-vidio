import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Raster, encodePng } from '../src/render/raster.js';
import {
  AigcLabelError,
  aigcMetadataJson,
  applyAigcLabel,
  buildAigcFfmpegArgs,
  readAigcMetadata,
} from '../src/services/aigc-label.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('ffmpeg must not be spawned in tests');
  }),
}));

const FREE = { models: 'standard', watermark: true, support: 'community' };
const PAID = { models: 'all', watermark: false, support: 'email' };

describe('AIGC label', () => {
  const dirs: string[] = [];

  afterEach(() => {
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('reads the AIGC label back from a legal PNG and keeps the image chunks', async () => {
    const dir = tempDir(dirs);
    const path = writeLegalPng(dir);
    const before = readFileSync(path);

    const result = await applyAigcLabel({
      path,
      mime: 'image/png',
      features: FREE,
      remote: true,
    });

    const after = readFileSync(path);
    const values = readAigcMetadata(after);
    expect(result.watermarked).toBe(1);
    expect(values).toEqual([aigcMetadataJson()]);
    expect(JSON.parse(values[0]!).Label).toBe('AI 生成');
    expect(countAigcChunks(after)).toBe(1);
    expect(chunkPayloads(after, 'IHDR')).toEqual(chunkPayloads(before, 'IHDR'));
    expect(chunkPayloads(after, 'IDAT')).toEqual(chunkPayloads(before, 'IDAT'));
    expect(after.subarray(0, 8)).toEqual(before.subarray(0, 8));
  });

  it('does not insert a second AIGC tEXt chunk', async () => {
    const dir = tempDir(dirs);
    const path = writeLegalPng(dir);

    await applyAigcLabel({ path, mime: 'image/png', features: FREE, remote: true });
    const once = readFileSync(path);
    const again = await applyAigcLabel({ path, mime: 'image/png', features: FREE, remote: false });

    expect(again.watermarked).toBe(1);
    expect(readFileSync(path)).toEqual(once);
    expect(countAigcChunks(readFileSync(path))).toBe(1);
    expect(readAigcMetadata(readFileSync(path))).toEqual([aigcMetadataJson()]);
  });

  it('does not modify a file when the paid plan does not require a watermark', async () => {
    const dir = tempDir(dirs);
    const png = writeLegalPng(dir, 'paid.png');
    const video = join(dir, 'paid.mp4');
    writeFileSync(video, Buffer.from('remote-video'));
    const pngBefore = readFileSync(png);
    const videoBefore = readFileSync(video);
    const runCommand = vi.fn();
    const writeFile = vi.fn();

    for (const remote of [true, false]) {
      const image = await applyAigcLabel({
        path: png,
        mime: 'image/png',
        features: PAID,
        remote,
        runCommand,
        writeFile,
      });
      const clip = await applyAigcLabel({
        path: video,
        mime: 'video/mp4',
        features: PAID,
        remote,
        runCommand,
        writeFile,
      });
      expect(image.watermarked).toBe(0);
      expect(clip.watermarked).toBe(0);
    }

    expect(readFileSync(png)).toEqual(pngBefore);
    expect(readFileSync(video)).toEqual(videoBefore);
    expect(runCommand).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(countAigcChunks(readFileSync(png))).toBe(0);
  });

  it('does not report a free-plan file as watermarked when labeling fails', async () => {
    const dir = tempDir(dirs);
    const png = writeLegalPng(dir, 'free.png');
    const pngBefore = readFileSync(png);
    const broken = join(dir, 'broken.png');
    writeFileSync(broken, Buffer.from('not-a-png'));
    const brokenBefore = readFileSync(broken);
    const video = join(dir, 'free.mp4');
    writeFileSync(video, Buffer.from('remote-mp4'));
    const videoBefore = readFileSync(video);
    const runCommand = vi.fn(async () => {
      throw new Error('ffmpeg write failed');
    });

    expect(await watermarkedOrUnset(applyAigcLabel({
      path: png,
      mime: 'image/png',
      features: FREE,
      remote: true,
      writeFile: () => {
        throw new Error('disk full');
      },
    }))).toBe(0);
    expect(readFileSync(png)).toEqual(pngBefore);

    expect(await watermarkedOrUnset(applyAigcLabel({
      path: broken,
      mime: 'image/png',
      features: FREE,
      remote: true,
    }))).toBe(0);
    expect(readFileSync(broken)).toEqual(brokenBefore);

    expect(await watermarkedOrUnset(applyAigcLabel({
      path: video,
      mime: 'video/mp4',
      features: FREE,
      remote: true,
      commandBuilder: () => {
        throw new Error('cannot build ffmpeg args');
      },
      runCommand,
    }))).toBe(0);
    expect(runCommand).not.toHaveBeenCalled();

    expect(await watermarkedOrUnset(applyAigcLabel({
      path: video,
      mime: 'video/mp4',
      features: FREE,
      remote: true,
      commandBuilder: buildAigcFfmpegArgs,
      runCommand,
    }))).toBe(0);
    expect(readFileSync(video)).toEqual(videoBefore);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('asks the injected command builder for comment metadata and does not spawn ffmpeg', async () => {
    const dir = tempDir(dirs);
    const video = join(dir, 'clip.mp4');
    writeFileSync(video, Buffer.from('original-video'));
    const comment = aigcMetadataJson();
    const runCommand = vi.fn(async (args: readonly string[]) => {
      const output = args[args.length - 1];
      if (!output) throw new Error('missing output');
      writeFileSync(output, Buffer.from('labeled-video'));
    });

    const result = await applyAigcLabel({
      path: video,
      mime: 'video/mp4',
      features: FREE,
      remote: true,
      commandBuilder: buildAigcFfmpegArgs,
      runCommand,
    });

    expect(result.watermarked).toBe(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    const args = runCommand.mock.calls[0]?.[0] ?? [];
    expect(args).toContain(`comment=${comment}`);
    expect(JSON.parse(comment).Label).toBe('AI 生成');
    expect(args).toContain('-c');
    expect(args).toContain('copy');
    expect(readFileSync(video).toString()).toBe('labeled-video');
  });
});

async function watermarkedOrUnset(pending: Promise<{ watermarked: 0 | 1 }>): Promise<number> {
  try {
    return (await pending).watermarked;
  } catch (err) {
    expect(err).toBeInstanceOf(AigcLabelError);
    return 0;
  }
}

function tempDir(dirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'aigc-label-'));
  dirs.push(dir);
  return dir;
}

function writeLegalPng(dir: string, name = 'frame.png'): string {
  const raster = new Raster(2, 2);
  raster.fill([12, 34, 56]);
  const path = join(dir, name);
  writeFileSync(path, encodePng(raster));
  return path;
}

function countAigcChunks(png: Buffer): number {
  const marker = Buffer.from('tEXtAIGC\0', 'latin1');
  let count = 0;
  let from = 0;
  while (from < png.length) {
    const idx = png.indexOf(marker, from);
    if (idx < 0) break;
    count += 1;
    from = idx + marker.length;
  }
  return count;
}

function chunkPayloads(png: Buffer, type: string): Buffer[] {
  const payloads: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const kind = png.subarray(offset + 4, offset + 8).toString('ascii');
    payloads.push(Buffer.from(png.subarray(offset + 8, offset + 8 + length)));
    if (kind !== type) payloads.pop();
    offset += 12 + length;
    if (kind === 'IEND') break;
  }
  return payloads;
}
