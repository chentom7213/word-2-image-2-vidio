import { useEffect, useRef, useState } from 'react';
import { Coins, ArrowUpRight, ArrowDownRight, Loader2, RefreshCw, Inbox } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { useAuth } from '../lib/auth';
import { authApi, creditApi, request, type CreditTx } from '../lib/api';
import { CREDIT_HISTORY_PAGE_SIZE, loadCreditHistory, type CreditHistoryCursor } from '../lib/credit-history';
import { appendGenerationPage, mergeGenerationPage } from '../lib/history-page';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';
import { maskEmail } from '../lib/mask-email';
import { passwordTooLongMessage } from '../lib/password-length';
import { formatUtcLocal } from '../lib/utc-time';

type DeviceSession = {
  id: string;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
};

const SESSION_PAGE_SIZE = 20;

type SessionCursor = { createdAt: string; id: string };

type CreditTotals = { gained: number; spent: number; refunded: number };

function appendSessions(loaded: DeviceSession[], nextPage: DeviceSession[]): DeviceSession[] {
  const seen = new Set(loaded.map((item) => item.id));
  const appended = nextPage.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return [...loaded, ...appended];
}

/** Device createdAt is a MySQL datetime string, so keep older rows by text order. */
function mergeDevicePage(
  loaded: DeviceSession[],
  firstPage: DeviceSession[],
): { items: DeviceSession[]; keepCursor: boolean } {
  if (loaded.length === 0 || firstPage.length < SESSION_PAGE_SIZE) {
    return { items: firstPage, keepCursor: false };
  }
  const oldest = firstPage[firstPage.length - 1];
  const seen = new Set(firstPage.map((item) => item.id));
  const older = loaded.filter((item) => {
    if (seen.has(item.id)) return false;
    if (item.createdAt < oldest.createdAt) return true;
    if (item.createdAt > oldest.createdAt) return false;
    return item.id < oldest.id;
  });
  return { items: [...firstPage, ...older], keepCursor: older.length > 0 };
}

