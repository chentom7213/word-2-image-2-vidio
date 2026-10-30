// @ts-expect-error vitest runs this file and is not an application dependency.
import { describe, expect, it } from 'vitest';
import { promptWithSkill } from './prompt-skill.ts';

describe('promptWithSkill', () => {
  it('returns the trimmed prompt for none', () => {
    expect(promptWithSkill('  a street  ', 'none', 'en')).toBe('a street');
  });

  it('returns the trimmed prompt for an empty skill', () => {
    expect(promptWithSkill('  a street  ', '', 'zh')).toBe('a street');
  });

  it('returns the trimmed prompt for an unknown skill', () => {
    expect(promptWithSkill('  a street  ', 'watercolor', 'zh')).toBe('a street');
  });

  it('appends the Chinese cinematic suffix', () => {
    expect(promptWithSkill('  街景  ', 'cinematic', 'zh')).toBe('街景，电影级运镜，浅景深，镜头平滑');
  });

  it('appends the English anime suffix', () => {
    expect(promptWithSkill('a street', 'anime', 'en')).toBe(
      'a street, anime style, clean linework, bright color',
    );
  });

  it('does not append the same suffix twice', () => {
    const once = '街景，电影级运镜，浅景深，镜头平滑';
    expect(promptWithSkill(once, 'cinematic', 'zh')).toBe(once);
    expect(promptWithSkill(promptWithSkill('街景', 'cinematic', 'zh'), 'cinematic', 'zh')).toBe(once);
  });
});
