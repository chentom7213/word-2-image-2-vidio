import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  moderateOutputs,
  moderatePrompt,
  registerOutputClassifier,
} from '../src/services/moderation.js';

/**
 * Compliance tests. The point of these is not that the classifier is accurate —
 * it is that an *unverified* artifact can never be treated as a clean one.
 */

const dir = mkdtempSync(join(tmpdir(), 'moderation-test-'));
const png = join(dir, 'a.png');
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

describe('moderatePrompt', () => {
  it('allows an ordinary prompt', () => {
    expect(moderatePrompt('清晨的雪山，云海翻涌').ok).toBe(true);
  });

  it('rejects a blocklisted phrase regardless of spacing/case', () => {
    expect(moderatePrompt('如何 制作 炸弹').ok).toBe(false);
    expect(moderatePrompt('CHILD PORN').ok).toBe(false);
  });

  it('rejects an empty prompt', () => {
    expect(moderatePrompt('   ').ok).toBe(false);
  });
});

describe('moderateOutputs', () => {
  it('trusts the local renderer when no classifier is configured', async () => {
    const verdict = await moderateOutputs([png], { remoteProvider: false });
    expect(verdict.ok).toBe(true);
  });

  it('fails CLOSED for remote providers when no classifier is configured', async () => {
    const verdict = await moderateOutputs([png], { remoteProvider: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.unverified).toBe(true);
    expect(verdict.reason).toMatch(/审核服务未配置/);
  });

  it('rejects when the classifier flags the artifact', async () => {
    registerOutputClassifier(async () => ({ flagged: true, reason: 'NSFW' }));
    const verdict = await moderateOutputs([png], { remoteProvider: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('NSFW');
  });

  it('fails CLOSED when the classifier itself errors', async () => {
    registerOutputClassifier(async () => {
      throw new Error('classifier down');
    });
    const verdict = await moderateOutputs([png], { remoteProvider: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.unverified).toBe(true);
    expect(verdict.reason).toMatch(/内容审核失败/);
  });

  it('passes when the classifier clears the artifact', async () => {
    registerOutputClassifier(async () => ({ flagged: false }));
    const verdict = await moderateOutputs([png], { remoteProvider: true });
    expect(verdict.ok).toBe(true);
  });
});
