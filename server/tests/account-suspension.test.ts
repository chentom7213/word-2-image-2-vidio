import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import bcrypt from 'bcryptjs';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { signToken } from '../src/lib/jwt.js';
import { hashKey } from '../src/services/apiKeys.js';
import { env } from '../src/env.js';
import {
  matchedSuspendsAccount,
  reasonSuspendsAccount,
  registerOutputClassifier,
} from '../src/services/moderation.js';
import { executeTask, suspendAccountForSevereContent } from '../src/services/pipeline.js';
import { registerProvider, resetProviders } from '../src/services/provider.js';
import { authRoutes } from '../src/routes/auth.js';
import { generationRoutes } from '../src/routes/generations.js';
import { hashToken, refreshCookieName } from '../src/services/sessions.js';
import {
  CLEAR_SUSPENDED_SQL,
  SELECT_SUSPENDED_USER_SQL,
  runUnsuspend,
  unsuspendAccount,
  type UnsuspendQuery,
} from '../src/scripts/unsuspend-account.js';

const API_KEY = 'bk_live_suspension_test';
const here = dirname(fileURLToPath(import.meta.url));

const fake = vi.hoisted(() => {
  process.env.QUEUE_ENABLED = 'false';
  const state = {
    users: [] as Array<Record<string, any>>,
    sessions: [] as Array<Record<string, any>>,
    audits: [] as Array<{ action: string; meta: Record<string, unknown> | null; userId: string | null }>,
    tasks: [] as Array<Record<string, any>>,
    ledger: [] as Array<Record<string, any>>,
    memberships: [] as Array<Record<string, any>>,
    models: [] as Array<Record<string, any>>,
    apiKeys: [] as Array<Record<string, any>>,
    sql: [] as string[],
    creditWrites: 0,
    taskInserts: 0,
    suspendedColumnMissing: false,
    tokensValidAfterColumnMissing: false,
  };

  function compact(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
  }

  function userById(id: string) {
    return state.users.find((user) => user.id === id);
  }

  function taskById(id: string) {
    return state.tasks.find((task) => task.id === id);
  }

  function apply(sql: string, params: readonly unknown[] = []): unknown {
    const text = compact(sql);
    const p = [...params];
    state.sql.push(text);

    if (text.startsWith('INSERT INTO audit_logs')) {
      state.audits.push({
        action: String(p[2]),
        userId: p[1] == null ? null : String(p[1]),
        meta: p[6] == null ? null : (JSON.parse(String(p[6])) as Record<string, unknown>),
      });
      return { affectedRows: 1 };
    }
    if (text.startsWith('SELECT deleted_at FROM users')) {
      const user = userById(String(p[0]));
      return user ? [{ deleted_at: user.deleted_at }] : [];
    }
    if (text.startsWith('SELECT suspended_at FROM users')) {
      if (state.suspendedColumnMissing) throw new Error("Unknown column 'suspended_at' in 'field list'");
      const user = userById(String(p[0]));
      return user ? [{ suspended_at: user.suspended_at }] : [];
    }
    if (text.startsWith('SELECT tokens_valid_after FROM users')) {
      if (state.tokensValidAfterColumnMissing) {
        throw new Error("Unknown column 'tokens_valid_after' in 'field list'");
      }
      const user = userById(String(p[0]));
      return user ? [{ tokens_valid_after: user.tokens_valid_after ?? null }] : [];
    }
    if (text.includes('password_hash') && text.includes('WHERE email = ?')) {
      const user = state.users.find((item) => item.email === p[0]);
      return user ? [{ ...user }] : [];
    }
    if (text.startsWith('SELECT') && text.includes('password_hash') && text.includes('WHERE id = ?')) {
      const user = userById(String(p[0]));
      return user ? [{ ...user }] : [];
    }
    if (text.includes('plan_id')) {
      const user = userById(String(p[0]));
      return user ? [{ plan_id: user.plan_id, plan_expires_at: user.plan_expires_at }] : [];
    }
    if (text.includes('SELECT credits FROM users')) {
      const user = userById(String(p[0]));
      return user ? [{ credits: user.credits }] : [];
    }
    if (text.startsWith('UPDATE users SET password_hash = ?')) {
      const user = userById(String(p[1]));
      if (!user) return { affectedRows: 0 };
      if (text.includes('AND password_set = 0') && Number(user.password_set) !== 0) return { affectedRows: 0 };
      user.password_hash = String(p[0]);
      if (text.includes('password_set = 1')) user.password_set = 1;
      return { affectedRows: 1 };
    }
    if (text.startsWith('UPDATE users SET tokens_valid_after = UTC_TIMESTAMP(3)')) {
      const user = userById(String(p[0]));
      if (!user) return { affectedRows: 0 };
      user.tokens_valid_after = new Date().toISOString().slice(0, 23).replace('T', ' ');
      return { affectedRows: 1 };
    }
    if (text.startsWith('UPDATE users SET suspended_at = ?')) {
      const user = userById(String(p[1]));
      if (!user || user.suspended_at != null) return { affectedRows: 0 };
      user.suspended_at = String(p[0]);
      return { affectedRows: 1 };
    }
    if (text.startsWith('UPDATE users SET credits')) {
      const user = userById(String(p[1]));
      if (!user) return { affectedRows: 0 };
      user.credits = Number(p[0]);
      state.creditWrites += 1;
      return { affectedRows: 1 };
    }
    if (text.includes('FROM memberships m')) {
      const row = state.memberships.find((item) => item.user_id === p[0]);
      return row ? [{ org_id: row.org_id }] : [];
    }
    if (text.includes('SELECT role FROM memberships')) {
      const row = state.memberships.find((item) => item.user_id === p[0] && item.org_id === p[1]);
      return row ? [{ role: row.role }] : [];
    }
    if (text.includes('COUNT(*)')) {
      const active = state.tasks.filter(
        (task) => task.user_id === p[0] && (task.status === 'queued' || task.status === 'running'),
      ).length;
      return [{ c: active }];
    }
    if (text.includes('FROM api_keys')) {
      const row = state.apiKeys.find((item) => item.key_hash === p[0]);
      return row ? [{ ...row }] : [];
    }
    if (text.includes('UPDATE api_keys SET last_used_at')) return { affectedRows: 1 };
    if (text.includes('FROM refresh_tokens WHERE token_hash = ?')) {
      const row = state.sessions.find((item) => item.token_hash === p[0]);
      return row ? [{ ...row }] : [];
    }
    if (text.includes('SET replaced_by = ?')) {
      const row = state.sessions.find((item) => item.id === p[1]);
      if (!row || row.replaced_by || row.revoked_at) return { affectedRows: 0 };
      row.replaced_by = String(p[0]);
      row.revoked_at = 'rotated';
      return { affectedRows: 1 };
    }
    if (text.startsWith('UPDATE refresh_tokens SET revoked_at = ?')) {
      let affected = 0;
      for (const session of state.sessions) {
        if (session.user_id === p[1] && !session.revoked_at) {
          session.revoked_at = String(p[0]);
          affected += 1;
        }
      }
      return { affectedRows: affected };
    }
    if (text.includes('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?')) {
      let affected = 0;
      for (const session of state.sessions) {
        if (session.user_id === p[0] && !session.revoked_at) {
          session.revoked_at = 'now';
          affected += 1;
        }
      }
      return { affectedRows: affected };
    }
    if (text.includes('INSERT INTO refresh_tokens')) {
      state.sessions.push({
        id: String(p[0]),
        user_id: String(p[1]),
        family_id: String(p[2]),
        token_hash: String(p[3]),
        expires_at: p[4] instanceof Date ? p[4].toISOString() : String(p[4]),
        revoked_at: null,
        replaced_by: null,
      });
      return { affectedRows: 1 };
    }
    if (text.includes('INSERT INTO credit_transactions')) {
      state.ledger.push({ user_id: String(p[1]), delta: Number(p[2]), reason: String(p[4]) });
      return { affectedRows: 1 };
    }
    if (text.includes('INSERT INTO generation_tasks')) {
      state.taskInserts += 1;
      return { affectedRows: 1 };
    }
    if (text.includes('SELECT status, error_code FROM generation_tasks')) {
      const task = taskById(String(p[0]));
      return task ? [{ status: task.status, error_code: task.error_code }] : [];
    }
    if (text.includes('SELECT refunded_at FROM generation_tasks')) {
      const task = taskById(String(p[0]));
      return task ? [{ refunded_at: task.refunded_at }] : [];
    }
    if (text.includes('SELECT status FROM generation_tasks')) {
      const task = taskById(String(p[0]));
      return task ? [{ status: task.status }] : [];
    }
    if (text.includes('SET status = \'failed\'')) {
      const task = taskById(String(p[p.length - 1]));
      if (!task || (task.status !== 'queued' && task.status !== 'running')) return { affectedRows: 0 };
      task.status = 'failed';
      task.error = String(p[0]);
      task.error_code = String(p[1]);
      return { affectedRows: 1 };
    }
    if (text.includes('SET refunded_at = NOW()')) {
      const task = taskById(String(p[0]));
      if (!task || task.refunded_at) return { affectedRows: 0 };
      task.refunded_at = '2026-10-26 00:00:00';
      return { affectedRows: 1 };
    }
    if (text.startsWith('SELECT * FROM generation_tasks WHERE id = ?')) {
      const task = taskById(String(p[0]));
      return task ? [{ ...task }] : [];
    }
    if (text.includes('ORDER BY created_at')) return [];
    if (text.includes('generation_refs') || text.includes('task_outputs')) return [];
    if (text.includes('FROM model_registry WHERE id = ?')) {
      const model = state.models.find((item) => item.id === p[0]);
      return model ? [{ ...model }] : [];
    }
    throw new Error(`unhandled sql: ${text}`);
  }

  function reset(passwordHash: string) {
    state.users = [
      {
        id: 'user-1',
        email: 'user@example.com',
        password_hash: passwordHash,
        display_name: 'User',
        credits: 1000,
        plan_id: null,
        plan_expires_at: null,
        deleted_at: null,
        suspended_at: null,
        tokens_valid_after: null,
        created_at: '2026-01-01 00:00:00',
      },
    ];
    state.sessions = [
      {
        id: 'sess-1',
        user_id: 'user-1',
        family_id: 'fam-1',
        token_hash: 'unset',
        expires_at: '2099-01-01T00:00:00.000Z',
        revoked_at: null,
        replaced_by: null,
      },
    ];
    state.memberships = [{ user_id: 'user-1', org_id: 'org-1', role: 'editor' }];
    state.models = [
      {
        id: 'remote-test-model',
        provider: 'remote-test',
        display_name: 'Remote',
        kind: 'image',
        price_unit: 'per_call',
        price_amount: 30,
        max_duration: null,
        resolutions: null,
        capabilities: null,
        provider_model: 'remote-test-model',
        enabled: 1,
        sort_weight: 0,
      },
    ];
    state.apiKeys = [
      {
        id: 'key-1',
        org_id: 'org-1',
        owner_id: 'user-1',
        name: 'key',
        key_prefix: 'bk_live_susp',
        key_hash: '',
        scopes: ['*'],
        rate_limit: 100,
        expires_at: null,
        revoked_at: null,
        last_used_at: null,
        created_at: '2026-01-01 00:00:00',
      },
    ];
    state.audits = [];
    state.tasks = [];
    state.ledger = [];
    state.sql = [];
    state.creditWrites = 0;
    state.taskInserts = 0;
    state.suspendedColumnMissing = false;
    state.tokensValidAfterColumnMissing = false;
  }

  return { state, apply, reset };
});

