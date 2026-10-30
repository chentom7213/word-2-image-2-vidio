const PUBLIC_MAX = 15;
const MIN_SECONDS = 2;

/** Guests stay at 15s. A known plan uses the tighter of the model and the plan, and never goes below 2s. */
export function videoDurationMax(modelMax: number | null | undefined, planMax: number | null | undefined): number {
  if (planMax == null) return PUBLIC_MAX;
  const modelCap = typeof modelMax === 'number' && modelMax > 0 ? modelMax : Number.POSITIVE_INFINITY;
  return Math.max(MIN_SECONDS, Math.min(modelCap, planMax));
}

/**
 * Slider cap for the video studio.
 * Guests keep the public 15s cap. A known plan uses the model and plan caps.
 * A signed-in user whose plan has not arrived yet stays at the current duration,
 * including when that duration is already above 15s. The floor is 2s.
 * Pass a frozen ceiling so dragging the slider down does not lower the cap.
 */
export function sliderDurationMax(input: {
  loggedIn: boolean;
  planKnown: boolean;
  modelMax: number | null | undefined;
  planMax: number | null | undefined;
  currentDuration: number;
}): number {
  if (!input.loggedIn) return videoDurationMax(input.modelMax, undefined);
  if (!input.planKnown) return Math.max(MIN_SECONDS, input.currentDuration);
  return videoDurationMax(input.modelMax, input.planMax);
}
