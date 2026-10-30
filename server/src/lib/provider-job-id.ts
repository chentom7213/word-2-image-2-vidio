export const PROVIDER_JOB_ID_MAX_LENGTH = 120;

export const PROVIDER_JOB_ID_TOO_LONG = '上游任务编号最长 120 字';

/** 按原文字符计，不 trim、不截断。超过上限才拒绝；空串、更短和刚好到上限都放行。 */
export function providerJobIdProblem(jobId: string): string | null {
  if (jobId.length > PROVIDER_JOB_ID_MAX_LENGTH) return PROVIDER_JOB_ID_TOO_LONG;
  return null;
}

/** 纯空白不算任务号。已经有内容的编号按原文保留，包括首尾空白。 */
export function recordedJobId(value: string | null | undefined): string {
  const raw = value ?? '';
  return raw.trim() ? raw : '';
}

/** 按原文字符计，不 trim、不截断。空串、更短和刚好 120 原样返回；更长或非字符串返回 undefined。 */
export function successJobIdUpdate(jobId: unknown): string | undefined {
  if (typeof jobId !== 'string' || jobId.length > PROVIDER_JOB_ID_MAX_LENGTH) return undefined;
  return jobId;
}
