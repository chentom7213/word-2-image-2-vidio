import { describe, expect, it } from 'vitest';
import { PROVIDER_JOB_ID_MAX_LENGTH, providerJobIdProblem, recordedJobId, successJobIdUpdate } from '../src/lib/provider-job-id.js';

const TOO_LONG = '上游任务编号最长 120 字';

describe('providerJobIdProblem', () => {
  it('超过', () => {
    expect(providerJobIdProblem('a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH + 1))).toBe(TOO_LONG);
    expect(providerJobIdProblem(`${'a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH)} `)).toBe(TOO_LONG);
  });

  it('刚好', () => {
    expect(providerJobIdProblem('a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH))).toBeNull();
  });

  it('更短', () => {
    expect(providerJobIdProblem('a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH - 1))).toBeNull();
    expect(providerJobIdProblem('job-1')).toBeNull();
  });

  it('空字符串', () => {
    expect(providerJobIdProblem('')).toBeNull();
  });
});

describe('recordedJobId', () => {
  it('纯空白当成没有任务号，有内容的编号按原文保留', () => {
    expect(recordedJobId(null)).toBe('');
    expect(recordedJobId(undefined)).toBe('');
    expect(recordedJobId('')).toBe('');
    expect(recordedJobId('   ')).toBe('');
    expect(recordedJobId(' job-1 ')).toBe(' job-1 ');
  });
});

describe('successJobIdUpdate', () => {
  it('空串和刚好 120 原样返回', () => {
    expect(successJobIdUpdate('')).toBe('');
    const exact = ` ${'a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH - 1)}`;
    expect(exact).toHaveLength(PROVIDER_JOB_ID_MAX_LENGTH);
    expect(successJobIdUpdate(exact)).toBe(exact);
    expect(successJobIdUpdate('a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH))).toBe('a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH));
  });

  it('更短原样返回，不 trim', () => {
    expect(successJobIdUpdate('job-1')).toBe('job-1');
    expect(successJobIdUpdate(' job-1 ')).toBe(' job-1 ');
    expect(successJobIdUpdate('a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH - 1))).toBe(
      'a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH - 1),
    );
  });

  it('更长返回 undefined，不截断、不 trim', () => {
    const longer = 'a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH + 1);
    expect(successJobIdUpdate(longer)).toBeUndefined();
    expect(successJobIdUpdate(` ${'a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH)}`)).toBeUndefined();
    expect(successJobIdUpdate(`${'a'.repeat(PROVIDER_JOB_ID_MAX_LENGTH)} `)).toBeUndefined();
  });

  it('非字符串返回 undefined', () => {
    expect(successJobIdUpdate(null)).toBeUndefined();
    expect(successJobIdUpdate(undefined)).toBeUndefined();
    expect(successJobIdUpdate(120)).toBeUndefined();
    expect(successJobIdUpdate({ length: 1 })).toBeUndefined();
  });
});
