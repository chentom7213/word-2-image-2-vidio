import { describe, expect, it } from 'vitest';
import { shouldOpenTaskStream, streamCooldownRemaining } from '../../src/lib/stream-retry.ts';

describe('task stream retry', () => {
  it('keeps a dropped stream on the poll until the cooldown ends', () => {
    const now = 1_000;
    expect(streamCooldownRemaining(now + 8_000, now)).toBe(8_000);
    expect(
      shouldOpenTaskStream({ terminal: false, open: false, cooldownUntil: now + 8_000, now }),
    ).toBe(false);
    expect(
      shouldOpenTaskStream({ terminal: false, open: false, cooldownUntil: now + 8_000, now: now + 8_000 }),
    ).toBe(true);
  });

  it('does not open a second socket or a finished task', () => {
    expect(shouldOpenTaskStream({ terminal: false, open: true, cooldownUntil: 0, now: 5 })).toBe(false);
    expect(shouldOpenTaskStream({ terminal: true, open: false, cooldownUntil: 0, now: 5 })).toBe(false);
    expect(streamCooldownRemaining(0, 5)).toBe(0);
  });
});
