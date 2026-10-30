import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Coins,
  Cpu,
  Loader2,
  Receipt,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { Button, Tag } from '../components/ui/Button';
import { useAuth } from '../lib/auth';
import {
  adminApi,
  ApiClientError,
  getActiveOrgId,
  type AdminModel,
  type AdminOrder,
  type AdminStats,
  type AuditEntry,
} from '../lib/api';
import { appendGenerationPage, HISTORY_PAGE_SIZE, mergeGenerationPage, type HistoryCursor } from '../lib/history-page';
import { useI18n, type MessageKey } from '../lib/i18n';
import { formatUtcClock } from '../lib/utc-time';
import { cn } from '../lib/utils';

const ADMIN_TABS = [
  { id: 'ops', labelKey: 'admin_tab_ops', icon: Activity },
  { id: 'models', labelKey: 'admin_tab_models', icon: Cpu },
  { id: 'audit', labelKey: 'admin_tab_audit', icon: ScrollText },
] as const;

type ReconcileIssue = {
  key: 'admin_reconcile_balance' | 'admin_reconcile_double' | 'admin_reconcile_unrefunded';
  count: number;
};

type ReconcileCounts = {
  balanceDrift: number;
  doubleCharged: number;
  unrefundedFailures: number;
};

function reconcileCount(
  rows: readonly unknown[],
  counts: ReconcileCounts | undefined,
  key: keyof ReconcileCounts,
) {
  return counts?.[key] ?? rows.length;
}

