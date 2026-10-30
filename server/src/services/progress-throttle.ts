/** Coalesce progress writes so a burst becomes one row, keeping the latest value. */
export function createProgressThrottle(
  write: (pct: number) => Promise<void>,
  minGapMs = 400,
  immediateAt = 95,
) {
  let lastSent = 0;
  let pending: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  return {
    push(pct: number): Promise<void> | void {
      const now = Date.now();
      if (pct >= immediateAt || now - lastSent >= minGapMs) {
        clearTimer();
        pending = null;
        lastSent = now;
        return write(pct);
      }
      pending = pct;
      if (!timer) {
        const wait = Math.max(0, minGapMs - (now - lastSent));
        timer = setTimeout(() => {
          timer = null;
          const value = pending;
          pending = null;
          if (value == null) return;
          lastSent = Date.now();
          void write(value).catch(() => undefined);
        }, wait);
        timer.unref?.();
      }
    },
    async flush(): Promise<void> {
      clearTimer();
      const value = pending;
      pending = null;
      if (value == null) return;
      lastSent = Date.now();
      await write(value);
    },
    stop(): void {
      clearTimer();
      pending = null;
    },
  };
}
