import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Copy, KeyRound, Plus, Trash2, UserPlus, Users, Shield } from 'lucide-react';
import { Button, Tag } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { useAuth } from '../lib/auth';
import { apiKeyApi, orgApi, type OrgRole } from '../lib/api';
import { cn } from '../lib/utils';
import { chip, field } from '../lib/styles';
import { useI18n } from '../lib/i18n';
import { maskEmail } from '../lib/mask-email';
import { inviteEmailLooksValid, keyNameTooLongMessage, orgNameTooLongMessage } from '../lib/team-field';
import { formatUtcLocal } from '../lib/utc-time';

const SCOPES = ['generate:image', 'generate:video', 'assets:read', 'assets:write', '*'] as const;
const teamKeys = {
  orgs: (userId: string) => ['team', userId, 'orgs'] as const,
  members: (userId: string, orgId: string) => ['team', userId, orgId, 'members'] as const,
  apiKeys: (userId: string, orgId: string) => ['team', userId, orgId, 'api-keys'] as const,
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function TeamPage() {
  const { user, openLogin } = useAuth();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newOrgOpen, setNewOrgOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<OrgRole, 'owner'>>('editor');
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>(['generate:image', 'generate:video']);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [seenUserId, setSeenUserId] = useState(user?.id ?? 'guest');
  const roleLabel = (role: OrgRole) => t(`role_${role}` as 'role_owner' | 'role_admin' | 'role_editor' | 'role_viewer');

  const userId = user?.id ?? 'guest';
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  if (userId !== seenUserId) {
    setSeenUserId(userId);
    setNewKey(null);
    setError(null);
    setInviteEmail('');
    setKeyName('');
    setNewOrgName('');
    setNewOrgOpen(false);
    setKeyScopes(['generate:image', 'generate:video']);
  }
  const orgsQuery = useQuery({
    queryKey: teamKeys.orgs(userId),
    queryFn: orgApi.list,
    enabled: Boolean(user),
    staleTime: 15_000,
  });
  const orgs = useMemo(() => orgsQuery.data ?? [], [orgsQuery.data]);
  const activeOrg = useMemo(() => orgs.find((o) => o.id === activeOrgId) ?? orgs[0], [orgs, activeOrgId]);
  const activeOrgIdRef = useRef(activeOrg?.id);
  activeOrgIdRef.current = activeOrg?.id;
  const canManage = activeOrg?.role === 'owner' || activeOrg?.role === 'admin';
  const membersQuery = useQuery({
    queryKey: teamKeys.members(userId, activeOrg?.id ?? 'none'),
    queryFn: () => orgApi.members(activeOrg!.id),
    enabled: Boolean(user && activeOrg),
    staleTime: 10_000,
  });
  const apiKeysQuery = useQuery({
    queryKey: teamKeys.apiKeys(userId, activeOrg?.id ?? 'none'),
    queryFn: () => apiKeyApi.list(activeOrg!.id),
    enabled: Boolean(user && activeOrg),
    staleTime: 10_000,
  });
  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const keys = useMemo(() => apiKeysQuery.data ?? [], [apiKeysQuery.data]);

  useEffect(() => {
    if (orgs.length === 0) {
      if (!orgsQuery.isLoading) setActiveOrgId(null);
      return;
    }
    if (!orgs.some((org) => org.id === activeOrgId)) setActiveOrgId(orgs[0].id);
  }, [activeOrgId, orgs, orgsQuery.isLoading]);

  const createOrg = useMutation({
    mutationFn: orgApi.create,
    onMutate: () => userIdRef.current,
    onSuccess: async (created, _name, requestUserId) => {
      await queryClient.invalidateQueries({ queryKey: teamKeys.orgs(requestUserId) });
      if (userIdRef.current !== requestUserId) return;
      setNewOrgName('');
      setNewOrgOpen(false);
      setActiveOrgId(created.id);
    },
    onError: (err, _name, requestUserId) => {
      if (userIdRef.current !== requestUserId) return;
      setError(errorMessage(err, t('team_create_org_failed')));
    },
  });

  const inviteMember = useMutation({
    mutationFn: ({ orgId, email, role }: { orgId: string; email: string; role: Exclude<OrgRole, 'owner'> }) =>
      orgApi.invite(orgId, email, role),
    onMutate: () => userIdRef.current,
    onSuccess: async (_created, variables, requestUserId) => {
      if (userIdRef.current === requestUserId && activeOrgIdRef.current === variables.orgId) setInviteEmail('');
      await queryClient.invalidateQueries({ queryKey: teamKeys.members(requestUserId, variables.orgId) });
    },
    onError: (err, variables, requestUserId) => {
      if (userIdRef.current !== requestUserId || activeOrgIdRef.current !== variables.orgId) return;
      setError(errorMessage(err, t('team_invite_failed')));
    },
  });

  const setMemberRole = useMutation({
    mutationFn: ({ orgId, memberId, role }: { orgId: string; memberId: string; role: Exclude<OrgRole, 'owner'> }) =>
      orgApi.setRole(orgId, memberId, role),
    onMutate: () => userIdRef.current,
    onSuccess: (_result, variables, requestUserId) =>
      queryClient.invalidateQueries({ queryKey: teamKeys.members(requestUserId, variables.orgId) }),
    onError: (err, variables, requestUserId) => {
      if (userIdRef.current !== requestUserId || activeOrgIdRef.current !== variables.orgId) return;
      setError(errorMessage(err, t('team_role_failed')));
    },
  });

  const removeMember = useMutation({
    mutationFn: ({ orgId, memberId }: { orgId: string; memberId: string }) => orgApi.removeMember(orgId, memberId),
    onMutate: () => userIdRef.current,
    onSuccess: (_result, variables, requestUserId) =>
      queryClient.invalidateQueries({ queryKey: teamKeys.members(requestUserId, variables.orgId) }),
    onError: (err, variables, requestUserId) => {
      if (userIdRef.current !== requestUserId || activeOrgIdRef.current !== variables.orgId) return;
      setError(errorMessage(err, t('team_remove_failed')));
    },
  });

  const createKey = useMutation({
    mutationFn: ({ orgId, name, scopes }: { orgId: string; name: string; scopes: string[] }) =>
      apiKeyApi.create(orgId, { name, scopes }),
    onMutate: () => userIdRef.current,
    onSuccess: async (created, variables, requestUserId) => {
      if (userIdRef.current === requestUserId && activeOrgIdRef.current === variables.orgId) setKeyName('');
      if (userIdRef.current === requestUserId) setNewKey(created.key);
      await queryClient.invalidateQueries({ queryKey: teamKeys.apiKeys(requestUserId, variables.orgId) });
    },
    onError: (err, variables, requestUserId) => {
      if (userIdRef.current !== requestUserId || activeOrgIdRef.current !== variables.orgId) return;
      setError(errorMessage(err, t('team_create_key_failed')));
    },
  });

  const revokeKey = useMutation({
    mutationFn: ({ orgId, keyId }: { orgId: string; keyId: string }) => apiKeyApi.revoke(orgId, keyId),
    onMutate: () => userIdRef.current,
    onSuccess: (_result, variables, requestUserId) =>
      queryClient.invalidateQueries({ queryKey: teamKeys.apiKeys(requestUserId, variables.orgId) }),
    onError: (err, variables, requestUserId) => {
      if (userIdRef.current !== requestUserId || activeOrgIdRef.current !== variables.orgId) return;
      setError(errorMessage(err, t('team_revoke_key_failed')));
    },
  });

  const busy =
    createOrg.isPending ||
    inviteMember.isPending ||
    setMemberRole.isPending ||
    removeMember.isPending ||
    createKey.isPending ||
    revokeKey.isPending;
  const queryError = orgsQuery.error ?? membersQuery.error ?? apiKeysQuery.error;
  const visibleError = error ?? (queryError ? errorMessage(queryError, t('team_load_failed')) : null);
  const orgNameLimit = orgNameTooLongMessage(newOrgName);

  const handleCreateOrg = async () => {
    if (!newOrgName.trim()) return;
    if (orgNameLimit) return;
    setError(null);
    await createOrg.mutateAsync(newOrgName.trim()).catch(() => undefined);
  };

  const handleInvite = async () => {
    if (!activeOrg || !inviteEmail.trim()) return;
    if (!inviteEmailLooksValid(inviteEmail)) {
      setError(t('login_invalid_email'));
      return;
    }
    setError(null);
    await inviteMember
      .mutateAsync({ orgId: activeOrg.id, email: inviteEmail.trim(), role: inviteRole })
      .catch(() => undefined);
  };

  const handleCreateKey = async () => {
    if (!activeOrg || !keyName.trim() || keyScopes.length === 0) return;
    const keyNameLimit = keyNameTooLongMessage(keyName);
    if (keyNameLimit) {
      setError(keyNameLimit);
      return;
    }
    setError(null);
    await createKey
      .mutateAsync({ orgId: activeOrg.id, name: keyName.trim(), scopes: keyScopes })
      .catch(() => undefined);
  };

  if (!user) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="text-center">
          <Users className="mx-auto mb-3 size-10 text-muted-foreground" />
          <p className="mb-3 text-sm text-muted-foreground">{t('team_login_prompt')}</p>
          <Button variant="brand" onClick={openLogin}>
            {t('login')}
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{t('team_title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('team_subtitle')}</p>
          </div>
          <Button onClick={() => setNewOrgOpen(true)}>
            <Plus className="size-4" /> {t('team_new_org')}
          </Button>
        </div>

        {visibleError && (
          <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {visibleError}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {orgs.map((o) => (
            <button
              key={o.id}
              onClick={() => {
                if (o.id !== activeOrg?.id) {
                  activeOrgIdRef.current = o.id;
                  setError(null);
                }
                setActiveOrgId(o.id);
              }}
              aria-pressed={activeOrg?.id === o.id}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition',
                activeOrg?.id === o.id
                  ? 'border-[#9b6bff]/70 bg-[#9b6bff]/10'
                  : 'border-stone-200 hover:border-stone-300 dark:border-stone-800',
              )}
            >
              <Building2 className="size-4" />
              <span className="max-w-[200px] truncate">{o.name}</span>
              <Tag>{roleLabel(o.role)}</Tag>
            </button>
          ))}
        </div>

        {activeOrg && (
          <div className="grid gap-5 lg:grid-cols-2">
            <section className="rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800">
              <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
                <Users className="size-4" /> {t('team_members')}
              </h2>
              <ul className="divide-y divide-border">
                {members.map((m) => (
                  <li key={m.userId} className="flex items-center gap-3 py-2.5">
                    <span className="grid size-8 place-items-center rounded-full bg-white/10">
                      <Shield className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{m.displayName || maskEmail(m.email)}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{maskEmail(m.email)}</span>
                    </span>
                    {activeOrg.role === 'owner' && m.role !== 'owner' ? (
                      <select
                        aria-label={t('team_member_role', { name: m.displayName || maskEmail(m.email) })}
                        value={m.role}
                        onChange={(e) => {
                          if (!activeOrg) return;
                          setError(null);
                          setMemberRole.mutate({
                            orgId: activeOrg.id,
                            memberId: m.userId,
                            role: e.target.value as Exclude<OrgRole, 'owner'>,
                          });
                        }}
                        disabled={setMemberRole.isPending}
                        className="rounded-md border border-stone-300 bg-transparent px-2 py-1 text-xs dark:border-stone-700"
                      >
                        <option value="admin">{t('role_admin')}</option>
                        <option value="editor">{t('role_editor')}</option>
                        <option value="viewer">{t('role_viewer')}</option>
                      </select>
                    ) : (
                      <Tag>{roleLabel(m.role)}</Tag>
                    )}
                    {canManage && m.userId !== user.id && m.role !== 'owner' && (
                      <button
                        title={t('team_remove_member')}
                        aria-label={t('team_remove_member')}
                        onClick={() => {
                          if (!activeOrg) return;
                          setError(null);
                          removeMember.mutate({ orgId: activeOrg.id, memberId: m.userId });
                        }}
                        disabled={removeMember.isPending}
                        className="grid size-7 place-items-center rounded text-red-400 hover:bg-red-500/10"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {canManage && (
                <div className="mt-4 flex flex-wrap items-end gap-2">
                  <label className={cn('flex h-9 flex-1 items-center rounded-md border px-2 text-sm', field)}>
                    <input
                      aria-label={t('team_member_email')}
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder={t('team_member_email')}
                      className="min-w-0 flex-1 bg-transparent outline-none"
                    />
                  </label>
                  <select
                    aria-label={t('team_member_role_label')}
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as any)}
                    className="h-9 rounded-md border border-stone-300 bg-transparent px-2 text-sm dark:border-stone-700"
                  >
                    <option value="admin">{t('role_admin')}</option>
                    <option value="editor">{t('role_editor')}</option>
                    <option value="viewer">{t('role_viewer')}</option>
                  </select>
                  <Button onClick={handleInvite} disabled={busy}>
                    <UserPlus className="size-3.5" /> {t('team_invite')}
                  </Button>
                </div>
              )}
            </section>

            <section className="rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800">
              <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
                <KeyRound className="size-4" /> {t('team_api_keys')}
              </h2>
              <ul className="space-y-2">
                {keys.map((k) => (
                  <li
                    key={k.id}
                    className="flex items-center gap-2 rounded-md border border-stone-200 px-2.5 py-2 dark:border-stone-800"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{k.name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {k.prefix}… · {k.scopes.join(', ')} · {k.revokedAt ? t('team_revoked') : t('team_active')}
                        {' · '}
                        {t('team_key_rpm', { count: k.rateLimit })}
                        {k.expiresAt ? ` · ${t('team_key_expires', { time: formatUtcLocal(k.expiresAt) })}` : null}
                        {k.lastUsedAt ? ` · ${t('team_key_last_used', { time: formatUtcLocal(k.lastUsedAt) })}` : null}
                      </span>
                    </span>
                    {!k.revokedAt && (
                      <button
                        title={t('team_revoke')}
                        aria-label={t('team_revoke')}
                        onClick={() => {
                          if (!activeOrg) return;
                          setError(null);
                          revokeKey.mutate({ orgId: activeOrg.id, keyId: k.id });
                        }}
                        disabled={revokeKey.isPending}
                        className="grid size-7 place-items-center rounded text-red-400 hover:bg-red-500/10"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </li>
                ))}
                {keys.length === 0 && (
                  <li className="py-4 text-center text-sm text-muted-foreground">{t('team_no_keys')}</li>
                )}
              </ul>
              {canManage && (
                <div className="mt-4 space-y-2">
                  <div className="flex gap-2">
                    <input
                      aria-label={t('team_key_name')}
                      value={keyName}
                      onChange={(e) => setKeyName(e.target.value)}
                      placeholder={t('team_key_placeholder')}
                      className={cn('h-9 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none', field)}
                    />
                    <Button onClick={handleCreateKey} disabled={busy || keyScopes.length === 0}>
                      <Plus className="size-3.5" /> {t('team_create')}
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SCOPES.map((s) => (
                      <button
                        key={s}
                        aria-pressed={keyScopes.includes(s)}
                        onClick={() =>
                          setKeyScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
                        }
                        className={chip(keyScopes.includes(s), 'h-7 rounded-full px-2.5 text-[11px]')}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      <Modal open={newOrgOpen} onClose={() => setNewOrgOpen(false)} title={t('team_new_org')}>
        <div className="space-y-3">
          <input
            aria-label={t('team_org_name')}
            value={newOrgName}
            onChange={(e) => setNewOrgName(e.target.value)}
            placeholder={t('team_org_name')}
            className={cn('h-10 w-full rounded-md border bg-transparent px-3 text-sm outline-none', field)}
          />
          {orgNameLimit ? (
            <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {orgNameLimit}
            </p>
          ) : null}
          <Button variant="brand" onClick={handleCreateOrg} disabled={busy} className="w-full">
            {t('team_create_org')}
          </Button>
        </div>
      </Modal>

      <Modal open={Boolean(newKey)} onClose={() => setNewKey(null)} title={t('team_key_created')}>
        <div className="space-y-3">
          <p className="text-sm text-amber-400">{t('team_key_copy_once')}</p>
          <div className="flex items-center gap-2 rounded-md border border-stone-300 bg-white/5 p-2 dark:border-stone-700">
            <code className="min-w-0 flex-1 break-all text-xs">{newKey}</code>
            <button
              onClick={() => newKey && void navigator.clipboard?.writeText(newKey)}
              className="grid size-8 shrink-0 place-items-center rounded hover:bg-white/10"
              title={t('team_copy')}
              aria-label={t('team_copy')}
            >
              <Copy className="size-4" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{t('team_key_example')}</p>
        </div>
      </Modal>
    </main>
  );
}
