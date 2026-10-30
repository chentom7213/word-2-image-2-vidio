export type Model = {
  id: string;
  name: string;
  price: string;
  tag?: string;
  /** supports reference image / video / audio */
  refs?: ('image' | 'video' | 'audio')[];
  durations?: number[];
  defaultDuration?: number;
};

/**
 * Offline fallback catalogue.
 *
 * The live list comes from `GET /api/models` (see `src/lib/useModels.ts`) so
 * prices and capabilities stay server-authoritative. These entries only cover
 * the first paint and the "backend unreachable" case.
 */
export const VIDEO_MODELS: Model[] = [
  {
    id: 'seedance-2',
    name: 'Seedance 2.0',
    price: '55积分/秒起',
    refs: ['image'],
    durations: [3, 4, 5, 6, 8, 10, 12],
    defaultDuration: 6,
    tag: '热门',
  },
  {
    id: 'seedance-mini',
    name: 'Seedance Mini',
    price: '28积分/秒起',
    refs: ['image'],
    durations: [3, 4, 5, 6, 8, 10],
    defaultDuration: 6,
  },
  {
    id: 'seedance-fast',
    name: 'Seedance Fast',
    price: '44积分/秒起',
    refs: ['image'],
    durations: [3, 4, 5, 6, 8],
    defaultDuration: 6,
    tag: '快速',
  },
  {
    id: 'seedance-2-5',
    name: 'Seedance 2.5',
    price: '84积分/秒起',
    refs: ['image', 'video'],
    durations: [3, 4, 5, 6, 8, 10, 12],
    defaultDuration: 6,
    tag: '旗舰',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    price: '80积分/秒起',
    refs: ['image'],
    durations: [3, 5, 6, 8, 10],
    defaultDuration: 6,
  },
  {
    id: 'wanxiang',
    name: '万相',
    price: '43积分/秒起',
    refs: ['image'],
    durations: [3, 4, 5, 6, 8],
    defaultDuration: 5,
  },
  {
    id: 'omni-video',
    name: '全能视频模型',
    price: '100积分/次',
    refs: ['image', 'video', 'audio'],
    durations: [5, 6, 8, 10],
    defaultDuration: 5,
  },
];

export const IMAGE_MODELS: Model[] = [
  { id: 'nano-banana', name: 'Nano Banana', price: '30积分/次', refs: ['image'], tag: '热门' },
  { id: 'gpt-image', name: 'GPT-Image', price: '45积分/次', refs: ['image'] },
  { id: 'seedream-4', name: 'Seedream 4.0', price: '25积分/次', refs: ['image'] },
  { id: 'flux-kontext', name: 'FLUX.1 Kontext', price: '35积分/次', refs: ['image'] },
  { id: 'midjourney', name: 'Midjourney', price: '40积分/次' },
];

export const RESOLUTIONS = ['1080p', '720p', '480p'];

export const ASPECT_PRESETS = [
  { id: 'landscape', label: '横屏', w: 1280, h: 720 },
  { id: 'portrait', label: '竖屏', w: 720, h: 1280 },
  { id: 'square', label: '方形', w: 1024, h: 1024 },
  { id: 'wide', label: '宽屏', w: 1792, h: 1024 },
  { id: 'tall', label: '长图', w: 1024, h: 1792 },
] as const;
