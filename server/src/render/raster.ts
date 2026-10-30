import zlib from 'node:zlib';

/**
 * Minimal software rasterizer producing packed RGB24 buffers.
 *
 * Frames are generated at a reduced internal resolution and upscaled by ffmpeg,
 * so the per-frame cost stays bounded regardless of the requested output size.
 * Everything is deterministic: the same seed always produces the same pixels.
 */

export type RGB = [number, number, number];

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function scale(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

export function hsl(h: number, s: number, l: number): RGB {
  const hh = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const to = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [to(hh + 1 / 3) * 255, to(hh) * 255, to(hh - 1 / 3) * 255];
}

/** Deterministic PRNG (mulberry32) so seeds reproduce exactly. */
export function rngFrom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Raster {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8ClampedArray;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 3);
  }

  fill(c: RGB) {
    const { data } = this;
    const r = clamp255(c[0]);
    const g = clamp255(c[1]);
    const b = clamp255(c[2]);
    for (let i = 0; i < data.length; i += 3) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }

  /** Vertical linear gradient between two colors. */
  verticalGradient(top: RGB, bottom: RGB) {
    const { data, w, h } = this;
    for (let y = 0; y < h; y++) {
      const t = h === 1 ? 0 : y / (h - 1);
      const r = clamp255(top[0] + (bottom[0] - top[0]) * t);
      const g = clamp255(top[1] + (bottom[1] - top[1]) * t);
      const b = clamp255(top[2] + (bottom[2] - top[2]) * t);
      let i = y * w * 3;
      for (let x = 0; x < w; x++) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        i += 3;
      }
    }
  }

  /** Additive radial glow, limited to its bounding box. */
  glow(cx: number, cy: number, radius: number, c: RGB, alpha: number) {
    if (radius <= 0 || alpha <= 0) return;
    const { data, w, h } = this;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(w - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(h - 1, Math.ceil(cy + radius));
    const inv = 1 / radius;
    for (let y = y0; y <= y1; y++) {
      const dy = (y - cy) * inv;
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) * inv;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        // smooth falloff, squared for a softer core
        const f = (1 - d2) * (1 - d2) * alpha;
        const i = (y * w + x) * 3;
        data[i] = clamp255(data[i] + c[0] * f);
        data[i + 1] = clamp255(data[i + 1] + c[1] * f);
        data[i + 2] = clamp255(data[i + 2] + c[2] * f);
      }
    }
  }

  /** Alpha-blended axis-aligned rectangle. */
  rect(x: number, y: number, w: number, h: number, c: RGB, alpha = 1) {
    const rx0 = Math.max(0, Math.round(x));
    const ry0 = Math.max(0, Math.round(y));
    const rx1 = Math.min(this.w, Math.round(x + w));
    const ry1 = Math.min(this.h, Math.round(y + h));
    if (rx1 <= rx0 || ry1 <= ry0 || alpha <= 0) return;
    const { data } = this;
    for (let py = ry0; py < ry1; py++) {
      let i = (py * this.w + rx0) * 3;
      for (let px = rx0; px < rx1; px++) {
        data[i] = clamp255(data[i] + (c[0] - data[i]) * alpha);
        data[i + 1] = clamp255(data[i + 1] + (c[1] - data[i + 1]) * alpha);
        data[i + 2] = clamp255(data[i + 2] + (c[2] - data[i + 2]) * alpha);
        i += 3;
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, alpha = 1) {
    if (rx <= 0 || ry <= 0 || alpha <= 0) return;
    const { data, w, h } = this;
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(h - 1, Math.ceil(cy + ry));
    const irx = 1 / rx;
    const iry = 1 / ry;
    for (let y = y0; y <= y1; y++) {
      const dy = (y - cy) * iry;
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) * irx;
        if (dx * dx + dy * dy > 1) continue;
        const i = (y * w + x) * 3;
        data[i] = clamp255(data[i] + (c[0] - data[i]) * alpha);
        data[i + 1] = clamp255(data[i + 1] + (c[1] - data[i + 1]) * alpha);
        data[i + 2] = clamp255(data[i + 2] + (c[2] - data[i + 2]) * alpha);
      }
    }
  }

  /** Scanline polygon fill (even-odd). Points are [x, y] pairs. */
  polygon(points: Array<[number, number]>, c: RGB, alpha = 1) {
    if (points.length < 3 || alpha <= 0) return;
    const { data, w, h } = this;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(h - 1, Math.ceil(maxY));
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      xs.length = 0;
      const sy = y + 0.5;
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        if (a[1] === b[1]) continue;
        if (sy < Math.min(a[1], b[1]) || sy >= Math.max(a[1], b[1])) continue;
        xs.push(a[0] + ((sy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const sx0 = Math.max(0, Math.round(xs[k]));
        const sx1 = Math.min(w, Math.round(xs[k + 1]));
        let i = (y * w + sx0) * 3;
        for (let x = sx0; x < sx1; x++) {
          data[i] = clamp255(data[i] + (c[0] - data[i]) * alpha);
          data[i + 1] = clamp255(data[i + 1] + (c[1] - data[i + 1]) * alpha);
          data[i + 2] = clamp255(data[i + 2] + (c[2] - data[i + 2]) * alpha);
          i += 3;
        }
      }
    }
  }

  /** Per-pixel post pass: vignette + film grain + subtle chromatic shift. */
  post(opts: { vignette: number; grain: number; seed: number; shift: number }) {
    const { data, w, h } = this;
    const rnd = rngFrom(opts.seed);
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.hypot(cx, cy);
    const grain = opts.grain;
    const shift = opts.shift;
    for (let y = 0; y < h; y++) {
      const dy = (y - cy) / maxR;
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / maxR;
        const i = (y * w + x) * 3;
        const d = Math.sqrt(dx * dx + dy * dy);
        const v = 1 - opts.vignette * d * d;
        const n = (rnd() - 0.5) * grain;
        if (shift > 0) {
          const sx = x - shift < 0 ? 0 : x - shift;
          const si = (y * w + sx) * 3;
          data[i] = clamp255(data[si] * v + n);
        } else {
          data[i] = clamp255(data[i] * v + n);
        }
        data[i + 1] = clamp255(data[i + 1] * v + n);
        data[i + 2] = clamp255(data[i + 2] * v + n);
      }
    }
  }

  /** Cheap 5x7 bitmap text (uppercase only) for the AI provenance watermark. */
  text(str: string, x: number, y: number, px: number, c: RGB, alpha = 0.85) {
    let cx = x;
    for (const ch of str.toUpperCase()) {
      const glyph = GLYPHS[ch];
      if (glyph) {
        for (let row = 0; row < 7; row++) {
          const bits = glyph[row];
          for (let col = 0; col < 5; col++) {
            if (bits & (1 << (4 - col))) {
              this.rect(cx + col * px, y + row * px, px, px, c, alpha);
            }
          }
        }
      }
      cx += 6 * px;
    }
  }
}

/** 5 bits per row, MSB = leftmost column. */
const GLYPHS: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
};

/** PNG encoder (RGB8, filter 0). Small enough to avoid a dependency. */
export function encodePng(raster: Raster): Buffer {
  const { w, h, data } = raster;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < w * 3; x++) raw[off + 1 + x] = data[y * w * 3 + x];
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const idat = zlib.deflateSync(raw, { level: 6 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

import zlibModule from 'node:zlib';

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])), 0);
  return Buffer.concat([len, typeBuf, body, crc]);
}
