export type PendingSubmit = { fingerprint: string; key: string };

export type GenerationSubmit = {
  type?: 'image' | 'video';
  prompt: string;
  modelId: string;
  resolution: string;
  width: number;
  height: number;
  duration: number;
  count?: number;
  visibility?: 'private' | 'org';
  refIds: string[];
};

/** Same form contents keep one key until that submission succeeds. */
export function generationFingerprint(input: GenerationSubmit): string {
  return JSON.stringify({
    type: input.type ?? 'video',
    prompt: input.prompt,
    modelId: input.modelId,
    resolution: input.resolution,
    width: input.width,
    height: input.height,
    duration: input.duration,
    count: input.count ?? 1,
    visibility: input.visibility ?? 'private',
    refIds: [...input.refIds].sort(),
  });
}

export function takeSubmitKey(
  pending: PendingSubmit | null,
  fingerprint: string,
  freshKey: string,
): { pending: PendingSubmit; key: string } {
  if (pending?.fingerprint === fingerprint) return { pending, key: pending.key };
  return { pending: { fingerprint, key: freshKey }, key: freshKey };
}

export function releaseSubmitKey(
  pending: PendingSubmit | null,
  fingerprint: string,
  key: string,
): PendingSubmit | null {
  if (pending?.fingerprint === fingerprint && pending.key === key) return null;
  return pending;
}
