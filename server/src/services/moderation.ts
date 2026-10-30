import { readFile } from 'node:fs/promises';
import { env } from '../env.js';
import { ApiError } from '../lib/errors.js';

/**
 * Input moderation.
 *
 * Runs before any credits are deducted so a rejected prompt never costs the
 * user money. The blocklist is intentionally data-driven (env) — plugging in a
 * real classifier means implementing `classify` and keeping the same contract.
 */
export type ModerationVerdict = { ok: true } | { ok: false; reason: string; matched?: string };

const DEFAULT_BLOCKLIST = [
  '儿童色情',
  '未成年色情',
  '恐怖袭击',
  '制作炸弹',
  'csam',
  'child porn',
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/** Default entries that reject a prompt but do not suspend the account. */
const NON_SUSPENDING_DEFAULT_TERMS = ['恐怖袭击', '制作炸弹'];

/** The other four default entries. Env additions are never part of this list. */
const SEVERE_ACCOUNT_TERMS = DEFAULT_BLOCKLIST.filter(
  (word) => !NON_SUSPENDING_DEFAULT_TERMS.includes(word),
);

const REJECT_ONLY_ACCOUNT_TERMS = DEFAULT_BLOCKLIST.filter((word) =>
  NON_SUSPENDING_DEFAULT_TERMS.includes(word),
);

type MatchedSuspension = ((matched: string | null | undefined) => boolean) & {
  /** Severe default terms, in blocklist order. */
  terms: readonly string[];
  /** Default terms that only reject, in blocklist order. */
  rejectOnly: readonly string[];
};

function matchedSuspendsAccountImpl(matched: string | null | undefined): boolean {
  if (typeof matched !== 'string' || matched.length === 0) return false;
  const needle = normalize(matched);
  return SEVERE_ACCOUNT_TERMS.some((term) => normalize(term) === needle);
}

/**
 * Whether `moderatePrompt`'s `matched`, after the same normalize, is one of the
 * four severe default terms. Equality, not substring. Env words are not severe.
 */
export const matchedSuspendsAccount: MatchedSuspension = Object.assign(matchedSuspendsAccountImpl, {
  terms: SEVERE_ACCOUNT_TERMS,
  rejectOnly: REJECT_ONLY_ACCOUNT_TERMS,
});

/** Output text suspends only when it contains one of those same four terms. */
export function reasonSuspendsAccount(reason: string | null | undefined): boolean {
  if (typeof reason !== 'string' || reason.length === 0) return false;
  const haystack = normalize(reason);
  return SEVERE_ACCOUNT_TERMS.some((term) => {
    const needle = normalize(term);
    return needle.length > 0 && haystack.includes(needle);
  });
}

export function moderatePrompt(prompt: string): ModerationVerdict {
  if (!env.moderation.enabled) return { ok: true };
  const haystack = normalize(prompt);
  const words = [...DEFAULT_BLOCKLIST, ...env.moderation.blockedWords];
  for (const word of words) {
    const needle = normalize(word);
    if (needle && haystack.includes(needle)) {
      return { ok: false, reason: '提示词包含违规内容，请修改后重试', matched: word };
    }
  }
  if (prompt.trim().length === 0) {
    return { ok: false, reason: '提示词不能为空' };
  }
  return { ok: true };
}

/** Throws a 400 with a stable code so the UI can render a specific hint. */
export function assertPromptAllowed(prompt: string) {
  const verdict = moderatePrompt(prompt);
  if (!verdict.ok) throw new ApiError(400, verdict.reason, 'CONTENT_REJECTED');
}

/** Compliance audits keep a prefix of the prompt, never the whole over-long text. */
export const AUDIT_PROMPT_MAX_CHARS = 500;

export type ContentAuditStage = 'input' | 'output';

/**
 * Meta stored on `task.content_rejected`. Prompt text only — no classifier
 * tokens, signing secrets, or other credentials.
 */
export function contentRejectionAuditMeta(input: {
  stage: ContentAuditStage;
  prompt: string;
  reason?: string;
  unverified?: boolean;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    stage: input.stage,
    prompt: input.prompt.slice(0, AUDIT_PROMPT_MAX_CHARS),
  };
  if (input.reason !== undefined) meta.reason = input.reason;
  if (input.unverified !== undefined) meta.unverified = input.unverified;
  return meta;
}

/**
 * Audit payload when input moderation rejects, or null when the prompt may proceed.
 * Callers persist this before `assertPromptAllowed` throws. Nothing is charged.
 */
export function inputRejectionAudit(prompt: string): {
  action: 'task.content_rejected';
  meta: Record<string, unknown>;
} | null {
  const verdict = moderatePrompt(prompt);
  if (verdict.ok) return null;
  return {
    action: 'task.content_rejected',
    meta: contentRejectionAuditMeta({
      stage: 'input',
      prompt,
      reason: verdict.reason,
    }),
  };
}

// ── Output moderation ────────────────────────────────────────────────────

/**
 * A pluggable image/video classifier.
 *
 * The platform must never ship AI output to a CDN before it has been screened.
 * We cannot bundle a NSFW model in this repo, so the seam is explicit:
 *
 *   - Configure `MODERATION_OUTPUT_URL` to an internal classifier service that
 *     accepts `POST { image: base64 }` and answers `{ flagged, reason }`.
 *   - Without it, the local renderer (which cannot produce disallowed content)
 *     is trusted; a **remote** provider without a configured classifier fails
 *     closed, because shipping unfiltered vendor output is a compliance breach.
 */
export type OutputClassifier = (bytes: Buffer, mime: string) => Promise<{ flagged: boolean; reason?: string }>;

let classifier: OutputClassifier | null = null;
let classifierChecked = false;

export function registerOutputClassifier(fn: OutputClassifier) {
  classifier = fn;
}

/** Whether output moderation is actually enforced (surfaced on /api/health). */
export function outputModerationActive(): boolean {
  return env.moderation.enabled && (classifier !== null || Boolean(env.moderation.outputUrl));
}

async function httpClassifier(bytes: Buffer, mime: string): Promise<{ flagged: boolean; reason?: string }> {
  const url = env.moderation.outputUrl!;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.moderation.outputToken ? { Authorization: `Bearer ${env.moderation.outputToken}` } : {}),
    },
    body: JSON.stringify({ image: bytes.toString('base64'), mime }),
    signal: AbortSignal.timeout(env.moderation.outputTimeoutMs),
  });
  if (!res.ok) throw new Error(`classifier HTTP ${res.status}`);
  const data = (await res.json()) as { flagged?: boolean; reason?: string };
  return { flagged: Boolean(data.flagged), reason: data.reason };
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/**
 * Screens generated artifacts before they are persisted or signed.
 *
 * Return value is deliberately explicit so the caller can distinguish
 * "clean" from "could not verify" — the latter must not silently pass.
 */
