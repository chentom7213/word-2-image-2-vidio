import { Raster, hsl, mix, rngFrom, hashString, type RGB } from './raster.js';

/**
 * Procedural scene synthesis.
 *
 * This is the "model" behind the built-in providers: the prompt is mapped to a
 * palette + composition, then animated deterministically from the seed. It keeps
 * the platform fully functional without upstream credentials while preserving the
 * exact same task lifecycle a real provider would drive (submit → poll → outputs).
 */

export type SceneStyle = {
  name: string;
  sky: [RGB, RGB];
  accent: RGB;
  fog: RGB;
  layers: number;
  aurora: boolean;
  particles: number;
};

const BASE_STYLES: Record<string, SceneStyle> = {
  cinematic: {
    name: '电影感',
    sky: [hsl(220, 0.45, 0.16), hsl(280, 0.35, 0.06)],
    accent: hsl(28, 0.85, 0.62),
    fog: hsl(240, 0.3, 0.2),
    layers: 4,
    aurora: true,
    particles: 40,
  },
  neon: {
    name: '赛博霓虹',
    sky: [hsl(262, 0.6, 0.14), hsl(200, 0.7, 0.05)],
    accent: hsl(320, 0.9, 0.62),
    fog: hsl(280, 0.6, 0.24),
    layers: 5,
    aurora: true,
    particles: 60,
  },
  nature: {
    name: '自然风光',
    sky: [hsl(200, 0.6, 0.5), hsl(38, 0.7, 0.82)],
    accent: hsl(18, 0.8, 0.6),
    fog: hsl(195, 0.35, 0.72),
    layers: 4,
    aurora: false,
    particles: 26,
  },
  night: {
    name: '静谧夜色',
    sky: [hsl(230, 0.6, 0.08), hsl(200, 0.5, 0.03)],
    accent: hsl(210, 0.6, 0.78),
    fog: hsl(225, 0.5, 0.14),
    layers: 4,
    aurora: false,
    particles: 90,
  },
  warm: {
    name: '暖调日常',
    sky: [hsl(24, 0.6, 0.3), hsl(340, 0.45, 0.16)],
    accent: hsl(40, 0.9, 0.66),
    fog: hsl(20, 0.5, 0.3),
    layers: 3,
    aurora: false,
    particles: 34,
  },
  retro: {
    name: '复古胶片',
    sky: [hsl(150, 0.2, 0.2), hsl(40, 0.35, 0.12)],
    accent: hsl(48, 0.55, 0.6),
    fog: hsl(120, 0.15, 0.24),
    layers: 3,
    aurora: false,
    particles: 46,
  },
  anime: {
    name: '动漫',
    sky: [hsl(212, 0.75, 0.66), hsl(48, 0.9, 0.86)],
    accent: hsl(345, 0.8, 0.7),
    fog: hsl(200, 0.6, 0.8),
    layers: 5,
    aurora: false,
    particles: 30,
  },
};

const STYLE_HINTS: Array<[RegExp, keyof typeof BASE_STYLES]> = [
  [/赛博|朋克|cyber|霓虹|neon|未来|futuristic|科技/i, 'neon'],
  [/雪山|山|海|森林|自然|landscape|mountain|ocean|forest|风光|航拍/i, 'nature'],
  [/夜|雨|月|星空|night|moon|star|暗/i, 'night'],
  [/复古|胶片|retro|film|老照片|怀旧/i, 'retro'],
  [/动漫|二次元|anime|漫画|插画/i, 'anime'],
  [/暖|厨房|咖啡|美食|日常|阳光|warm|coffee|food/i, 'warm'],
  [/电影|cinematic|镜头|浅景深|电影级/i, 'cinematic'],
];

export function styleForPrompt(prompt: string): SceneStyle {
  for (const [re, key] of STYLE_HINTS) {
    if (re.test(prompt)) return BASE_STYLES[key];
  }
  return BASE_STYLES.cinematic;
}

type Blob = { x: number; y: number; r: number; vx: number; vy: number; color: RGB; a: number };
type Layer = { points: Array<[number, number]>; color: RGB; drift: number };
type Particle = { x: number; y: number; r: number; vy: number; color: RGB; a: number };

export type Scene = {
  width: number;
  height: number;
  style: SceneStyle;
  sky: [RGB, RGB];
  sun: { x: number; y: number; r: number; color: RGB };
  blobs: Blob[];
  layers: Layer[];
  particles: Particle[];
  seed: number;
};