vi.mock('../src/db/pool.js', () => ({
  query: async (sql: string, params: unknown[] = []) => {
    const result = fake.apply(sql, params);
    return Array.isArray(result) ? result : [];
  },
  queryOne: async (sql: string, params: unknown[] = []) => {
    const result = fake.apply(sql, params);
    return Array.isArray(result) ? (result[0] ?? null) : null;
  },
  exec: async (sql: string, params: unknown[] = []) => {
    const result = fake.apply(sql, params);
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
    return { affectedRows: 0 };
  },
  withTransaction: async (fn: (conn: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
    const conn = {
      query: async (sql: string, params: unknown[] = []) => [fake.apply(sql, params), []],
    };
    return fn(conn);
  },
  pool: {
    getConnection: async () => {
      throw new Error('测试不应直接取连接');
    },
    end: async () => {},
    query: async () => [[]],
  },
}));

let passwordHash = '';
let outputFiles: Array<{
  kind: 'image';
  path: string;
  mime: string;
  width: number;
  height: number;
  duration: number;
  bytes: number;
}> = [];

beforeAll(async () => {
  passwordHash = await bcrypt.hash('secret', 4);
});

beforeEach(() => {
  fake.reset(passwordHash);
  fake.state.apiKeys[0].key_hash = hashKey(API_KEY);
  env.moderation.enabled = true;
  env.moderation.outputUrl = undefined;
  outputFiles = [];
  resetProviders();
  registerProvider({
    id: 'remote-test',
    remote: true,
    async run() {
      return { providerJobId: 'job-1', costActual: 0, outputs: outputFiles };
    },
  });
});

function bearer() {
  return { authorization: `Bearer ${signToken({ sub: 'user-1', email: 'user@example.com' })}` };
}

function installErrors(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: 'INTERNAL', message });
  });
}

