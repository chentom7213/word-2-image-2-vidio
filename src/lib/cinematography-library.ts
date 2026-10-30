import type { Locale, MessageKey } from './i18n';

export type CineItem = {
  name: MessageKey;
  ratio: string;
  desc: Record<Locale, string>;
};

export type CineSection = {
  title: MessageKey;
  items: readonly CineItem[];
};

/** Shot descriptions stay beside the catalog. Names and section titles go through t(). */
export const CINE_SECTIONS: readonly CineSection[] = [
  {
    title: 'cine_section_size',
    items: [
      { name: 'cine_extreme_wide', ratio: '16:9', desc: { zh: '交代环境与气势', en: 'Sets the place and the scale' } },
      { name: 'cine_wide', ratio: '16:9', desc: { zh: '人物全身与背景', en: 'Full figure and the background' } },
      {
        name: 'cine_medium',
        ratio: '4:3',
        desc: { zh: '膝盖以上，叙事主力', en: 'Knees up, the main storytelling shot' },
      },
      {
        name: 'cine_medium_close',
        ratio: '1:1',
        desc: { zh: '胸部以上，强调表情', en: 'Chest up, emphasizing expression' },
      },
      { name: 'cine_closeup', ratio: '1:1', desc: { zh: '面部细节与情绪', en: 'Facial detail and emotion' } },
      { name: 'cine_macro', ratio: '1:1', desc: { zh: '极致细节，质感', en: 'Extreme detail and texture' } },
    ],
  },
  {
    title: 'cine_section_angle',
    items: [
      { name: 'cine_eye_level', ratio: '16:9', desc: { zh: '真实、平等', en: 'Natural and equal' } },
      { name: 'cine_high_angle', ratio: '16:9', desc: { zh: '压迫、全局', en: 'Pressure and a full view' } },
      { name: 'cine_low_angle', ratio: '9:16', desc: { zh: '高大、英雄感', en: 'Height and a heroic feel' } },
      { name: 'cine_birds_eye', ratio: '16:9', desc: { zh: '上帝视角', en: 'A view from above' } },
      { name: 'cine_over_shoulder', ratio: '16:9', desc: { zh: '对话关系', en: 'Shows who is talking to whom' } },
      { name: 'cine_dutch', ratio: '16:9', desc: { zh: '不安、失衡', en: 'Unease and imbalance' } },
    ],
  },
  {
    title: 'cine_section_move',
    items: [
      { name: 'cine_push', ratio: '16:9', desc: { zh: '接近主体，聚焦情绪', en: 'Move closer and focus the feeling' } },
      { name: 'cine_pull', ratio: '16:9', desc: { zh: '远离揭示环境', en: 'Pull away and reveal the setting' } },
      { name: 'cine_pan', ratio: '16:9', desc: { zh: '水平扫视', en: 'Sweep horizontally' } },
      { name: 'cine_truck', ratio: '16:9', desc: { zh: '跟随移动', en: 'Move along with the action' } },
      { name: 'cine_follow', ratio: '9:16', desc: { zh: '追踪主体', en: 'Track the subject' } },
      { name: 'cine_orbit', ratio: '1:1', desc: { zh: '360° 展示', en: 'A 360° reveal' } },
    ],
  },
];
