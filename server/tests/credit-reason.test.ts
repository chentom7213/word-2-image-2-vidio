import { describe, expect, it } from 'vitest';
import { CREDIT_REASON_MAX_LENGTH, creditReason } from '../src/lib/credit-reason.js';

describe('creditReason', () => {
  it('短名称保持原句', () => {
    expect(creditReason('生成任务扣费 · ', 'Seedance 2.0')).toBe('生成任务扣费 · Seedance 2.0');
    expect(creditReason('重试扣费 · ', '万相')).toBe('重试扣费 · 万相');
    expect(creditReason('生成失败退款 · ', 'MiniMax')).toBe('生成失败退款 · MiniMax');
  });

  it('超长名称保留前缀并收进 120 字', () => {
    const name = '模'.repeat(120);
    for (const label of ['生成任务扣费 · ', '重试扣费 · ', '生成失败退款 · ']) {
      const reason = creditReason(label, name);
      expect(reason.startsWith(label)).toBe(true);
      expect(reason).toHaveLength(CREDIT_REASON_MAX_LENGTH);
    }
  });
});