async function withGeneration<T>(run: (app: FastifyInstance) => Promise<T>): Promise<T> {
  const app = Fastify({ logger: false });
  installErrors(app);
  await app.register(generationRoutes);
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

async function withAuth<T>(run: (app: FastifyInstance) => Promise<T>): Promise<T> {
  const app = Fastify({ logger: false });
  installErrors(app);
  await app.register(cookie, { secret: env.jwt.secret });
  await app.register(authRoutes);
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

async function postPrompt(prompt: string) {
  return withGeneration((app) =>
    app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: bearer(),
      payload: { type: 'image', prompt, modelId: 'remote-test-model' },
    }),
  );
}

function suspendAudits() {
  return fake.state.audits.filter((item) => item.action === 'auth.account_suspend');
}

function prepareOutput() {
  const dir = mkdtempSync(join(tmpdir(), 'acct-susp-'));
  const path = join(dir, 'a.png');
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  outputFiles = [{ kind: 'image', path, mime: 'image/png', width: 8, height: 8, duration: 0, bytes: 4 }];
  fake.state.tasks.push({
    id: 'task-1',
    user_id: 'user-1',
    org_id: null,
    visibility: 'private',
    type: 'image',
    prompt: 'a calm lake',
    model_id: 'remote-test-model',
    model_name: 'Remote',
    width: 64,
    height: 64,
    duration: 0,
    count: 1,
    status: 'running',
    seed: 'seed',
    credits_cost: 30,
    refunded_at: null,
    error_code: null,
  });
}