function pct(v: number | null) {
  if (v === null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function num(v: number) {
  return v.toLocaleString();
}

function yuan(cents: number) {
  return `¥${(cents / 100).toFixed(2)}`;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


const ORDER_STATUS_KEY: Record<AdminOrder['status'], MessageKey> = {
  pending: 'billing_status_pending',
  paid: 'billing_status_paid',
  failed: 'billing_status_failed',
  refunded: 'billing_status_refunded',
  expired: 'billing_status_expired',
};

type AdminOrderPage = {
  items: AdminOrder[];
  totals: { paidCount: number; revenueCents: number; creditsSold: number };
  nextCursor: HistoryCursor | null;
};

type AuditPage = {
  items: AuditEntry[];
  nextCursor: string | null;
};

const AUDIT_PAGE_SIZE = 50;

/** Audit is id-desc. A full page keeps already loaded smaller ids; a short page replaces the list. */
function mergeAuditPage(loaded: AuditEntry[], firstPage: AuditEntry[], pageSize: number) {
  if (firstPage.length < pageSize) return firstPage;
  const seen = new Set(firstPage.map((item) => item.id));
  const oldestId = Math.min(...firstPage.map((item) => item.id));
  const older = loaded.filter((item) => !seen.has(item.id) && item.id < oldestId);
  return [...firstPage, ...older];
}

function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  icon: React.ReactNode;
}) {
  const toneClass = {
    default: 'text-foreground',
    good: 'text-emerald-500',
    warn: 'text-amber-500',
    bad: 'text-red-500',
  }[tone];
  return (
    <div className="rounded-xl border border-stone-200 bg-card p-4 dark:border-stone-800">
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-xs">{label}</span>
        {icon}
      </div>
      <p className={cn('mt-2 text-2xl font-semibold tabular-nums', toneClass)}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function AdminPage() {
  const { t } = useI18n();
  const { user, openLogin, status } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'ops' | 'audit' | 'models'>('ops');
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const userKey = user?.id ?? 'guest';
  const enabled = Boolean(user);
  const retry = (failureCount: number, error: Error) =>
    !(error instanceof ApiClientError && (error.status === 401 || error.status === 403)) && failureCount < 2;
  const workspaceId = getActiveOrgId() ?? 'personal';
  const statsKey = ['admin', userKey, workspaceId, workspaceVersion, 'stats'] as const;
  const auditKey = ['admin', userKey, workspaceId, workspaceVersion, 'audit'] as const;
  const modelsKey = ['admin', userKey, workspaceId, workspaceVersion, 'models'] as const;
  const reconcileKey = ['admin', userKey, workspaceId, workspaceVersion, 'reconcile'] as const;
  const billingReconcileKey = ['admin', userKey, workspaceId, workspaceVersion, 'billingReconcile'] as const;
  const ordersKey = ['admin', userKey, workspaceId, workspaceVersion, 'orders'] as const;
  // Retire in-flight earlier pages when the user or workspace segment changes.
  const earlierScope = JSON.stringify([userKey, workspaceId, workspaceVersion]);
  const earlierScopeSeen = useRef(earlierScope);
  const loadingEarlier = useRef(false);
  const loadingEarlierOrders = useRef(false);
  const earlierAuditLoad = useRef(0);
  const earlierOrdersLoad = useRef(0);
  if (earlierScopeSeen.current !== earlierScope) {
    earlierScopeSeen.current = earlierScope;
    loadingEarlier.current = false;
    loadingEarlierOrders.current = false;
    earlierAuditLoad.current += 1;
    earlierOrdersLoad.current += 1;
  }

  useEffect(() => {
    const onWorkspaceChange = () => setWorkspaceVersion((version) => version + 1);
    window.addEventListener('benchu:workspace-change', onWorkspaceChange);
    return () => window.removeEventListener('benchu:workspace-change', onWorkspaceChange);
  }, []);

  const statsQuery = useQuery({
    queryKey: statsKey,
    queryFn: adminApi.stats,
    enabled,
    staleTime: 15_000,
    retry,
  });
  const auditQuery = useQuery({
    queryKey: auditKey,
    queryFn: async () => {
      const page = await adminApi.audit({ limit: AUDIT_PAGE_SIZE });
      const previous = queryClient.getQueryData<AuditPage>(auditKey);
      const items = mergeAuditPage(previous?.items ?? [], page.items, AUDIT_PAGE_SIZE);
      const keptOlder = items.length > page.items.length;
      return {
        items,
        nextCursor:
          page.items.length < AUDIT_PAGE_SIZE ? null : keptOlder ? (previous?.nextCursor ?? null) : page.nextCursor,
      };
    },
    enabled,
    staleTime: 15_000,
    retry,
  });
  const modelsQuery = useQuery({
    queryKey: modelsKey,
    queryFn: adminApi.models,
    enabled,
    staleTime: 30_000,
    retry,
  });
  const reconcileQuery = useQuery({
    queryKey: reconcileKey,
    queryFn: async () => {
      const result: Awaited<ReturnType<typeof adminApi.reconcile>> & { counts?: ReconcileCounts } =
        await adminApi.reconcile();
      const issues: ReconcileIssue[] = [];
      const balanceCount = reconcileCount(result.balanceDrift, result.counts, 'balanceDrift');
      const doubleCount = reconcileCount(result.doubleCharged, result.counts, 'doubleCharged');
      const unrefundedCount = reconcileCount(result.unrefundedFailures, result.counts, 'unrefundedFailures');
      if (balanceCount > 0) issues.push({ key: 'admin_reconcile_balance', count: balanceCount });
      if (doubleCount > 0) issues.push({ key: 'admin_reconcile_double', count: doubleCount });
      if (unrefundedCount > 0) issues.push({ key: 'admin_reconcile_unrefunded', count: unrefundedCount });
      return { ok: result.ok, issues };
    },
    enabled,
    staleTime: 15_000,
    retry,
  });
  // Failure stays off `queries` so a missing mock cannot fail the whole page.
  const billingReconcileQuery = useQuery({
    queryKey: billingReconcileKey,
    queryFn: async () => {
      const result = await adminApi.billingReconcile();
      const creditMismatch = result.counts?.creditMismatch ?? result.creditMismatch.length;
      const paidWithoutWebhook = result.counts?.paidWithoutWebhook ?? result.paidWithoutWebhook.length;
      return {
        ok: creditMismatch === 0 && paidWithoutWebhook === 0,
        creditMismatch,
        paidWithoutWebhook,
      };
    },
    enabled,
    staleTime: 15_000,
    retry,
  });
  const ordersQuery = useQuery({
    queryKey: ordersKey,
    queryFn: async () => {
      const page = await adminApi.orders({ limit: HISTORY_PAGE_SIZE });
      const previous = queryClient.getQueryData<AdminOrderPage>(ordersKey);
      const items = mergeGenerationPage(previous?.items ?? [], page.items, HISTORY_PAGE_SIZE);
      const keptOlder = items.length > page.items.length;
      return {
        items,
        totals: page.totals,
        nextCursor:
          page.items.length < HISTORY_PAGE_SIZE ? null : keptOlder ? (previous?.nextCursor ?? null) : page.nextCursor,
      };
    },
    enabled,
    staleTime: 15_000,
    retry,
  });

  const toggleModelMutation = useMutation({
    mutationFn: ({ id, nextEnabled }: { id: string; nextEnabled: boolean }) =>
      adminApi.updateModel(id, { enabled: nextEnabled }),
    onMutate: async ({ id, nextEnabled }) => {
      const key = modelsKey;
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AdminModel[]>(key);
      queryClient.setQueryData<AdminModel[]>(key, (current = []) =>
        current.map((model) => (model.id === id ? { ...model, enabled: nextEnabled } : model)),
      );
      return { previous, modelsKey: key, userKey, workspaceId, workspaceVersion };
    },
    onError: (_error, _variables, context) => {
      if (context?.modelsKey && context.previous) queryClient.setQueryData(context.modelsKey, context.previous);
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context?.modelsKey) queryClient.invalidateQueries({ queryKey: context.modelsKey });
    },
  });

  const refresh = () =>
    Promise.all([
      statsQuery.refetch(),
      auditQuery.refetch(),
      modelsQuery.refetch(),
      reconcileQuery.refetch(),
      billingReconcileQuery.refetch(),
      ordersQuery.refetch(),
    ]);
  const stats: AdminStats | null = statsQuery.data ?? null;
  const audit: AuditEntry[] = auditQuery.data?.items ?? [];
  const orders: AdminOrderPage | null = ordersQuery.data ?? null;
  const loadEarlierAudit = async () => {
    const cursor = auditQuery.data?.nextCursor;
    if (!cursor || loadingEarlier.current) return;
    loadingEarlier.current = true;
    const requestId = ++earlierAuditLoad.current;
    const requestKey = auditKey;
    try {
      const page = await adminApi.audit({ limit: AUDIT_PAGE_SIZE, before: cursor });
      if (requestId !== earlierAuditLoad.current) return;
      queryClient.setQueryData<AuditPage>(requestKey, (previous) => {
        const seen = new Set((previous?.items ?? []).map((item) => item.id));
        return {
          items: [...(previous?.items ?? []), ...page.items.filter((item) => !seen.has(item.id))],
          nextCursor: page.nextCursor,
        };
      });
    } catch (error) {
      if (requestId !== earlierAuditLoad.current) return;
      throw error;
    } finally {
      if (requestId === earlierAuditLoad.current) loadingEarlier.current = false;
    }
  };
  const loadEarlierOrders = async () => {
    const cursor = ordersQuery.data?.nextCursor;
    if (!cursor || loadingEarlierOrders.current) return;
    loadingEarlierOrders.current = true;
    const requestId = ++earlierOrdersLoad.current;
    const requestKey = ordersKey;
    try {
      const page = await adminApi.orders({
        limit: HISTORY_PAGE_SIZE,
        before: cursor.createdAt,
        beforeId: cursor.id,
      });
      if (requestId !== earlierOrdersLoad.current) return;
      queryClient.setQueryData<AdminOrderPage>(requestKey, (previous) => ({
        items: appendGenerationPage(previous?.items ?? [], page.items),
        totals: page.totals,
        nextCursor: page.nextCursor,
      }));
    } catch (error) {
      if (requestId !== earlierOrdersLoad.current) return;
      throw error;
    } finally {
      if (requestId === earlierOrdersLoad.current) loadingEarlierOrders.current = false;
    }
  };
  const models: AdminModel[] = modelsQuery.data ?? [];
  const reconcile = reconcileQuery.data ?? null;
  const billingReconcile = billingReconcileQuery.isSuccess ? billingReconcileQuery.data : null;
  const queries = [statsQuery, auditQuery, modelsQuery, reconcileQuery, ordersQuery];
  const loading = enabled && queries.some((query) => query.isLoading);
  const refreshing = queries.some((query) => query.isFetching);
  const queryError = queries.map((query) => query.error).find(Boolean);
  const forbidden = queryError instanceof ApiClientError && (queryError.status === 401 || queryError.status === 403);
  const mutationScope = toggleModelMutation.context;
  const mutationError =
    mutationScope?.userKey === userKey &&
    mutationScope.workspaceId === workspaceId &&
    mutationScope.workspaceVersion === workspaceVersion
      ? toggleModelMutation.error
      : null;
  const error = forbidden
    ? null
    : mutationError instanceof Error
      ? mutationError.message
      : queryError instanceof Error
        ? queryError.message
        : queryError
          ? t('admin_load_failed')
          : null;

  if (status === 'loading') {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <Loader2
          role="status"
          aria-label={t('admin_loading_auth')}
          className="size-6 animate-spin text-muted-foreground"
        />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="text-center">
          <ShieldAlert className="mx-auto mb-3 size-10 text-muted-foreground" />
          <p className="mb-3 text-sm text-muted-foreground">{t('admin_login_required')}</p>
          <Button variant="brand" onClick={openLogin}>
            {t('login')}
          </Button>
        </div>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <Loader2
          role="status"
          aria-label={t('admin_loading_data')}
          className="size-6 animate-spin text-muted-foreground"
        />
      </main>
    );
  }

  if (forbidden) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="max-w-sm text-center">
          <ShieldAlert className="mx-auto mb-3 size-10 text-amber-500" />
          <h1 className="text-lg font-semibold">{t('admin_forbidden_title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('admin_forbidden_body')}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{t('admin_title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('admin_subtitle')}</p>
          </div>
          <Button onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t('admin_refresh')}
          </Button>
        </div>

        {error && (
          <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        {reconcile && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
              reconcile.ok
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'border-red-500/30 bg-red-500/10 text-red-400',
            )}
          >
            {reconcile.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            )}
            <div>
              <p className="font-medium">{reconcile.ok ? t('admin_reconcile_ok') : t('admin_reconcile_bad')}</p>
              {!reconcile.ok && (
                <ul className="mt-1 list-inside list-disc text-xs">
                  {reconcile.issues.map((issue) => (
                    <li key={issue.key}>{t(issue.key, { count: issue.count })}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {billingReconcile && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
              billingReconcile.ok
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'border-red-500/30 bg-red-500/10 text-red-400',
            )}
          >
            {billingReconcile.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            )}
            <div>
              <p className="font-medium">{t('admin_billing_reconcile')}</p>
              <p className="mt-1 text-xs">
                {billingReconcile.ok ? t('admin_reconcile_ok') : t('admin_reconcile_bad')}
              </p>
              {!billingReconcile.ok && (
                <ul className="mt-1 list-inside list-disc text-xs">
                  {billingReconcile.creditMismatch > 0 && (
                    <li>{t('admin_credit_mismatch', { count: billingReconcile.creditMismatch })}</li>
                  )}
                  {billingReconcile.paidWithoutWebhook > 0 && (
                    <li>{t('admin_paid_without_webhook', { count: billingReconcile.paidWithoutWebhook })}</li>
                  )}
                </ul>
              )}
            </div>
          </div>
        )}

        <div
          role="tablist"
          aria-label={t('admin_tablist')}
          className="flex gap-1 rounded-lg border border-stone-200 p-1 dark:border-stone-800"
        >
          {ADMIN_TABS.map(({ id, labelKey, icon: Icon }, index) => (
            <button
              key={id}
              id={`admin-tab-${id}`}
              role="tab"
              aria-selected={tab === id}
              aria-controls={`admin-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % ADMIN_TABS.length
                    : event.key === 'ArrowLeft'
                      ? (index - 1 + ADMIN_TABS.length) % ADMIN_TABS.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? ADMIN_TABS.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                const nextId = ADMIN_TABS[next].id;
                setTab(nextId);
                document.getElementById(`admin-tab-${nextId}`)?.focus();
              }}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition',
                tab === id
                  ? 'bg-stone-900 text-white dark:bg-white dark:text-stone-900'
                  : 'text-muted-foreground hover:bg-white/5',
              )}
            >
              <Icon className="size-3.5" />
              {t(labelKey)}
            </button>
          ))}
        </div>

        {tab === 'ops' && stats && (
          <div id="admin-panel-ops" role="tabpanel" aria-labelledby="admin-tab-ops" className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label={t('admin_tasks_total')}
                value={num(stats.tasks.total)}
                hint={t('admin_tasks_hint', { count: stats.tasks.queued, running: stats.tasks.running })}
                icon={<Activity className="size-4" />}
              />
              <StatCard
                label={t('admin_success_rate')}
                value={pct(stats.tasks.successRate)}
                hint={t('admin_success_hint', { count: stats.tasks.done, failed: stats.tasks.failed })}
                tone={
                  stats.tasks.successRate === null
                    ? 'default'
                    : stats.tasks.successRate >= 0.95
                      ? 'good'
                      : stats.tasks.successRate >= 0.8
                        ? 'warn'
                        : 'bad'
                }
                icon={<CheckCircle2 className="size-4" />}
              />
              <StatCard
                label={t('admin_credits_charged')}
                value={num(stats.tasks.creditsCharged)}
                hint={t('admin_refunded_hint', { count: num(stats.tasks.creditsRefunded) })}
                icon={<Coins className="size-4" />}
              />
              <StatCard
                label={t('admin_active_users')}
                value={num(stats.credits.activeUsers)}
                hint={t('admin_users_hint', {
                  count: num(stats.credits.granted),
                  spent: num(stats.credits.spent),
                })}
                icon={<Activity className="size-4" />}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-lg border border-stone-200 bg-card p-4 dark:border-stone-800">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <XCircle className="size-4" /> {t('admin_top_errors')}
                </h2>
                {stats.topErrors.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">{t('admin_no_errors')}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {stats.topErrors.map((e) => (
                      <li key={e.code} className="flex items-center justify-between text-sm">
                        <code className="text-xs text-red-400">{e.code}</code>
                        <span className="tabular-nums text-muted-foreground">{num(e.count)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-lg border border-stone-200 bg-card p-4 dark:border-stone-800">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <Cpu className="size-4" /> {t('admin_top_models')}
                </h2>
                {stats.topModels.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">{t('admin_no_models')}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {stats.topModels.map((m) => (
                      <li key={m.modelId} className="flex items-center justify-between gap-2 text-sm">
                        <code className="truncate text-xs text-muted-foreground">{m.modelId}</code>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {t('admin_model_usage', { count: num(m.calls), credits: num(m.credits) })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            {orders && (
              <section className="rounded-lg border border-stone-200 bg-card dark:border-stone-800">
                <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                  <Receipt className="size-4" />
                  <h2 className="text-sm font-semibold">{t('admin_org_orders')}</h2>
                </div>
                <div className="grid gap-3 p-4 sm:grid-cols-3">
                  <StatCard
                    label={t('admin_paid_orders')}
                    value={num(orders.totals.paidCount)}
                    icon={<Receipt className="size-4" />}
                  />
                  <StatCard
                    label={t('admin_revenue')}
                    value={yuan(orders.totals.revenueCents)}
                    icon={<Coins className="size-4" />}
                  />
                  <StatCard
                    label={t('admin_credits_sold')}
                    value={num(orders.totals.creditsSold)}
                    icon={<Coins className="size-4" />}
                  />
                </div>
                {orders.items.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">{t('billing_no_orders')}</p>
                ) : (
                  <ul className="thin-scrollbar max-h-[60vh] divide-y divide-border overflow-y-auto">
                    {orders.items.map((order) => (
                      <li key={order.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                        <div className="min-w-0 flex-1">
                          <p className="truncate">
                            {order.skuName}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {order.kind === 'plan' ? t('billing_order_plan') : t('billing_order_credits')}
                            </span>
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {fmtTime(order.createdAt)} · {order.userId}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="tabular-nums">{yuan(order.amountCents)}</p>
                          <p className="text-[11px] text-muted-foreground">{t(ORDER_STATUS_KEY[order.status])}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {orders.nextCursor && (
                  <div className="border-t border-border px-4 py-3 text-center">
                    <Button size="sm" onClick={() => void loadEarlierOrders()}>
                      {t('admin_audit_hint')}
                    </Button>
                  </div>
                )}
              </section>
            )}
          </div>
        )}

        {tab === 'models' && (
          <section
            id="admin-panel-models"
            role="tabpanel"
            aria-labelledby="admin-tab-models"
            className="rounded-lg border border-stone-200 bg-card dark:border-stone-800"
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Cpu className="size-4" />
              <h2 className="text-sm font-semibold">{t('admin_registry_title')}</h2>
              <span className="text-xs text-muted-foreground">{t('admin_registry_hint')}</span>
            </div>
            <div className="thin-scrollbar max-h-[60vh] overflow-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-4 py-2 text-left font-medium">{t('admin_col_model')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('admin_col_kind')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('admin_col_price')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('admin_col_unit')}</th>
                    <th className="px-3 py-2 text-center font-medium">{t('admin_col_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.id} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2">
                        <span className="block">{m.displayName}</span>
                        <code className="text-[11px] text-muted-foreground">{m.id}</code>
                      </td>
                      <td className="px-3 py-2">
                        <Tag>{m.kind}</Tag>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.priceAmount}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {m.priceUnit === 'per_second'
                          ? t('admin_unit_second')
                          : m.priceUnit === 'per_image'
                            ? t('admin_unit_image')
                            : t('admin_unit_call')}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          aria-label={t('admin_model_toggle', {
                            name: m.displayName,
                            action: m.enabled ? t('admin_action_disable') : t('admin_action_enable'),
                          })}
                          aria-pressed={m.enabled}
                          onClick={() => toggleModelMutation.mutate({ id: m.id, nextEnabled: !m.enabled })}
                          disabled={toggleModelMutation.isPending && toggleModelMutation.variables?.id === m.id}
                          className={cn(
                            'whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] transition disabled:opacity-60',
                            m.enabled
                              ? 'bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25'
                              : 'bg-stone-500/15 text-stone-400 hover:bg-stone-500/25',
                          )}
                        >
                          {m.enabled ? t('admin_status_enabled') : t('admin_status_disabled')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'audit' && (
          <section
            id="admin-panel-audit"
            role="tabpanel"
            aria-labelledby="admin-tab-audit"
            className="rounded-lg border border-stone-200 bg-card dark:border-stone-800"
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <ScrollText className="size-4" />
              <h2 className="text-sm font-semibold">{t('admin_tab_audit')}</h2>
            </div>
            {audit.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t('admin_audit_empty')}</p>
            ) : (
              <ul className="thin-scrollbar max-h-[60vh] divide-y divide-border overflow-y-auto">
                {audit.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate">
                        <code className="text-xs">{a.action}</code>
                        {a.target && <span className="ml-2 text-xs text-muted-foreground">{a.target}</span>}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatUtcClock(a.createdAt)} · {a.ip ?? '—'}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {auditQuery.data?.nextCursor && (
              <div className="border-t border-border px-4 py-3 text-center">
                <Button size="sm" onClick={() => void loadEarlierAudit()}>
                  {t('admin_audit_hint')}
                </Button>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