async function loadSessions(cursor?: SessionCursor | null) {
  const search = new URLSearchParams({ limit: String(SESSION_PAGE_SIZE) });
  if (cursor) {
    search.set('before', cursor.createdAt);
    search.set('beforeId', cursor.id);
  }
  const page = await request<{
    count: number;
    items: DeviceSession[];
    nextCursor?: SessionCursor | null;
  }>(`/api/auth/sessions?${search}`);
  return { count: page.count, items: page.items, nextCursor: page.nextCursor ?? null };
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


export function AccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { user, credits, refreshUser, logout, openLogin } = useAuth();
  const [txs, setTxs] = useState<CreditTx[]>([]);
  const [nextCursor, setNextCursor] = useState<CreditHistoryCursor | null>(null);
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [sessionCursor, setSessionCursor] = useState<SessionCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const loadingEarlierRef = useRef(false);
  const loadingSessionsRef = useRef(false);
  const epochRef = useRef(0);
  /** Lists currently on screen belong to this user. A switch must not merge them. */
  const loadedUserIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [closePassword, setClosePassword] = useState('');
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeArmed, setCloseArmed] = useState(false);
  const [closeMessage, setCloseMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<CreditTotals | null>(null);

  const load = async (epoch: number = epochRef.current) => {
    const requestEpoch = epoch;
    const requestUserId = user?.id ?? null;
    const sameUser = loadedUserIdRef.current !== null && loadedUserIdRef.current === requestUserId;
    const baseTxs = sameUser ? txs : [];
    const baseCursor = sameUser ? nextCursor : null;
    const baseDevices = sameUser ? devices : [];
    const baseSessionCursor = sameUser ? sessionCursor : null;
    if (requestEpoch === epochRef.current) {
      loadingEarlierRef.current = false;
      loadingSessionsRef.current = false;
      setLoadingEarlier(false);
      setLoadingSessions(false);
    }
    setLoading(true);
    setError(null);
    const summaryPromise = creditApi
      .summary()
      .then((value) => ({
        ok: true as const,
        value: { gained: value.gained, spent: value.spent, refunded: value.refunded },
      }))
      .catch(() => ({ ok: false as const }));
    let listUpdate: {
      txs: CreditTx[];
      nextCursor: CreditHistoryCursor | null;
      devices: DeviceSession[];
      sessionCursor: SessionCursor | null;
    } | null = null;
    try {
      const [page, sessionsResult] = await Promise.all([
        loadCreditHistory({ limit: CREDIT_HISTORY_PAGE_SIZE }),
        loadSessions()
          .then((sessions) => ({ ok: true as const, sessions }))
          .catch(() => ({ ok: false as const })),
        refreshUser(),
      ]);
      const items = mergeGenerationPage(baseTxs, page.items, CREDIT_HISTORY_PAGE_SIZE);
      const keptOlderTx = items.length > page.items.length;
      let nextDevices = baseDevices;
      let nextSessionCursor = baseSessionCursor;
      if (sessionsResult.ok) {
        const mergedDevices = mergeDevicePage(baseDevices, sessionsResult.sessions.items);
        nextDevices = mergedDevices.items;
        nextSessionCursor = mergedDevices.keepCursor ? baseSessionCursor : sessionsResult.sessions.nextCursor;
      }
      listUpdate = {
        txs: items,
        nextCursor:
          page.items.length < CREDIT_HISTORY_PAGE_SIZE ? null : keptOlderTx ? baseCursor : page.nextCursor,
        devices: nextDevices,
        sessionCursor: nextSessionCursor,
      };
    } catch (err) {
      if (requestEpoch !== epochRef.current) return;
      setError(err instanceof Error ? err.message : t('account_load_failed'));
    }
    const summaryResult = await summaryPromise;
    if (requestEpoch !== epochRef.current) return;
    if (listUpdate) {
      loadedUserIdRef.current = requestUserId;
      setTxs(listUpdate.txs);
      setNextCursor(listUpdate.nextCursor);
      setDevices(listUpdate.devices);
      setSessionCursor(listUpdate.sessionCursor);
    }
    setSummary(summaryResult.ok ? summaryResult.value : null);
    setLoading(false);
  };

  useEffect(() => {
    const epoch = ++epochRef.current;
    if (open && user) {
      if (loadedUserIdRef.current !== user.id) {
        loadedUserIdRef.current = null;
        setTxs([]);
        setNextCursor(null);
        setDevices([]);
        setSessionCursor(null);
        setSummary(null);
        setError(null);
        setCurrentPassword('');
        setNewPassword('');
        setPasswordMessage(null);
        setClosePassword('');
        setCloseArmed(false);
        setCloseMessage(null);
        setPasswordBusy(false);
        setCloseBusy(false);
      }
      void load(epoch);
    } else {
      loadingEarlierRef.current = false;
      loadingSessionsRef.current = false;
      setLoadingEarlier(false);
      setLoadingSessions(false);
      setCurrentPassword('');
      setNewPassword('');
      setPasswordMessage(null);
      setClosePassword('');
      setCloseArmed(false);
      setCloseMessage(null);
      if (open) {
        loadedUserIdRef.current = null;
        setTxs([]);
        setNextCursor(null);
        setDevices([]);
        setSessionCursor(null);
        setSummary(null);
        setError(null);
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.id]);

  const loadEarlier = async () => {
    if (!nextCursor || loading || loadingEarlierRef.current) return;
    const requestEpoch = epochRef.current;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    setError(null);
    try {
      const page = await loadCreditHistory({
        limit: CREDIT_HISTORY_PAGE_SIZE,
        before: nextCursor.createdAt,
        beforeId: nextCursor.id,
      });
      if (requestEpoch !== epochRef.current) return;
      setTxs((current) => appendGenerationPage(current, page.items));
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (requestEpoch !== epochRef.current) return;
      setError(err instanceof Error ? err.message : t('account_load_failed'));
    } finally {
      if (requestEpoch === epochRef.current) {
        loadingEarlierRef.current = false;
        setLoadingEarlier(false);
      }
    }
  };

  const loadEarlierSessions = async () => {
    if (!sessionCursor || loading || loadingSessionsRef.current) return;
    const requestEpoch = epochRef.current;
    loadingSessionsRef.current = true;
    setLoadingSessions(true);
    setError(null);
    try {
      const page = await loadSessions(sessionCursor);
      if (requestEpoch !== epochRef.current) return;
      setDevices((current) => appendSessions(current, page.items));
      setSessionCursor(page.nextCursor);
    } catch (err) {
      if (requestEpoch !== epochRef.current) return;
      setError(err instanceof Error ? err.message : t('account_load_failed'));
    } finally {
      if (requestEpoch === epochRef.current) {
        loadingSessionsRef.current = false;
        setLoadingSessions(false);
      }
    }
  };

  const unsetPassword = user?.passwordSet === false;

  const changePassword = async () => {
    const requestEpoch = epochRef.current;
    setPasswordMessage(null);
    if (newPassword.length < 6) {
      setPasswordMessage(t('login_password_short'));
      return;
    }
    const tooLong = passwordTooLongMessage(newPassword) ?? passwordTooLongMessage(currentPassword);
    if (tooLong) {
      setPasswordMessage(tooLong);
      return;
    }
    if (!unsetPassword && currentPassword === newPassword) {
      setPasswordMessage(t('account_password_same'));
      return;
    }
    setPasswordBusy(true);
    try {
      await authApi.changePassword(newPassword, unsetPassword ? undefined : currentPassword);
      if (requestEpoch !== epochRef.current) return;
      setPasswordMessage(t('account_password_done'));
      logout();
      onClose();
      openLogin();
    } catch (err) {
      if (requestEpoch !== epochRef.current) return;
      setPasswordMessage(err instanceof Error ? err.message : t('account_load_failed'));
    } finally {
      if (requestEpoch === epochRef.current) {
        setPasswordBusy(false);
      }
    }
  };

  const revokeDevice = async (device: DeviceSession) => {
    const requestEpoch = epochRef.current;
    setError(null);
    try {
      await authApi.revokeSession(device.id);
      if (requestEpoch !== epochRef.current) return;
      if (device.current) {
        logout();
        onClose();
        return;
      }
      setDevices((current) => current.filter((item) => item.id !== device.id));
    } catch (err) {
      if (requestEpoch !== epochRef.current) return;
      setError(err instanceof Error ? err.message : t('account_load_failed'));
    }
  };

  const closeAccount = async () => {
    const requestEpoch = epochRef.current;
    setCloseMessage(null);
    if (!closePassword) return;
    const tooLong = passwordTooLongMessage(closePassword);
    if (tooLong) {
      setCloseMessage(tooLong);
      return;
    }
    if (!closeArmed) {
      setCloseArmed(true);
      return;
    }
    setCloseBusy(true);
    try {
      await authApi.closeAccount(closePassword);
      if (requestEpoch !== epochRef.current) return;
      logout();
      onClose();
    } catch (err) {
      if (requestEpoch !== epochRef.current) return;
      setCloseMessage(err instanceof Error ? err.message : t('account_load_failed'));
    } finally {
      if (requestEpoch === epochRef.current) {
        setCloseBusy(false);
      }
    }
  };

  const gained = summary?.gained ?? txs.filter((tx) => tx.delta > 0).reduce((sum, tx) => sum + tx.delta, 0);
  const spent = summary?.spent ?? txs.filter((tx) => tx.delta < 0).reduce((sum, tx) => sum - tx.delta, 0);
  const refunded = summary?.refunded ?? 0;

  return (
    <Modal open={open} onClose={onClose} title={t('account_title')} className="max-w-md">
      <div className="space-y-4 pb-1">
        {/* summary */}
        <div className="rounded-xl border border-[#f5c451]/30 bg-gradient-to-br from-[#241a3a] to-[#15102a] p-4 text-white">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-white/60">{t('account_current')}</p>
              <p className="mt-1 flex items-center gap-1.5 text-2xl font-bold text-[#ffd98a]">
                <Coins className="size-5" />
                {credits.toLocaleString()}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const epoch = ++epochRef.current;
                void load(epoch);
              }}
              disabled={loading}
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span className="text-emerald-300">{t('account_earned', { amount: gained.toLocaleString() })}</span>
            <span className="text-red-300">{t('account_spent', { amount: spent.toLocaleString() })}</span>
            <span className="text-sky-300">{t('account_refunded', { amount: refunded.toLocaleString() })}</span>
          </div>
          {user && <p className="mt-2 truncate text-[11px] text-white/50">{maskEmail(user.email)}</p>}
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {loading && txs.length === 0 ? (
          <div className="grid place-items-center py-12 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : txs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Inbox className="size-6" />
            {t('account_empty')}
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {txs.map((tx) => {
              const positive = tx.delta >= 0;
              return (
                <li key={tx.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span
                    className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-full',
                      positive ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
                    )}
                  >
                    {positive ? <ArrowUpRight className="size-4" /> : <ArrowDownRight className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{tx.reason}</p>
                    <p className="text-[11px] text-muted-foreground">{fmtTime(tx.createdAt)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={cn('text-sm font-semibold', positive ? 'text-emerald-400' : 'text-red-400')}>
                      {positive ? '+' : ''}
                      {tx.delta.toLocaleString()}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {t('account_balance', { amount: tx.balanceAfter.toLocaleString() })}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {nextCursor && (
          <div className="text-center">
            <Button type="button" size="sm" onClick={() => void loadEarlier()} disabled={loading || loadingEarlier}>
              {t('admin_audit_hint')}
            </Button>
          </div>
        )}

        <form
          className="space-y-2 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void changePassword();
          }}
        >
          {unsetPassword ? (
            <p className="text-xs text-muted-foreground">{t('account_password_unset_hint')}</p>
          ) : (
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">{t('account_password_current')}</span>
              <input
                className="w-full rounded-md border border-border bg-background px-2 py-1.5"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">{t('account_password_new')}</span>
            <input
              className="w-full rounded-md border border-border bg-background px-2 py-1.5"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          {passwordMessage && <p className="text-sm text-red-400">{passwordMessage}</p>}
          <Button type="submit" size="sm" disabled={passwordBusy || !newPassword || (!unsetPassword && !currentPassword)}>
            {t(unsetPassword ? 'account_password_set_save' : 'account_password_save')}
          </Button>
        </form>

        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">{t('account_sessions_title')}</p>
          {devices.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('account_sessions_empty')}</p>
          ) : (
            <ul className="space-y-2">
              {devices.map((device) => (
                <li key={device.id} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {formatUtcLocal(device.createdAt)}
                    {device.ip ? ` · ${device.ip}` : ''}
                    {device.userAgent ? ` · ${device.userAgent}` : ''}
                    {device.current ? ` · ${t('account_sessions_current')}` : ''}
                  </span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => void revokeDevice(device)}>
                    {t('account_sessions_revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {sessionCursor && (
            <div className="text-center">
              <Button
                type="button"
                size="sm"
                onClick={() => void loadEarlierSessions()}
                disabled={loading || loadingSessions}
              >
                {t('admin_audit_hint')}
              </Button>
            </div>
          )}
        </div>

        <form
          className="space-y-2 rounded-lg border border-red-500/30 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void closeAccount();
          }}
        >
          <p className="text-sm font-medium text-red-400">{t('account_close_title')}</p>
          <p className="text-xs text-muted-foreground">{t('account_close_hint')}</p>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">{t('account_password_current')}</span>
            <input
              className="w-full rounded-md border border-border bg-background px-2 py-1.5"
              type="password"
              autoComplete="current-password"
              value={closePassword}
              onChange={(event) => {
                setClosePassword(event.target.value);
                setCloseArmed(false);
              }}
            />
          </label>
          {closeMessage && <p className="text-sm text-red-400">{closeMessage}</p>}
          <Button type="submit" size="sm" variant="danger" disabled={closeBusy || !closePassword}>
            {closeArmed ? t('account_close_confirm') : t('account_close_submit')}
          </Button>
        </form>

        <p className="pb-1 text-center text-[11px] text-muted-foreground">
          {t('account_recent', { count: txs.length })}
        </p>
      </div>
    </Modal>
  );
}