async function runOutput() {
  return executeTask('task-1', {
    isCancelled: async () => false,
    onProgress: async () => {},
    onHeartbeat: () => {},
  });
}

describe('严重词判断', () => {
  it('只把默认词表里的四条严重条目当成停用', () => {
    expect(matchedSuspendsAccount.terms).toHaveLength(4);
    expect(matchedSuspendsAccount.rejectOnly).toHaveLength(2);
    for (const term of matchedSuspendsAccount.terms) {
      expect(matchedSuspendsAccount(term)).toBe(true);
      expect(matchedSuspendsAccount(term.toUpperCase())).toBe(true);
      expect(matchedSuspendsAccount.rejectOnly).not.toContain(term);
    }
    for (const term of matchedSuspendsAccount.rejectOnly) {
      expect(matchedSuspendsAccount(term)).toBe(false);
      expect(reasonSuspendsAccount(term)).toBe(false);
    }
    const spaced = matchedSuspendsAccount.terms.find((term) => /\s/.test(term));
    expect(spaced).toBeTruthy();
    expect(reasonSuspendsAccount(`prefix ${spaced!.toUpperCase()} suffix`)).toBe(true);
    expect(matchedSuspendsAccount(`${matchedSuspendsAccount.terms[0]}更多`)).toBe(false);
    expect(matchedSuspendsAccount('env-only-block')).toBe(false);
  });
});

