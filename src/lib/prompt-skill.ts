import { optimizedPrompt } from './optimize-prompt';

const SKILL_SUFFIX: Record<string, Record<'zh' | 'en', string>> = {
  cinematic: {
    zh: '，电影级运镜，浅景深，镜头平滑',
    en: ', cinematic camera, shallow depth of field, smooth move',
  },
  anime: {
    zh: '，动漫风格，线条清晰，色彩明快',
    en: ', anime style, clean linework, bright color',
  },
  product: {
    zh: '，产品广告，主体突出，干净背景',
    en: ', product ad, subject forward, clean background',
  },
  vlog: {
    zh: '，生活纪实，手持镜头，自然光',
    en: ', lifestyle vlog, handheld camera, natural light',
  },
  retro: {
    zh: '，复古胶片，颗粒质感，暖色调',
    en: ', retro film, visible grain, warm tones',
  },
};

/** Trim the prompt, then append a known skill suffix once. */
export function promptWithSkill(prompt: string, skill: string, locale: 'zh' | 'en'): string {
  const trimmed = prompt.trim();
  const suffix = SKILL_SUFFIX[skill]?.[locale];
  if (!trimmed || !suffix) return trimmed;
  return optimizedPrompt(trimmed, suffix);
}
