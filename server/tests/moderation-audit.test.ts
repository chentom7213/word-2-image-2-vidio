import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import {
  assertPromptAllowed,
  contentRejectionAuditMeta,
  inputRejectionAudit,
} from '../src/services/moderation.js';

type AuditCall = { action: string; meta: Record<string, unknown> };

/** Same order as the generation route: persist a rejection, then throw. */
function screenInput(prompt: string, sink: AuditCall[]) {
  const rejected = inputRejectionAudit(prompt);
  if (rejected) sink.push({ action: rejected.action, meta: rejected.meta });
  assertPromptAllowed(prompt);
}

describe('content rejection audit', () => {
  it('records a truncated prompt and the verdict, then throws CONTENT_REJECTED', () => {
    const sink: AuditCall[] = [];
    const prompt = `制作炸弹${'详'.repeat(520)}不应入库的尾部`;

    let thrown: unknown;
    try {
      screenInput(prompt, sink);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).statusCode).toBe(400);
    expect((thrown as ApiError).code).toBe('CONTENT_REJECTED');
    expect((thrown as ApiError).message).toBe('提示词包含违规内容，请修改后重试');

    expect(sink).toHaveLength(1);
    expect(sink[0].action).toBe('task.content_rejected');
    expect(sink[0].meta.stage).toBe('input');
    expect(sink[0].meta.reason).toBe('提示词包含违规内容，请修改后重试');
    expect(sink[0].meta.prompt).toBe(prompt.slice(0, 500));
    expect(sink[0].meta.prompt).toHaveLength(500);
    expect(String(sink[0].meta.prompt).includes('不应入库的尾部')).toBe(false);
    expect(Object.keys(sink[0].meta).sort()).toEqual(['prompt', 'reason', 'stage']);
  });

  it('does not record a rejection audit when the prompt is allowed', () => {
    const sink: AuditCall[] = [];
    const prompt = `清晨的雪山，云海翻涌${'。'.repeat(600)}`;

    expect(() => screenInput(prompt, sink)).not.toThrow();
    expect(inputRejectionAudit(prompt)).toBeNull();
    expect(sink).toEqual([]);
  });

  it('keeps only 500 characters of an over-long prompt', () => {
    const prompt = `${'镜头缓慢推进'.repeat(90)}整段超长提示词不应入库`;
    const reason = '输出内容未通过审核';
    const meta = contentRejectionAuditMeta({
      stage: 'output',
      prompt,
      reason,
      unverified: true,
    });

    expect(prompt.length).toBeGreaterThan(500);
    expect(meta.stage).toBe('output');
    expect(meta.reason).toBe(reason);
    expect(meta.prompt).toBe(prompt.slice(0, 500));
    expect(meta.prompt).toHaveLength(500);
    expect(String(meta.prompt).includes('整段超长提示词不应入库')).toBe(false);
    expect(meta.unverified).toBe(true);
    expect(meta).not.toHaveProperty('outputToken');
    expect(meta).not.toHaveProperty('authorization');
  });
});
