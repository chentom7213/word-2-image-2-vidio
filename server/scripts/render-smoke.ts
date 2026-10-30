/**
 * Renderer smoke test — verifies that the built-in provider produces real,
 * decodable artifacts (PNG stills + an H.264 MP4) without touching the DB.
 *
 *   npm run render:smoke
 */
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { renderImage, renderPoster, renderVideo } from '../src/render/media.js';

const OUT = resolve(process.cwd(), '.render-smoke');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertPng(path: string) {
  const buf = readFileSync(path);
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error(`不是合法 PNG: ${path}`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width < 16 || height < 16) throw new Error(`PNG 尺寸异常: ${width}x${height}`);
  return { bytes: buf.byteLength, width, height };
}

/** ffprobe confirms the mp4 is a real, seekable H.264 stream. */
function assertMp4(path: string) {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,nb_frames',
      '-show_entries',
      'format=duration,format_name',
      '-of',
      'default=noprint_wrappers=1',
      path,
    ],
    { encoding: 'utf8' },
  );
  const codec = /codec_name=(\w+)/.exec(out)?.[1];
  const duration = Number(/duration=([\d.]+)/.exec(out)?.[1] ?? 0);
  const frames = Number(/nb_frames=(\d+)/.exec(out)?.[1] ?? 0);
  if (codec !== 'h264') throw new Error(`意外的编码: ${codec}`);
  if (!(duration > 0.5)) throw new Error(`时长异常: ${duration}`);
  const bytes = readFileSync(path).byteLength;
  return { bytes, codec, duration, frames };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const started = Date.now();

  const images = await renderImage({
    prompt: '雪山日出，航拍镜头掠过山脊，晨雾翻涌，电影级浅景深',
    width: 1024,
    height: 576,
    duration: 0,
    count: 2,
    seed: 'smoke-image',
    fps: 12,
  });
  console.log(`✔ 图片渲染完成: ${images.length} 张 / ${Date.now() - started}ms`);
  images.forEach((f) => {
    const info = assertPng(f.path);
    console.log(`   ${f.path.split(/[\\/]/).pop()} ${info.width}x${info.height} ${(info.bytes / 1024).toFixed(1)}KB`);
  });

  const t2 = Date.now();
  const video = await renderVideo({
    prompt: '赛博朋克城市夜景，霓虹光轨，镜头缓慢横移',
    width: 640,
    height: 360,
    duration: 3,
    count: 1,
    seed: 'smoke-video',
    fps: 12,
    onProgress: (p) => {
      if (p % 30 === 0) process.stdout.write(`   进度 ${p}%\n`);
    },
  });
  const vinfo = assertMp4(video.path);
  console.log(
    `✔ 视频渲染完成: ${vinfo.width ?? ''} ${video.width}x${video.height} ${vinfo.duration.toFixed(2)}s ` +
      `${vinfo.frames}f ${(vinfo.bytes / 1024).toFixed(1)}KB / ${Date.now() - t2}ms`,
  );

  const poster = await renderPoster({
    prompt: '赛博朋克城市夜景',
    width: 640,
    height: 360,
    duration: 3,
    count: 1,
    seed: 'smoke-video',
    fps: 12,
  });
  const pinfo = assertPng(poster.path);
  console.log(`✔ 封面渲染完成: ${pinfo.width}x${pinfo.height} ${(pinfo.bytes / 1024).toFixed(1)}KB`);

  // Keep the artifacts for eyeballing, but never in version control.
  console.log(`\n产物保留在 ${OUT}`);
  const all = [...images, video, poster];
  if (process.argv.includes('--clean')) {
    all.forEach((f) => rmSync(f.path, { force: true }));
    console.log('已清理临时文件');
  }
  const exts = new Set(all.map((f) => extname(f.path)));
  if (exts.size < 2) throw new Error('渲染未产生多种产物类型');
  console.log('\n✅ 渲染器自检通过');
}

main().catch((err) => {
  console.error('❌ 渲染器自检失败:', err);
  process.exit(1);
});
