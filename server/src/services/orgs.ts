import { randomUUID } from 'node:crypto';
import { query, queryOne, withTransaction, exec } from '../db/pool.js';
import { env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { personalOrgName } from '../lib/email-length.js';
import { audit } from './audit.js';
import { getRedis, redisAvailable } from './queue.js';

export type OrgRole = 'owner' | 'admin' | 'editor' | 'viewer';

export type Organization = {
  id: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  credits: number;
  role: OrgRole;
};

type OrgRow = { id: string; name: string; plan: string; credits: number };

const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const VALID_ROLES = new Set<OrgRole>(['owner', 'admin', 'editor', 'viewer']);

export const ROLE_CACHE_TTL_SECONDS = env.rbac.membershipCacheTtlSeconds;
export const NO_MEMBERSHIP_SENTINEL = 'none';

type LocalCacheState = {
  generation: number;
  activeLookups: number;
  bypassUntil: number;
};

/** Local state closes stale-cache races for the single API process. */
const localCacheState = new Map<string, LocalCacheState>();
const cacheOperations = new Map<string, Promise<void>>();
let cleanupTimer: NodeJS.Timeout | undefined;

export function roleCacheKey(userId: string, orgId: string): string {
  return `auth:membership:v1:${encodeURIComponent(orgId)}:${encodeURIComponent(userId)}`;
}

function currentGeneration(key: string): number {
  return localCacheState.get(key)?.generation ?? 0;
}

function stateFor(key: string): LocalCacheState {
  const current = localCacheState.get(key);
  if (current) return current;
  const created = { generation: 0, activeLookups: 0, bypassUntil: 0 };
  localCacheState.set(key, created);
  return created;
}

function releaseUnusedState(key: string): void {
  const state = localCacheState.get(key);
  if (state && state.activeLookups === 0 && state.bypassUntil <= Date.now() && !cacheOperations.has(key)) {
    localCacheState.delete(key);
  }
}

function sweepExpiredState(): void {
  cleanupTimer = undefined;
  for (const key of localCacheState.keys()) releaseUnusedState(key);
  scheduleStateCleanup();
}

function scheduleStateCleanup(): void {
  if (cleanupTimer) return;
  let nearest = Number.POSITIVE_INFINITY;
  const now = Date.now();
  for (const state of localCacheState.values()) {
    if (state.bypassUntil > now) nearest = Math.min(nearest, state.bypassUntil);
  }
  if (!Number.isFinite(nearest)) return;
  cleanupTimer = setTimeout(sweepExpiredState, Math.max(1, nearest - now));
  cleanupTimer.unref();
}

async function serializeCacheOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = cacheOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  cacheOperations.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (cacheOperations.get(key) === tail) cacheOperations.delete(key);
    releaseUnusedState(key);
  }
}

function bypassesCache(key: string): boolean {
  const state = localCacheState.get(key);
  if (!state) return false;
  if (state.bypassUntil > Date.now()) return true;
  state.bypassUntil = 0;
  releaseUnusedState(key);
  return false;
}

async function readMembershipCache(key: string): Promise<{ hit: boolean; role: OrgRole | null }> {
  if (ROLE_CACHE_TTL_SECONDS <= 0 || !redisAvailable() || bypassesCache(key)) return { hit: false, role: null };
  try {
    const value = await getRedis().get(key);
    if (value === NO_MEMBERSHIP_SENTINEL) return { hit: true, role: null };
    if (VALID_ROLES.has(value as OrgRole)) return { hit: true, role: value as OrgRole };
  } catch {
    // MySQL remains authoritative when Redis is unavailable.
  }
  return { hit: false, role: null };
}

export async function writeMembershipCache(userId: string, orgId: string, role: OrgRole | null): Promise<void> {
  if (ROLE_CACHE_TTL_SECONDS <= 0 || !redisAvailable()) return;
  const key = roleCacheKey(userId, orgId);
  await serializeCacheOperation(key, async () => {
    const state = stateFor(key);
    try {
      await getRedis().setex(key, ROLE_CACHE_TTL_SECONDS, role ?? NO_MEMBERSHIP_SENTINEL);
      state.bypassUntil = 0;
    } catch {
      // Do not reuse a possibly stale value after Redis reconnects. The next
      // request queries MySQL and retries the write-through.
      state.bypassUntil = Date.now() + ROLE_CACHE_TTL_SECONDS * 1000;
      scheduleStateCleanup();
    }
  });
}

