import type { Locale, MessageKey } from './i18n';

export const PROMPT_CATEGORIES = [
  'prompts_cat_all',
  'prompts_cat_cinematic',
  'prompts_cat_character',
  'prompts_cat_landscape',
  'prompts_cat_product',
  'prompts_cat_scifi',
  'prompts_cat_food',
  'prompts_cat_anime',
] as const satisfies readonly MessageKey[];

export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

export type PromptEntry = {
  cat: PromptCategory;
  text: Record<Locale, string>;
};

/** Prompt bodies stay outside the shared message catalog. Chinese text is the original library copy. */
export const PROMPT_ENTRIES: readonly PromptEntry[] = [
  {
    cat: 'prompts_cat_cinematic',
    text: {
      zh: '镜头缓缓推近，主体从虚焦到清晰，背景霓虹虚化，电影级浅景深，冷色调',
      en: 'Slow push-in. The subject shifts from soft focus to sharp, neon bokeh in the background, cinematic shallow depth of field, cool color grade.',
    },
  },
  {
    cat: 'prompts_cat_character',
    text: {
      zh: '少女站在雨中，发丝被风吹动，眼神坚定望向远方，逆光轮廓，体积光',
      en: 'A young woman stands in the rain, hair blowing in the wind, eyes fixed on the distance, rim-lit silhouette, volumetric light.',
    },
  },
  {
    cat: 'prompts_cat_product',
    text: {
      zh: '香水瓶在黑色大理石上缓慢旋转，水珠滑落，金色反光，微距镜头',
      en: 'A perfume bottle slowly rotates on black marble, droplets sliding down the glass, gold reflections, macro lens.',
    },
  },
  {
    cat: 'prompts_cat_landscape',
    text: {
      zh: '航拍镜头掠过雪山之巅，云雾翻涌，晨光洒落，延时摄影质感',
      en: 'An aerial shot skims a snowy summit, clouds rolling below, morning light spilling across, time-lapse texture.',
    },
  },
  {
    cat: 'prompts_cat_scifi',
    text: {
      zh: '未来城市天际线，飞行器穿梭，霓虹光轨，赛博朋克色调，镜头横移',
      en: 'A future city skyline, aircraft weaving between towers, neon light trails, cyberpunk color grade, lateral camera move.',
    },
  },
  {
    cat: 'prompts_cat_food',
    text: {
      zh: '热气腾腾的拉面特写，slow motion 汤汁飞溅，暖色调，柔光',
      en: 'Close-up of steaming ramen, broth splashing in slow motion, warm tones, soft light.',
    },
  },
  {
    cat: 'prompts_cat_anime',
    text: {
      zh: '日系动画风格，樱花纷飞的街道，少女回眸，柔和光斑，新海诚色调',
      en: 'Japanese animation style, cherry blossoms falling over a street, a girl looking back, soft bokeh, Makoto Shinkai color palette.',
    },
  },
  {
    cat: 'prompts_cat_cinematic',
    text: {
      zh: '环绕运镜 360° 展示主体，背景光斑快速流动，稳如云台，电影感',
      en: 'A 360° orbit around the subject, background bokeh streaking past, gimbal-steady, cinematic look.',
    },
  },
  {
    cat: 'prompts_cat_landscape',
    text: {
      zh: '海浪拍打礁石慢动作，水花飞溅，金色夕阳，长焦压缩空间',
      en: 'Slow motion of waves hitting the rocks, spray in the air, golden sunset, telephoto compression.',
    },
  },
  {
    cat: 'prompts_cat_character',
    text: {
      zh: '老人布满皱纹的手缓缓翻开旧相册，暖黄台灯，浅景深，温情氛围',
      en: 'Wrinkled hands slowly open an old photo album, warm yellow lamp, shallow depth of field, tender mood.',
    },
  },
  {
    cat: 'prompts_cat_product',
    text: {
      zh: '运动鞋悬浮旋转，环绕光扫过鞋面，深色渐变背景，高级质感',
      en: 'A sneaker floats and spins, a rim light sweeping the upper, dark gradient background, premium finish.',
    },
  },
  {
    cat: 'prompts_cat_scifi',
    text: {
      zh: '巨大的机械结构在黑暗中启动，蒸汽与火花四溅，金属反光，重工业美学',
      en: 'A huge mechanical structure powers on in the dark, steam and sparks bursting out, metallic reflections, heavy-industry aesthetic.',
    },
  },
];
