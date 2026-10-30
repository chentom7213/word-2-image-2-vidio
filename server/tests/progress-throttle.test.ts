import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgressThrottle } from '../src/services/progress-throttle.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('progress throttle', () => {
  it('writes the first value and the latest value inside the window', async () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    const throttle = createProgressThrottle(async (pct) => {
      writes.push(pct);
    });
    await throttle.push(10);
    throttle.push(40);
    throttle.push(70);
    expect(writes).toEqual([10]);
    await vi.advanceTimersByTimeAsync(400);
    expect(writes).toEqual([10, 70]);
  });

  it('writes 95 and above immediately and drops the older pending value', async () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    const throttle = createProgressThrottle(async (pct) => {
      writes.push(pct);
    });
    await throttle.push(10);
    throttle.push(40);
    await throttle.push(96);
    await vi.advanceTimersByTimeAsync(400);
    expect(writes).toEqual([10, 96]);
  });

  it('flush stores the pending value and stop discards it', async () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    const throttle = createProgressThrottle(async (pct) => {
      writes.push(pct);
    });
    await throttle.push(10);
    throttle.push(40);
    await throttle.flush();
    expect(writes).toEqual([10, 40]);
    throttle.push(55);
    throttle.stop();
    await vi.advanceTimersByTimeAsync(400);
    expect(writes).toEqual([10, 40]);
  });
});