export async function invalidateMembershipCache(userId: string, orgId: string): Promise<void> {
  const key = roleCacheKey(userId, orgId);
  const state = stateFor(key);
  state.generation += 1;
  state.bypassUntil = Date.now() + ROLE_CACHE_TTL_SECONDS * 1000;
  scheduleStateCleanup();
  if (ROLE_CACHE_TTL_SECONDS <= 0 || !redisAvailable()) {
    releaseUnusedState(key);
    return;
  }
  await serializeCacheOperation(key, async () => {
    try {
      await getRedis().del(key);
    } catch {
      /* local bypass keeps this process on the authoritative DB */
    }
  });
}

export function roleAtLeast(actual: OrgRole, required: OrgRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export async function ensurePersonalOrg(userId: string, email: string): Promise<string> {
  const existing = await queryOne<{ org_id: string }>(
    `SELECT m.org_id FROM memberships m WHERE m.user_id = ? ORDER BY m.created_at ASC LIMIT 1`,
    [userId],
  );
  if (existing) return existing.org_id;

  const orgId = randomUUID();
  const name = personalOrgName(email);
  await withTransaction(async (conn) => {
    await conn.query('INSERT INTO organizations (id, name, plan, credits) VALUES (?, ?, ?, ?)', [
      orgId,
      name,
      'free',
      0,
    ]);
    await conn.query('INSERT INTO memberships (id, org_id, user_id, role) VALUES (?, ?, ?, ?)', [
      randomUUID(),
      orgId,
      userId,
      'owner',
    ]);
  });
  await writeMembershipCache(userId, orgId, 'owner');
  await audit({ userId, orgId, action: 'org.create', target: orgId, meta: { name } });
  return orgId;
}

export async function listOrgsForUser(userId: string): Promise<Organization[]> {
  const rows = await query<OrgRow & { role: OrgRole }>(
    `SELECT o.id, o.name, o.plan, o.credits, m.role
       FROM organizations o JOIN memberships m ON m.org_id = o.id
      WHERE m.user_id = ? ORDER BY m.created_at ASC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    plan: (r.plan as any) ?? 'free',
    credits: Number(r.credits),
    role: r.role,
  }));
}

export async function getMembership(userId: string, orgId: string): Promise<OrgRole | null> {
  const key = roleCacheKey(userId, orgId);
  const cached = await readMembershipCache(key);
  if (cached.hit) return cached.role;
  const state = stateFor(key);
  const generation = state.generation;
  state.activeLookups += 1;
  try {
    const row = await queryOne<{ role: OrgRole }>(
      'SELECT role FROM memberships WHERE user_id = ? AND org_id = ? LIMIT 1',
      [userId, orgId],
    );
    const role = row?.role ?? null;
    // Serialize the generation check with cache mutation writes. A lookup that
    // began before a role change can never finish its SETEX after the new role.
    await serializeCacheOperation(key, async () => {
      if (currentGeneration(key) !== generation || ROLE_CACHE_TTL_SECONDS <= 0 || !redisAvailable()) return;
      try {
        await getRedis().setex(key, ROLE_CACHE_TTL_SECONDS, role ?? NO_MEMBERSHIP_SENTINEL);
        state.bypassUntil = 0;
      } catch {
        state.bypassUntil = Date.now() + ROLE_CACHE_TTL_SECONDS * 1000;
        scheduleStateCleanup();
      }
    });
    return role;
  } finally {
    state.activeLookups -= 1;
    releaseUnusedState(key);
  }
}

export async function createOrganization(name: string, ownerUserId: string): Promise<string> {
  if (!name.trim()) throw new ApiError(400, '组织名称不能为空', 'BAD_REQUEST');
  const orgId = randomUUID();
  await withTransaction(async (conn) => {
    await conn.query('INSERT INTO organizations (id, name, plan, credits) VALUES (?, ?, ?, 0)', [
      orgId,
      name.trim(),
      'free',
    ]);
    await conn.query('INSERT INTO memberships (id, org_id, user_id, role) VALUES (?, ?, ?, ?)', [
      randomUUID(),
      orgId,
      ownerUserId,
      'owner',
    ]);
  });
  await writeMembershipCache(ownerUserId, orgId, 'owner');
  await audit({ userId: ownerUserId, orgId, action: 'org.create', target: orgId, meta: { name } });
  return orgId;
}

export async function listMembers(orgId: string) {
  return query<{ user_id: string; email: string; display_name: string | null; role: OrgRole; created_at: string }>(
    `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? ORDER BY m.created_at ASC`,
    [orgId],
  );
}

export async function inviteMember(orgId: string, email: string, role: OrgRole, actorId: string) {
  const user = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = ? LIMIT 1', [
    email.trim().toLowerCase(),
  ]);
  if (!user) throw new ApiError(404, '该邮箱尚未注册', 'NOT_FOUND');
  const existing = await queryOne('SELECT id FROM memberships WHERE org_id = ? AND user_id = ? LIMIT 1', [
    orgId,
    user.id,
  ]);
  if (existing) throw new ApiError(409, '该用户已是组织成员', 'CONFLICT');
  await invalidateMembershipCache(user.id, orgId);
  await exec('INSERT INTO memberships (id, org_id, user_id, role) VALUES (?, ?, ?, ?)', [
    randomUUID(),
    orgId,
    user.id,
    role,
  ]);
  await writeMembershipCache(user.id, orgId, role);
  await audit({ userId: actorId, orgId, action: 'org.invite', target: orgId, meta: { email, role } });
  return user.id;
}

export async function updateMemberRole(orgId: string, userId: string, role: OrgRole, actorId: string) {
  const m = await queryOne<{ role: OrgRole }>('SELECT role FROM memberships WHERE org_id = ? AND user_id = ? LIMIT 1', [
    orgId,
    userId,
  ]);
  if (!m) throw new ApiError(404, '成员不存在', 'NOT_FOUND');
  if (m.role === 'owner' && role !== 'owner') {
    // ensure at least one owner remains
    const owners = await query<{ c: number }>('SELECT COUNT(*) AS c FROM memberships WHERE org_id = ? AND role = ?', [
      orgId,
      'owner',
    ]);
    if (Number(owners[0]?.c ?? 0) <= 1) throw new ApiError(400, '组织至少需要保留一个所有者', 'BAD_REQUEST');
  }
  await invalidateMembershipCache(userId, orgId);
  await exec('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?', [role, orgId, userId]);
  await writeMembershipCache(userId, orgId, role);
  await audit({ userId: actorId, orgId, action: 'org.role_change', target: orgId, meta: { member: userId, role } });
}

export async function removeMember(orgId: string, userId: string, actorId: string) {
  const m = await queryOne<{ role: OrgRole }>('SELECT role FROM memberships WHERE org_id = ? AND user_id = ? LIMIT 1', [
    orgId,
    userId,
  ]);
  if (!m) throw new ApiError(404, '成员不存在', 'NOT_FOUND');
  if (m.role === 'owner') {
    const owners = await query<{ c: number }>('SELECT COUNT(*) AS c FROM memberships WHERE org_id = ? AND role = ?', [
      orgId,
      'owner',
    ]);
    if (Number(owners[0]?.c ?? 0) <= 1) throw new ApiError(400, '不能移除最后一个所有者', 'BAD_REQUEST');
  }
  await invalidateMembershipCache(userId, orgId);
  await exec('DELETE FROM memberships WHERE org_id = ? AND user_id = ?', [orgId, userId]);
  await writeMembershipCache(userId, orgId, null);
  await audit({ userId: actorId, orgId, action: 'org.remove_member', target: orgId, meta: { member: userId } });
}
