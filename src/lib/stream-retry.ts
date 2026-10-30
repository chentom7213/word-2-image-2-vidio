/** A dropped task stream stays on the list poll until this delay has passed. */
export function streamCooldownRemaining(until: number, now: number): number {
  return Math.max(0, until - now);
}

export function shouldOpenTaskStream(input: {
  terminal: boolean;
  open: boolean;
  cooldownUntil: number;
  now: number;
}): boolean {
  if (input.terminal || input.open) return false;
  return input.now >= input.cooldownUntil;
}