/** Builds a deterministic scene description for a seed + prompt. */
export function buildScene(width: number, height: number, prompt: string, seedStr: string, variant = 0): Scene {
  const seed = hashString(`${seedStr}#${variant}`);
  const rnd = rngFrom(seed);
  const style = styleForPrompt(prompt);

  // Rotate the palette slightly per-seed so two runs never look identical.
  const hueDrift = (rnd() - 0.5) * 26;
  const shift = (c: RGB): RGB =>
    mix(c, hsl(hueDrift + (rnd() - 0.5) * 40, 0.6, 0.5), 0.16 + rnd() * 0.12);

  const sky: [RGB, RGB] = [shift(style.sky[0]), shift(style.sky[1])];
  const accent = shift(style.accent);

  const blobs: Blob[] = Array.from({ length: 5 }, () => ({
    x: rnd(),
    y: rnd() * 0.75,
    r: 0.16 + rnd() * 0.3,
    vx: (rnd() - 0.5) * 0.02,
    vy: (rnd() - 0.5) * 0.008,
    color: mix(accent, hsl(rnd() * 360, 0.8, 0.6), 0.45),
    a: 0.22 + rnd() * 0.26,
  }));

  const layers: Layer[] = [];
  for (let i = 0; i < style.layers; i++) {
    const depth = i / Math.max(1, style.layers - 1);
    const baseY = height * (0.52 + depth * 0.16);
    const amp = height * (0.16 - depth * 0.09);
    const steps = 22;
    const points: Array<[number, number]> = [];
    const phase = rnd() * Math.PI * 2;
    const freq = 1.2 + rnd() * 2.4;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const y =
        baseY -
        Math.sin(t * Math.PI * freq + phase) * amp -
        Math.sin(t * Math.PI * freq * 2.7 + phase * 1.7) * amp * 0.35;
      points.push([t * width, y]);
    }
    points.push([width, height], [0, height]);
    layers.push({
      points,
      color: mix(style.sky[1], mix(style.fog, accent, 0.25), 0.35 + depth * 0.5),
      drift: (rnd() - 0.5) * 0.35,
    });
  }

  const particles: Particle[] = Array.from({ length: style.particles }, () => ({
    x: rnd() * width,
    y: rnd() * height,
    r: 0.6 + rnd() * 2.2,
    vy: 4 + rnd() * 18,
    color: mix(accent, [255, 255, 255], rnd() * 0.6),
    a: 0.18 + rnd() * 0.5,
  }));

  return {
    width,
    height,
    style,
    sky,
    sun: {
      x: (0.2 + rnd() * 0.6) * width,
      y: (0.14 + rnd() * 0.26) * height,
      r: Math.min(width, height) * (0.16 + rnd() * 0.14),
      color: mix(accent, [255, 244, 214], 0.5),
    },
    blobs,
    layers,
    particles,
    seed,
  };
}

/** Renders one frame. `t` is seconds into the clip; stills pass 0. */
export function renderFrame(scene: Scene, t: number): Raster {
  const { width, height } = scene;
  const r = new Raster(width, height);

  r.verticalGradient(scene.sky[0], scene.sky[1]);

  // Atmospheric light source.
  const sunPulse = 1 + Math.sin(t * 0.7) * 0.05;
  r.glow(scene.sun.x, scene.sun.y, scene.sun.r * sunPulse, scene.sun.color, 0.5);
  r.ellipse(scene.sun.x, scene.sun.y, scene.sun.r * 0.22, scene.sun.r * 0.22, scene.sun.color, 0.9);

  // Drifting volumetric blobs.
  for (const b of scene.blobs) {
    const cx = (b.x + b.vx * t) * width;
    const cy = (b.y + b.vy * t + Math.sin(t * 0.6 + b.x * 6) * 0.012) * height;
    r.glow(cx, cy, b.r * Math.min(width, height), b.color, b.a);
  }

  // Aurora ribbons (only for styles that ask for them).
  if (scene.style.aurora) {
    for (let i = 0; i < 3; i++) {
      const pts: Array<[number, number]> = [];
      const ph = i * 1.7;
      for (let s = 0; s <= 18; s++) {
        const x = (s / 18) * width;
        const y =
          height * (0.2 + i * 0.07) +
          Math.sin((s / 18) * Math.PI * 2 + t * 0.5 + ph) * height * 0.05;
        pts.push([x, y]);
      }
      for (let s = 18; s >= 0; s--) {
        const x = (s / 18) * width;
        const y =
          height * (0.34 + i * 0.07) +
          Math.sin((s / 18) * Math.PI * 2 + t * 0.5 + ph + 0.4) * height * 0.06;
        pts.push([x, y]);
      }
      r.polygon(pts, mix(scene.style.accent, scene.sky[0], 0.45), 0.09);
    }
  }

  // Silhouette layers, back to front.
  scene.layers.forEach((layer, idx) => {
    const drift = layer.drift * Math.sin(t * 0.25 + idx) * 6;
    const shifted = layer.points.map(([x, y]) => [x + drift, y] as [number, number]);
    r.polygon(shifted, layer.color, 0.85);
  });

  // Water band with a mirrored highlight for landscape styles.
  const waterTop = height * 0.72;
  r.rect(0, waterTop, width, height - waterTop, mix(scene.sky[1], scene.style.fog, 0.4), 0.55);
  for (let i = 0; i < 26; i++) {
    const yy = waterTop + ((i + 1) / 27) * (height - waterTop);
    const w = width * (0.08 + Math.abs(Math.sin(i * 1.7 + t * 0.9)) * 0.55);
    const x = scene.sun.x - w / 2 + Math.sin(t * 0.8 + i) * width * 0.03;
    r.rect(x, yy, w, Math.max(1, height * 0.004), scene.sun.color, 0.1 + (i % 3) * 0.04);
  }

  // Floating particles / bokeh.
  for (const p of scene.particles) {
    const y = ((p.y - p.vy * t) % height + height) % height;
    const x = p.x + Math.sin(t * 0.9 + p.y) * 5;
    r.ellipse(x, y, p.r, p.r, p.color, p.a);
  }

  // Subject anchor: a soft key light to keep focus centered.
  r.glow(width * 0.5, height * 0.58, Math.min(width, height) * 0.3, scene.style.accent, 0.12);

  r.post({
    vignette: 0.42,
    grain: 12,
    seed: scene.seed + Math.floor(t * 12),
    shift: 1,
  });

  stampProvenance(r);
  return r;
}

/** AI provenance watermark — required for generated-content compliance. */
export function stampProvenance(r: Raster, label = 'AI GENERATED') {
  const px = Math.max(1, Math.round(r.h / 130));
  const pad = px * 4;
  const textW = label.length * 6 * px;
  r.rect(pad - px * 2, r.h - pad - 7 * px - px * 2, textW + px * 4, 7 * px + px * 4, [0, 0, 0], 0.35);
  r.text(label, pad, r.h - pad - 7 * px, px, [255, 255, 255], 0.82);
}
