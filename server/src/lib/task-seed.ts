export const TASK_SEED_MAX_LENGTH = 80;

/**
 * 种子列只有 80 字。调用方已给出种子时按原文截到 80。
 * 没给时沿用「模型编号-时间-任务编号」。整句超长时只截短模型编号，时间和任务编号留在末尾。
 */
export function generationSeed(options: {
  seed?: string | null;
  modelId: string;
  now: number;
  id: string;
}): string {
  if (options.seed) return options.seed.slice(0, TASK_SEED_MAX_LENGTH);
  const tail = `-${String(Math.trunc(options.now))}-${options.id}`;
  if (tail.length >= TASK_SEED_MAX_LENGTH) return tail.slice(-TASK_SEED_MAX_LENGTH);
  const prefix = options.modelId.slice(0, TASK_SEED_MAX_LENGTH - tail.length);
  return `${prefix}${tail}`;
}