export async function moderateOutputs(
  paths: string[],
  opts: { remoteProvider: boolean } = { remoteProvider: false },
): Promise<{ ok: boolean; reason?: string; unverified?: boolean }> {
  if (!env.moderation.enabled) return { ok: true };

  const fn = classifier ?? (env.moderation.outputUrl ? httpClassifier : null);

  if (!fn) {
    if (opts.remoteProvider) {
      // Fail closed: an external vendor's output we cannot screen must not ship.
      return {
        ok: false,
        unverified: true,
        reason: '输出内容审核服务未配置，暂不接受外部模型产物（请联系管理员配置 MODERATION_OUTPUT_URL）',
      };
    }
    // Local renderer is deterministic and cannot emit disallowed content.
    return { ok: true };
  }

  for (const path of paths) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      return { ok: false, reason: '产物读取失败，无法完成内容审核' };
    }
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

    try {
      const verdict = await fn(bytes, mime);
      if (verdict.flagged) {
        return { ok: false, reason: verdict.reason ?? '输出内容未通过审核' };
      }
    } catch (err) {
      // Screening errors fail closed — an unverified artifact is not a safe one.
      return {
        ok: false,
        unverified: true,
        reason: `内容审核失败：${(err as Error).message}`,
      };
    }
  }

  return { ok: true };
}

/** One-time startup log so operators know whether the red line is armed. */
export function reportModerationStatus(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {
  if (classifierChecked) return;
  classifierChecked = true;
  if (!env.moderation.enabled) {
    log.warn({}, '⚠️ 内容审核已通过 MODERATION_ENABLED=false 关闭（仅允许在非生产环境）');
    return;
  }
  const active = outputModerationActive();
  if (active) {
    log.info(
      { classifier: classifier ? 'custom' : env.moderation.outputUrl },
      '✔ 输出内容审核已启用',
    );
  } else {
    log.warn(
      {},
      '⚠️ 输出内容审核未配置：仅本地渲染器可用；接入真实模型前必须设置 MODERATION_OUTPUT_URL',
    );
  }
}
