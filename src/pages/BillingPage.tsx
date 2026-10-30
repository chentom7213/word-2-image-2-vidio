import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Coins, Crown, Loader2, RefreshCw, Receipt, Sparkles, Zap } from 'lucide-react';
import { Button, Tag } from '../components/ui/Button';
import { useAuth } from '../lib/auth';
import {
  billingApi,
  getActiveOrgId,
  orgApi,
  type CreditPackDto,
  type OrderDto,
  type PlanDto,
  type SubscriptionDto,
} from '../lib/api';
import { appendGenerationPage, HISTORY_PAGE_SIZE, mergeGenerationPage, type HistoryCursor } from '../lib/history-page';
import { useI18n, type MessageKey } from '../lib/i18n';
import { listOrderPage } from '../lib/order-history';
import { planWatermarkState } from '../lib/plan-watermark';
import { cn } from '../lib/utils';

function yuan(cents: number) {
  return `¥${(cents / 100).toFixed(2)}`.replace(/\.00$/, '');
}

const STATUS_KEY: Record<OrderDto['status'], MessageKey> = {
  pending: 'billing_status_pending',
  paid: 'billing_status_paid',
  failed: 'billing_status_failed',
  refunded: 'billing_status_refunded',
  expired: 'billing_status_expired',
};

const STATUS_TONE: Record<OrderDto['status'], string> = {
  pending: 'text-amber-500',
  paid: 'text-emerald-500',
  failed: 'text-red-500',
  refunded: 'text-stone-400',
  expired: 'text-stone-400',
};

function fmtTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BillingPage() {
  const { user, openLogin, status, refreshUser } = useAuth();
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const checkoutKeys = useRef(new Map<string, string>());
  const loadingEarlier = useRef(false);
  const ordersRequestSeq = useRef(0);
  const billingUserId = useRef(user?.id ?? 'guest');
  const viewerId = user?.id ?? 'guest';
  const [notice, setNotice] = useState<string | null>(null);
  if (billingUserId.current !== viewerId) {
    billingUserId.current = viewerId;
    // Before paint. An effect would leave the previous request holding the new lock.
    // eslint-disable-next-line react-hooks/refs
    loadingEarlier.current = false;
    // eslint-disable-next-line react-hooks/refs
    ordersRequestSeq.current += 1;
    setError(null);
    setNotice(null);
    // eslint-disable-next-line react-hooks/refs
    checkoutKeys.current.clear();
  }
  const number = (value: number) => value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US');

  const catalogueQuery = useQuery({
    queryKey: ['billing', 'catalogue'],
    queryFn: billingApi.catalogue,
    staleTime: 5 * 60_000,
  });
  const subscriptionKey = ['billing', 'subscription', user?.id ?? 'guest'] as const;
  const ordersKey = ['billing', 'orders', user?.id ?? 'guest'] as const;
  const subscriptionQuery = useQuery({
    queryKey: subscriptionKey,
    queryFn: billingApi.subscription,
    enabled: Boolean(user),
    staleTime: 15_000,
  });
  const ordersQuery = useQuery({
    queryKey: ordersKey,
    queryFn: async () => {
      const page = await listOrderPage({ limit: HISTORY_PAGE_SIZE });
      const previous = queryClient.getQueryData<{ items: OrderDto[]; nextCursor: HistoryCursor | null }>(ordersKey);
      const items = mergeGenerationPage(previous?.items ?? [], page.items, HISTORY_PAGE_SIZE);
      const keptOlder = items.length > page.items.length;
      return {
        items,
        nextCursor:
          page.items.length < HISTORY_PAGE_SIZE ? null : keptOlder ? (previous?.nextCursor ?? null) : page.nextCursor,
      };
    },
    enabled: Boolean(user),
    staleTime: 10_000,
  });
  const orgsQuery = useQuery({
    queryKey: ['orgs', user?.id ?? 'guest'],
    queryFn: orgApi.list,
    enabled: Boolean(user),
    staleTime: 15_000,
  });
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(() => getActiveOrgId());
  const [seenOrgUserId, setSeenOrgUserId] = useState(viewerId);
  if (viewerId !== seenOrgUserId) {
    setSeenOrgUserId(viewerId);
    setActiveOrgIdState(getActiveOrgId());
  }
  useEffect(() => {
    const sync = () => setActiveOrgIdState(getActiveOrgId());
    sync();
    window.addEventListener('benchu:workspace-change', sync);
    return () => window.removeEventListener('benchu:workspace-change', sync);
  }, [user?.id]);
  const activeOrg = orgsQuery.data?.find((org) => org.id === activeOrgId);
  const ownerOnly = Boolean(activeOrg && activeOrg.role !== 'owner');

  const refreshBilling = async () => {
    setError(null);
    await Promise.all([
      catalogueQuery.refetch(),
      user ? subscriptionQuery.refetch() : Promise.resolve(),
      user ? ordersQuery.refetch() : Promise.resolve(),
    ]);
  };

  const refreshPrivateBilling = async (
    capturedSubscriptionKey: typeof subscriptionKey,
    capturedOrdersKey: typeof ordersKey,
  ) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: capturedSubscriptionKey }),
      queryClient.invalidateQueries({ queryKey: capturedOrdersKey }),
    ]);
  };

  const buyMutation = useMutation({
    mutationFn: async ({ kind, skuId }: { kind: 'plan' | 'credits'; skuId: string }) => {
      const requestUserId = billingUserId.current;
      const keyName = `${kind}:${skuId}`;
      let idempotencyKey = checkoutKeys.current.get(keyName);
      if (!idempotencyKey) {
        idempotencyKey = crypto.randomUUID();
        checkoutKeys.current.set(keyName, idempotencyKey);
      }
      const { item, payUrl } = await billingApi.checkout(kind, skuId, idempotencyKey);
      const stillSameUser = billingUserId.current === requestUserId;
      const mock = Boolean(catalogueQuery.data?.gateway.mock);
      if (stillSameUser && mock) {
        // Exercise the same signed webhook and idempotent crediting path used
        // by a real gateway rather than crediting from the browser response.
        await billingApi.mockPay(item.id);
        await refreshUser();
      } else if (stillSameUser && payUrl) {
        window.location.assign(payUrl);
      }
      if (checkoutKeys.current.get(keyName) === idempotencyKey) {
        checkoutKeys.current.delete(keyName);
      }
      return { item, mock: stillSameUser && mock };
    },
    onMutate: () => {
      setError(null);
      setNotice(null);
      return { requestUserId: viewerId, subscriptionKey, ordersKey };
    },
    onSuccess: async ({ item, mock }, _variables, context) => {
      if (billingUserId.current === context.requestUserId) {
        setNotice(
          mock
            ? t('billing_received', { name: item.skuName, credits: number(item.credits) })
            : t('billing_order_created', { name: item.skuName }),
        );
      }
      await refreshPrivateBilling(context.subscriptionKey, context.ordersKey);
    },
    onError: (err, _variables, context) => {
      if (billingUserId.current === context?.requestUserId) {
        setError(err instanceof Error ? err.message : t('billing_order_failed'));
      }
    },
  });

  const mockPayMutation = useMutation({
    mutationFn: async ({ orderId }: { orderId: string; skuId: string }) => {
      await billingApi.mockPay(orderId);
      await refreshUser();
    },
    onMutate: () => {
      setError(null);
      return { requestUserId: viewerId, subscriptionKey, ordersKey };
    },
    onSuccess: (_data, _variables, context) =>
      refreshPrivateBilling(context.subscriptionKey, context.ordersKey),
    onError: (err, _variables, context) => {
      if (billingUserId.current === context?.requestUserId) {
        setError(err instanceof Error ? err.message : t('billing_payment_failed'));
      }
    },
  });

  const plans: PlanDto[] = catalogueQuery.data?.plans ?? [];
  const packs: CreditPackDto[] = catalogueQuery.data?.packs ?? [];
  const gateway = catalogueQuery.data?.gateway ?? null;
  const sub: SubscriptionDto | null = subscriptionQuery.data ?? null;
  const orders: OrderDto[] = ordersQuery.data?.items ?? [];
  const loadEarlierOrders = async () => {
    const cursor = ordersQuery.data?.nextCursor;
    if (!cursor || loadingEarlier.current) return;
    const requestOrdersKey = ordersKey;
    const requestUserId = viewerId;
    const requestSeq = ordersRequestSeq.current;
    loadingEarlier.current = true;
    try {
      const page = await listOrderPage({
        limit: HISTORY_PAGE_SIZE,
        before: cursor.createdAt,
        beforeId: cursor.id,
      });
      if (ordersRequestSeq.current !== requestSeq) return;
      queryClient.setQueryData<{ items: OrderDto[]; nextCursor: HistoryCursor | null }>(
        requestOrdersKey,
        (previous) => ({
          items: appendGenerationPage(previous?.items ?? [], page.items),
          nextCursor: page.nextCursor,
        }),
      );
    } catch (err) {
      if (ordersRequestSeq.current !== requestSeq) return;
      if (billingUserId.current === requestUserId) {
        setError(err instanceof Error ? err.message : t('billing_load_failed'));
      }
    } finally {
      if (ordersRequestSeq.current === requestSeq) loadingEarlier.current = false;
    }
  };
  const busySku = buyMutation.isPending
    ? buyMutation.variables?.skuId
    : mockPayMutation.isPending
      ? mockPayMutation.variables?.skuId
      : null;
  const queryError = catalogueQuery.error ?? subscriptionQuery.error ?? ordersQuery.error;
  const displayError =
    error ?? (queryError instanceof Error ? queryError.message : queryError ? t('billing_load_failed') : null);
  const loading = catalogueQuery.isLoading || (Boolean(user) && (subscriptionQuery.isLoading || ordersQuery.isLoading));
  const refreshing = catalogueQuery.isFetching || subscriptionQuery.isFetching || ordersQuery.isFetching;

  if (status === 'loading' || loading) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <Loader2
          role="status"
          aria-label={t('billing_loading')}
          className="size-6 animate-spin text-muted-foreground"
        />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="text-center">
          <Crown className="mx-auto mb-3 size-10 text-muted-foreground" />
          <p className="mb-3 text-sm text-muted-foreground">{t('billing_login_prompt')}</p>
          <Button variant="brand" onClick={openLogin}>
            {t('login')}
          </Button>
        </div>
      </main>
    );
  }

  const currentPlanId = sub?.plan.id ?? 'free';

  return (
    <main className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{t('billing_title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('billing_subtitle')}</p>
          </div>
          <Button onClick={() => void refreshBilling()} disabled={refreshing}>
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
            {refreshing ? t('billing_refreshing') : t('billing_refresh')}
          </Button>
        </div>

        {displayError && (
          <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {displayError}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400"
          >
            {notice}
          </p>
        )}

        {ownerOnly && (
          <p className="rounded-lg border border-stone-300 bg-stone-100 px-3 py-2 text-sm text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
            {t('billing_owner_only')}
          </p>
        )}

        {gateway?.mock && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            {t('billing_mock_gateway')}
          </p>
        )}

        {/* 当前权益 */}
        {sub && (
          <section className="rounded-xl border border-stone-200 bg-card p-4 dark:border-stone-800">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground">{t('billing_current_plan')}</p>
                <p className="mt-1 flex items-center gap-2 text-lg font-semibold">
                  <Crown className="size-4 text-[#9b6bff]" />
                  {sub.plan.name}
                  {sub.planExpiresAt && sub.plan.id !== 'free' && (
                    <Tag>{t('billing_until', { time: fmtTime(sub.planExpiresAt) })}</Tag>
                  )}
                </p>
              </div>
              <div className="flex gap-6 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">{t('billing_concurrency')}</p>
                  <p className="mt-0.5 tabular-nums">
                    {sub.activeTasks} / {sub.plan.maxConcurrent}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('billing_max_video')}</p>
                  <p className="mt-0.5 tabular-nums">{t('billing_seconds', { count: sub.plan.maxDuration })}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('billing_credit_balance')}</p>
                  <p className="mt-0.5 tabular-nums text-[#f5c451]">{number(user.credits)}</p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* 套餐 */}
        <section>
          <h2 className="mb-3 text-sm font-semibold">{t('billing_plans')}</h2>
          <div className="grid gap-3 md:grid-cols-3">
            {plans.map((p) => {
              const current = p.id === currentPlanId;
              const busy = busySku === p.id;
              const watermark = planWatermarkState(p.features);
              return (
                <div
                  key={p.id}
                  className={cn(
                    'flex flex-col rounded-xl border p-4 transition',
                    current ? 'border-[#7b4aff] bg-[#7b4aff]/5' : 'border-stone-200 bg-card dark:border-stone-800',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">{p.name}</h3>
                    {current && <Tag className="border-[#7b4aff]/40 text-[#7b4aff]">{t('billing_current')}</Tag>}
                  </div>
                  <p className="mt-2 text-2xl font-bold tabular-nums">
                    {p.priceCents === 0 ? t('billing_free') : yuan(p.priceCents)}
                    {p.priceCents > 0 && (
                      <span className="text-xs font-normal text-muted-foreground"> {t('billing_per_month')}</span>
                    )}
                  </p>
                  <ul className="mt-3 flex-1 space-y-1.5 text-xs text-muted-foreground">
                    <li className="flex items-center gap-1.5">
                      <Zap className="size-3 text-[#9b6bff]" />
                      {t('billing_concurrent_tasks', { count: p.maxConcurrent })}
                    </li>
                    <li className="flex items-center gap-1.5">
                      <Sparkles className="size-3 text-[#9b6bff]" />
                      {p.monthlyCredits
                        ? t('billing_credits_per_month', { count: number(p.monthlyCredits) })
                        : t('billing_pay_as_you_go')}
                    </li>
                    <li className="flex items-center gap-1.5">
                      <Check className="size-3 text-[#9b6bff]" />
                      {t('billing_max_video_seconds', { count: p.maxDuration })}
                    </li>
                    <li className="flex items-center gap-1.5">
                      <Check className="size-3 text-[#9b6bff]" />
                      {t('billing_requests_per_minute', { count: p.rpm })}
                    </li>
                    {watermark !== null && (
                      <li className="flex items-center gap-1.5">
                        <Check className="size-3 text-[#9b6bff]" />
                        {t(watermark ? 'billing_watermark_on' : 'billing_watermark_off')}
                      </li>
                    )}
                  </ul>
                  <Button
                    className="mt-4 w-full"
                    variant={current ? 'outline' : 'brand'}
                    disabled={ownerOnly || current || p.priceCents === 0 || busy}
                    aria-busy={busy}
                    aria-label={busy ? t('billing_subscribing', { name: p.name }) : undefined}
                    onClick={() => buyMutation.mutate({ kind: 'plan', skuId: p.id })}
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : current ? (
                      t('billing_in_use')
                    ) : p.priceCents === 0 ? (
                      t('billing_default_plan')
                    ) : (
                      t('billing_subscribe', { price: yuan(p.priceCents) })
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        </section>

        {/* 充值包 */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Coins className="size-4" />
            {t('billing_top_up')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {packs.map((p) => {
              const busy = busySku === p.id;
              const total = p.credits + p.bonus;
              return (
                <div
                  key={p.id}
                  className="flex flex-col rounded-xl border border-stone-200 bg-card p-4 dark:border-stone-800"
                >
                  <h3 className="text-sm font-medium">{p.name}</h3>
                  <p className="mt-2 text-xl font-bold tabular-nums text-[#f5c451]">
                    {number(total)}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">{t('billing_credits')}</span>
                  </p>
                  {p.bonus > 0 && (
                    <p className="mt-0.5 text-[11px] text-emerald-500">
                      {t('billing_bonus', { count: number(p.bonus) })}
                    </p>
                  )}
                  <p className="mt-2 text-sm text-muted-foreground tabular-nums">{yuan(p.priceCents)}</p>
                  <Button
                    className="mt-3 w-full"
                    disabled={ownerOnly || busy}
                    aria-busy={busy}
                    aria-label={busy ? t('billing_buying', { name: p.name }) : undefined}
                    onClick={() => buyMutation.mutate({ kind: 'credits', skuId: p.id })}
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : t('billing_buy')}
                  </Button>
                </div>
              );
            })}
          </div>
        </section>

        {/* 订单 */}
        <section className="rounded-lg border border-stone-200 bg-card dark:border-stone-800">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Receipt className="size-4" />
            <h2 className="text-sm font-semibold">{t('billing_orders')}</h2>
            <span className="text-xs text-muted-foreground">
              {t('billing_recent_orders', { count: orders.length })}
            </span>
          </div>
          {orders.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('billing_no_orders')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {orders.map((o) => (
                <li key={o.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate">
                      {o.skuName}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {o.kind === 'plan' ? t('billing_order_plan') : t('billing_order_credits')}
                      </span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {fmtTime(o.createdAt)} · {o.id.slice(0, 8)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tabular-nums">{yuan(o.amountCents)}</p>
                    <p className={cn('text-[11px]', STATUS_TONE[o.status])}>{t(STATUS_KEY[o.status])}</p>
                  </div>
                  {o.status === 'pending' && gateway?.mock && (
                    <Button
                      size="sm"
                      onClick={() => mockPayMutation.mutate({ orderId: o.id, skuId: o.skuId })}
                      disabled={ownerOnly || busySku === o.skuId}
                    >
                      {t('billing_complete_payment')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {ordersQuery.data?.nextCursor && (
            <div className="border-t border-border px-4 py-3 text-center">
              <Button size="sm" onClick={() => void loadEarlierOrders()}>
                {t('admin_audit_hint')}
              </Button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