describe('输入拒绝', () => {
  it('严重命中会停用且不扣费不建任务', async () => {
    const spaced = matchedSuspendsAccount.terms.find((term) => /\s/.test(term))!;
    const response = await postPrompt(`prefix ${spaced.toUpperCase()} suffix`);
    const body = response.json();

    expect(response.statusCode).toBe(400);
    expect(body.error).toBe('CONTENT_REJECTED');
    expect(fake.state.users[0].credits).toBe(1000);
    expect(fake.state.creditWrites).toBe(0);
    expect(fake.state.ledger).toEqual([]);
    expect(fake.state.taskInserts).toBe(0);
    expect(fake.state.users[0].suspended_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(fake.state.sessions[0].revoked_at).toBe(fake.state.users[0].suspended_at);
    expect(fake.state.users[0].tokens_valid_after).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(suspendAudits()).toEqual([
      { action: 'auth.account_suspend', userId: 'user-1', meta: { stage: 'input', category: 'severe' } },
    ]);
    expect(JSON.stringify(suspendAudits()[0]?.meta)).not.toContain(spaced);
    expect(fake.state.sql.some((sql) => /DELETE\s+FROM\s+(users|credit_transactions|orders)\b/i.test(sql))).toBe(false);
    expect(fake.state.audits.some((item) => item.action === 'task.content_rejected')).toBe(true);
  });

  it('已有停用时间时再次严重命中不改时间', async () => {
    fake.state.users[0].suspended_at = '2024-02-03 04:05:06';
    await suspendAccountForSevereContent('user-1', 'output');

    expect(fake.state.users[0].suspended_at).toBe('2024-02-03 04:05:06');
    expect(fake.state.users[0].credits).toBe(1000);
    expect(fake.state.creditWrites).toBe(0);
    expect(fake.state.taskInserts).toBe(0);
    expect(fake.state.sessions[0].revoked_at).toBeTruthy();
    expect(suspendAudits()[0]?.meta).toEqual({ stage: 'output', category: 'severe' });
  });

  it('默认词表里只拒绝的条目不会停用也不会扣费', async () => {
    const rejectOnly = matchedSuspendsAccount.rejectOnly[matchedSuspendsAccount.rejectOnly.length - 1];
    const response = await postPrompt(rejectOnly);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('CONTENT_REJECTED');
    expect(fake.state.users[0].suspended_at).toBeNull();
    expect(fake.state.sessions[0].revoked_at).toBeNull();
    expect(fake.state.users[0].credits).toBe(1000);
    expect(fake.state.creditWrites).toBe(0);
    expect(fake.state.taskInserts).toBe(0);
    expect(suspendAudits()).toEqual([]);
    expect(fake.state.audits.some((item) => item.action === 'task.content_rejected')).toBe(true);
  });

  it('环境变量额外词只拒绝不停用', async () => {
    const extra = 'env-only-block';
    env.moderation.blockedWords.push(extra);
    try {
      const response = await postPrompt(extra);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('CONTENT_REJECTED');
      expect(fake.state.users[0].suspended_at).toBeNull();
      expect(fake.state.creditWrites).toBe(0);
      expect(fake.state.taskInserts).toBe(0);
      expect(suspendAudits()).toEqual([]);
    } finally {
      env.moderation.blockedWords.splice(env.moderation.blockedWords.indexOf(extra), 1);
    }
  });

  it('空提示词不会停用', async () => {
    const response = await postPrompt('   ');
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('提示词不能为空');
    expect(fake.state.users[0].suspended_at).toBeNull();
    expect(fake.state.creditWrites).toBe(0);
    expect(suspendAudits()).toEqual([]);
  });
});

describe('停用后的登录态', () => {
  it('已注销优先于停用，已停用的访问令牌不能继续用', async () => {
    fake.state.users[0].deleted_at = '2026-01-01 00:00:00';
    fake.state.users[0].suspended_at = '2026-02-01 00:00:00';
    const closed = await withGeneration((app) => app.inject({ method: 'GET', url: '/api/generations', headers: bearer() }));
    expect(closed.statusCode).toBe(401);
    expect(closed.json().message).toBe('账户已注销');

    fake.state.users[0].deleted_at = null;
    const suspended = await withGeneration((app) =>
      app.inject({ method: 'GET', url: '/api/generations', headers: bearer() }),
    );
    expect(suspended.statusCode).toBe(401);
    expect(suspended.json().message).toBe('账户已停用');
  });

  it('退出全部设备后，此前的访问令牌失效，API Key 仍可用', async () => {
    const headers = bearer();
    const loggedOut = await withAuth((app) =>
      app.inject({ method: 'POST', url: '/api/auth/logout-all', headers }),
    );
    expect(loggedOut.statusCode).toBe(200);
    expect(fake.state.users[0].tokens_valid_after).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

    const rejected = await withGeneration((app) =>
      app.inject({ method: 'GET', url: '/api/generations', headers }),
    );
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().message).toBe('登录已失效，请重新登录');

    const byKey = await withGeneration((app) =>
      app.inject({ method: 'GET', url: '/api/generations', headers: { 'x-api-key': API_KEY } }),
    );
    expect(byKey.statusCode).toBe(200);
  });

  it('进度流拒绝已截止、已停用和已注销的访问令牌', async () => {
    const token = signToken({ sub: 'user-1', email: 'user@example.com' });
    const stream = (app: FastifyInstance) =>
      app.inject({ method: 'GET', url: `/api/generations/missing/stream?token=${encodeURIComponent(token)}` });

    fake.state.users[0].tokens_valid_after = '2099-01-01 00:00:00.000';
    const revoked = await withGeneration(stream);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().message).toBe('登录已失效，请重新登录');

    fake.state.users[0].tokens_valid_after = null;
    fake.state.users[0].suspended_at = '2026-02-01 00:00:00';
    const suspended = await withGeneration(stream);
    expect(suspended.statusCode).toBe(401);
    expect(suspended.json().message).toBe('账户已停用');

    fake.state.users[0].suspended_at = null;
    fake.state.users[0].deleted_at = '2026-01-01 00:00:00';
    const closed = await withGeneration(stream);
    expect(closed.statusCode).toBe(401);
    expect(closed.json().message).toBe('账户已注销');
  });

  it('改密校验当前密码，成功后旧访问令牌失效，审计不记密码', async () => {
    const headers = bearer();
    const wrong = await withAuth((app) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers,
        payload: { currentPassword: 'nope', newPassword: 'another-secret' },
      }),
    );
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().message).toBe('密码错误');
    expect(fake.state.users[0].password_hash).toBe(passwordHash);
    expect(fake.state.users[0].tokens_valid_after).toBeNull();

    const same = await withAuth((app) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers,
        payload: { currentPassword: 'secret', newPassword: 'secret' },
      }),
    );
    expect(same.statusCode).toBe(400);
    expect(same.json().message).toBe('新密码不能与当前密码相同');

    const changed = await withAuth((app) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers,
        payload: { currentPassword: 'secret', newPassword: 'another-secret' },
      }),
    );
    expect(changed.statusCode).toBe(200);
    expect(await bcrypt.compare('another-secret', fake.state.users[0].password_hash)).toBe(true);
    expect(fake.state.sessions[0].revoked_at).toBeTruthy();
    expect(fake.state.users[0].tokens_valid_after).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    const recorded = JSON.stringify(fake.state.audits);
    expect(recorded).toContain('auth.password_change');
    expect(recorded).not.toContain('another-secret');
    expect(recorded).not.toContain('secret');

    const rejected = await withGeneration((app) =>
      app.inject({ method: 'GET', url: '/api/generations', headers }),
    );
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().message).toBe('登录已失效，请重新登录');
  });

  it('没有本地密码的企业账户可以只设置新密码，并作废旧会话', async () => {
    fake.state.users[0].password_set = 0;
    const headers = bearer();
    const created = await withAuth((app) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers,
        payload: { newPassword: 'chosen-secret' },
      }),
    );
    expect(created.statusCode).toBe(200);
    expect(fake.state.users[0].password_set).toBe(1);
    expect(await bcrypt.compare('chosen-secret', fake.state.users[0].password_hash)).toBe(true);
    const recorded = JSON.stringify(fake.state.audits);
    expect(recorded).toContain('"initial":true');
    expect(recorded).not.toContain('chosen-secret');
    expect(fake.state.users[0].tokens_valid_after).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('已有本地密码时不能省略当前密码', async () => {
    fake.state.users[0].password_set = 1;
    const skipped = await withAuth((app) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: bearer(),
        payload: { newPassword: 'another-secret' },
      }),
    );
    expect(skipped.statusCode).toBe(400);
    expect(skipped.json().message).toBe('请填写当前密码');
    expect(fake.state.users[0].password_hash).toBe(passwordHash);
  });

  it('访问令牌截止列还不存在时不锁死接口', async () => {
    fake.state.tokensValidAfterColumnMissing = true;
    fake.state.users[0].tokens_valid_after = '2099-01-01 00:00:00.000';
    const response = await withGeneration((app) =>
      app.inject({ method: 'GET', url: '/api/generations', headers: bearer() }),
    );
    expect(response.statusCode).toBe(200);
  });

  it('查不到停用列时不把访问接口锁死', async () => {
    fake.state.suspendedColumnMissing = true;
    fake.state.users[0].suspended_at = '2026-02-01 00:00:00';
    const response = await withGeneration((app) =>
      app.inject({ method: 'GET', url: '/api/generations', headers: bearer() }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it('已停用不能登录，已注销仍然先返回注销', async () => {
    fake.state.users[0].deleted_at = '2026-01-01 00:00:00';
    fake.state.users[0].suspended_at = '2026-02-01 00:00:00';
    const closed = await withAuth((app) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'user@example.com', password: 'secret' },
      }),
    );
    expect(closed.statusCode).toBe(401);
    expect(closed.json().message).toBe('账户已注销');

    fake.state.users[0].deleted_at = null;
    const suspended = await withAuth((app) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'user@example.com', password: 'secret' },
      }),
    );
    expect(suspended.statusCode).toBe(401);
    expect(suspended.json().message).toBe('账户已停用');
    expect(fake.state.sessions).toHaveLength(1);
    expect(fake.state.audits.some((item) => item.meta?.reason === 'ACCOUNT_SUSPENDED')).toBe(true);
  });

  it('停用列缺失时登录不被锁死', async () => {
    fake.state.suspendedColumnMissing = true;
    fake.state.users[0].suspended_at = '2026-02-01 00:00:00';
    const response = await withAuth((app) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'user@example.com', password: 'secret' },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().token).toEqual(expect.any(String));
  });

  it('已停用账号的 API Key 不能调用，注销仍然优先', async () => {
    fake.state.users[0].deleted_at = '2026-01-01 00:00:00';
    fake.state.users[0].suspended_at = '2026-02-01 00:00:00';
    const closed = await withGeneration((app) =>
      app.inject({ method: 'GET', url: '/api/generations', headers: { 'x-api-key': API_KEY } }),
    );
    expect(closed.json().message).toBe('账户已注销');

    fake.state.users[0].deleted_at = null;
    const suspended = await withGeneration((app) =>
      app.inject({ method: 'GET', url: '/api/generations', headers: { 'x-api-key': API_KEY } }),
    );
    expect(suspended.statusCode).toBe(401);
    expect(suspended.json().message).toBe('账户已停用');
  });

  it('没有生成 scope 的 API Key 不能列出任务', async () => {
    fake.state.apiKeys[0].scopes = ['assets:read'];
    const response = await withGeneration((app) =>
      app.inject({ method: 'GET', url: '/api/generations', headers: { 'x-api-key': API_KEY } }),
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe('API Key 缺少所需权限');
  });

  it('已停用账号不能刷新，已注销刷新仍然先返回注销', async () => {
    const raw = 'refresh-raw-token';
    fake.state.sessions[0].token_hash = hashToken(raw);
    fake.state.users[0].deleted_at = '2026-01-01 00:00:00';
    fake.state.users[0].suspended_at = '2026-02-01 00:00:00';
    const closed = await withAuth((app) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: `${refreshCookieName}=${raw}` },
      }),
    );
    expect(closed.statusCode).toBe(401);
    expect(closed.json().message).toBe('账户已注销');

    fake.reset(passwordHash);
    fake.state.sessions[0].token_hash = hashToken(raw);
    fake.state.users[0].suspended_at = '2026-02-01 00:00:00';
    const suspended = await withAuth((app) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: `${refreshCookieName}=${raw}` },
      }),
    );
    expect(suspended.statusCode).toBe(401);
    expect(suspended.json().message).toBe('账户已停用');
    expect(fake.state.sessions.every((session) => session.revoked_at)).toBe(true);
  });
});

