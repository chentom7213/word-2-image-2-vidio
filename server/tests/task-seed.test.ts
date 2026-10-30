import { describe, expect, it } from 'vitest';
import { TASK_SEED_MAX_LENGTH, generationSeed } from '../src/lib/task-seed.js';

const NOW = 1_700_000_000_000;
const ID = '11111111-1111-4111-8111-111111111111';

describe('generationSeed', () => {
  it('短模型编号保持原来的整句', () => {
    expect(generationSeed({ seed: '', modelId: 'seedance-2', now: NOW, id: ID })).toBe(
      `seedance-2-${NOW}-${ID}`,
    );
  });

  it('超长模型编号只截短前缀，时间和任务编号留在末尾', () => {
    const modelId = 'm'.repeat(64);
    const seed = generationSeed({ modelId, now: NOW, id: ID });
    expect(seed).toHaveLength(TASK_SEED_MAX_LENGTH);
    expect(seed.endsWith(`-${NOW}-${ID}`)).toBe(true);
    expect(seed.startsWith('m')).toBe(true);
  });

  it('调用方给出的种子按原文截到 80', () => {
    expect(generationSeed({ seed: 's'.repeat(80), modelId: 'seedance-2', now: NOW, id: ID })).toBe('s'.repeat(80));
    expect(generationSeed({ seed: ` ${'s'.repeat(80)}`, modelId: 'seedance-2', now: NOW, id: ID })).toHaveLength(80);
  });
});