describe('输出审核', () => {
  it('未验证的输出失败会退款但不停用', async () => {
    prepareOutput();
    const result = await runOutput();

    expect(result).toMatchObject({ ok: false, code: 'CONTENT_REJECTED' });
    expect(result.error).toContain('审核服务未配置');
    expect(fake.state.tasks[0].status).toBe('failed');
    expect(fake.state.users[0].credits).toBe(1030);
    expect(fake.state.users[0].suspended_at).toBeNull();
    expect(fake.state.sessions[0].revoked_at).toBeNull();
    expect(suspendAudits()).toEqual([]);
    expect(fake.state.audits.some((item) => item.action === 'task.content_rejected')).toBe(true);
    expect(fake.state.users).toHaveLength(1);
  });

  it('未验证且失败原因里带严重条目时也不停用', async () => {
    const term = matchedSuspendsAccount.terms[0];
    registerOutputClassifier(async () => {
      throw new Error(term);
    });
    prepareOutput();
    const result = await runOutput();

    expect(result.code).toBe('CONTENT_REJECTED');
    expect(result.error).toContain(term);
    expect(fake.state.users[0].suspended_at).toBeNull();
    expect(fake.state.users[0].credits).toBe(1030);
    expect(suspendAudits()).toEqual([]);
  });

  it('只拒绝的输出原因不会停用', async () => {
    const rejectOnly = matchedSuspendsAccount.rejectOnly[matchedSuspendsAccount.rejectOnly.length - 1];
    registerOutputClassifier(async () => ({ flagged: true, reason: rejectOnly }));
    prepareOutput();
    const result = await runOutput();

    expect(result).toMatchObject({ ok: false, code: 'CONTENT_REJECTED', error: rejectOnly });
    expect(fake.state.users[0].suspended_at).toBeNull();
    expect(fake.state.users[0].credits).toBe(1030);
    expect(suspendAudits()).toEqual([]);
  });

  it('输出原因包含严重条目时停用并保持退款', async () => {
    const term = matchedSuspendsAccount.terms[0];
    registerOutputClassifier(async () => ({ flagged: true, reason: `hit ${term}` }));
    prepareOutput();
    const result = await runOutput();

    expect(result.code).toBe('CONTENT_REJECTED');
    expect(fake.state.users[0].credits).toBe(1030);
    expect(fake.state.users[0].suspended_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(fake.state.sessions[0].revoked_at).toBe(fake.state.users[0].suspended_at);
    expect(suspendAudits()).toEqual([
      { action: 'auth.account_suspend', userId: 'user-1', meta: { stage: 'output', category: 'severe' } },
    ]);
    expect(JSON.stringify(suspendAudits()[0]?.meta)).not.toContain(term);
    expect(fake.state.ledger).toHaveLength(1);
    expect(fake.state.users).toHaveLength(1);
  });
});

describe('解除停用', () => {
  function memoryQuery(user: { id: string; suspended_at: string | null; credits: number }, sqls: string[]): UnsuspendQuery {
    return async (sql, params) => {
      sqls.push(sql);
      if (sql === SELECT_SUSPENDED_USER_SQL && params?.[0] === user.id) {
        return [[{ id: user.id, suspended_at: user.suspended_at, credits: user.credits }]];
      }
      if (sql === CLEAR_SUSPENDED_SQL && params?.[0] === user.id) {
        user.suspended_at = null;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected sql: ${sql}`);
    };
  }

  it('默认不改库', async () => {
    const user = { id: 'user-9', suspended_at: '2026-01-02 03:04:05', credits: 77 };
    const sqls: string[] = [];
    const report = await runUnsuspend([], undefined, async () => {
      throw new Error('默认不应连接数据库');
    });
    expect(report).toMatchObject({ mode: 'dry-run', cleared: false, userId: null });

    const dry = await runUnsuspend(['--user', user.id], '1', async () => ({
      query: memoryQuery(user, sqls),
      release: async () => {},
    }));
    expect(dry.cleared).toBe(false);
    expect(dry.suspendedAt).toBe('2026-01-02 03:04:05');
    expect(user.suspended_at).toBe('2026-01-02 03:04:05');
    expect(user.credits).toBe(77);
    expect(sqls).toEqual([SELECT_SUSPENDED_USER_SQL]);
  });

  it('开关不是 1 时 --apply 失败且不改库', async () => {
    const user = { id: 'user-9', suspended_at: '2026-01-02 03:04:05', credits: 77 };
    const sqls: string[] = [];
    const query = memoryQuery(user, sqls);
    for (const switchValue of ['true', 'yes', 'on', '01', '1 ', '', undefined]) {
      await expect(
        unsuspendAccount(query, { apply: true, userId: user.id, switchValue }),
      ).rejects.toThrow(/ACCOUNT_UNSUSPEND/);
      await expect(
        runUnsuspend(['--apply', '--user', user.id], switchValue, async () => {
          throw new Error('开关不对时不应连接数据库');
        }),
      ).rejects.toThrow(/ACCOUNT_UNSUSPEND/);
    }
    expect(sqls).toEqual([]);
    expect(user.suspended_at).toBe('2026-01-02 03:04:05');
    expect(user.credits).toBe(77);
  });

  it('开关精确为 1 且带 apply 和用户才清空停用时间', async () => {
    const user = { id: 'user-9', suspended_at: '2026-01-02 03:04:05', credits: 77 };
    const sqls: string[] = [];
    const report = await unsuspendAccount(memoryQuery(user, sqls), {
      apply: true,
      userId: user.id,
      switchValue: '1',
    });
    expect(report.cleared).toBe(true);
    expect(report.suspendedAt).toBe('2026-01-02 03:04:05');
    expect(user.suspended_at).toBeNull();
    expect(user.credits).toBe(77);
    expect(sqls).toEqual([SELECT_SUSPENDED_USER_SQL, CLEAR_SUSPENDED_SQL]);
  });
});

describe('停用迁移', () => {
  it('只增加可空停用时间并且可以重复执行', () => {
    const sql = readFileSync(join(here, '../src/db/migrations/0011_account_suspension.sql'), 'utf8').replace(/--.*$/gm, '');
    expect(sql).toMatch(/information_schema\.COLUMNS/);
    expect(sql).toMatch(/ADD COLUMN suspended_at DATETIME NULL/);
    expect(sql).toMatch(/information_schema\.STATISTICS/);
    expect(sql).toMatch(/CREATE INDEX idx_users_suspended_at ON users \(suspended_at\)/);
    expect(sql).toMatch(/PREPARE stmt FROM @sql/);
    expect(sql).not.toMatch(/\b(DROP|DELETE|PARTITION)\b/i);
    expect(sql).not.toMatch(/\bFOREIGN\s+KEY\b/i);
    expect(sql).not.toMatch(/\bREFERENCES\b/i);
  });

  it('schema 的用户表带上注销时间和停用时间', () => {
    const schema = readFileSync(join(here, '../src/db/schema.sql'), 'utf8');
    const users = schema.slice(
      schema.indexOf('CREATE TABLE IF NOT EXISTS users'),
      schema.indexOf('CREATE TABLE IF NOT EXISTS model_registry'),
    );
    expect(users).toMatch(/deleted_at\s+DATETIME\s+NULL/);
    expect(users).toMatch(/suspended_at\s+DATETIME\s+NULL/);
  });
});
