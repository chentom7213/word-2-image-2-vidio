import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { API_BASE, ApiClientError, authApi, cancelStaleSessionResponses, clearActiveOrgStorage, getToken, setToken, tryRefresh, type ApiUser } from './api';
import { refreshDelayMs } from './refresh-schedule';
import { ssoJustSucceeded, stripSsoParam } from './sso-return';

export type AuthUser = ApiUser;
export type AuthStatus = 'loading' | 'authed' | 'guest';

type AuthCtx = {
  user: AuthUser | null;
  status: AuthStatus;
  credits: number;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  oidcEnabled: boolean;
  startEnterpriseSso: () => void;
  /** global login modal control */
  loginOpen: boolean;
  openLogin: () => void;
  closeLogin: () => void;
};

const Ctx = createContext<AuthCtx | null>(null);

let logoutRequest: AbortController | null = null;
let credentialEpoch = 0;
let credentialRequest: AbortController | null = null;

function beginCredentialRequest(): { epoch: number; signal: AbortSignal } {
  credentialRequest?.abort();
  credentialEpoch += 1;
  const controller = new AbortController();
  credentialRequest = controller;
  return { epoch: credentialEpoch, signal: controller.signal };
}

function cancelLogoutRequest() {
  logoutRequest?.abort();
  logoutRequest = null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [loginOpen, setLoginOpen] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const refreshTimer = useRef<number | null>(null);
  const seenUserId = useRef<string | null>(null);
  const userId = user?.id ?? null;
  if (seenUserId.current !== userId) {
    const previousUserId = seenUserId.current;
    // Before GenerationProvider reads the workspace. A first sign-in still
    // keeps the stored org; only leaving a real account drops it.
    // eslint-disable-next-line react-hooks/refs
    seenUserId.current = userId;
    if (previousUserId) clearActiveOrgStorage();
  }

  const openLogin = useCallback(() => setLoginOpen(true), []);
  const closeLogin = useCallback(() => setLoginOpen(false), []);
  const startEnterpriseSso = useCallback(() => {
    cancelLogoutRequest();
    cancelStaleSessionResponses();
    beginCredentialRequest();
    window.location.assign(`${API_BASE}/api/auth/oidc/start`);
  }, []);

  const clearSession = useCallback(() => {
    setToken(null);
    setUser(null);
    setStatus('guest');
    if (refreshTimer.current) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  const refreshUser = useCallback(async () => {
    if (!getToken()) return;
    const startedUserId = seenUserId.current;
    try {
      const { user: u } = await authApi.me();
      if (seenUserId.current !== startedUserId) return;
      setUser(u);
      setStatus('authed');
    } catch {
      // The request layer already attempted a silent refresh; reaching here
      // means the session is genuinely dead.
      if (seenUserId.current !== startedUserId) return;
      clearSession();
    }
  }, [clearSession]);

  /** Schedules the next silent token exchange so a session never just expires. */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    const delay = refreshDelayMs(getToken());
    // Already inside the two-minute window: refresh now, but don't spin if the
    // replacement token is still inside that window.
    const wait = delay > 0 ? delay : 0;
    refreshTimer.current = window.setTimeout(async () => {
      const startedUserId = seenUserId.current;
      const previous = getToken();
      const ok = await tryRefresh();
      if (seenUserId.current !== startedUserId) return;
      const currentToken = getToken();
      if (!ok) {
        if (currentToken && currentToken !== previous) return;
        clearSession();
        return;
      }
      if (refreshDelayMs(getToken()) <= 0 && getToken() === previous) {
        refreshTimer.current = window.setTimeout(() => scheduleRefresh(), 30_000);
        return;
      }
      scheduleRefresh();
    }, wait);
  }, [clearSession]);

  // Bootstrap: hand off to the refresh cookie first — it survives a page reload
  // and browser restart, unlike the in-memory/localStorage access token.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // A leftover access token would keep the previous user after SSO.
      if (ssoJustSucceeded(window.location.search)) {
        setToken(null);
        const next = stripSsoParam(window.location.href);
        window.history.replaceState(window.history.state, '', next);
      }
      if (getToken()) {
        await refreshUser();
      } else {
        const startedUserId = seenUserId.current;
        const ok = await tryRefresh();
        if (cancelled || seenUserId.current !== startedUserId) return;
        if (!ok) {
          setStatus('guest');
          return;
        }
        await refreshUser();
      }
      if (!cancelled && getToken()) scheduleRefresh();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // This endpoint exposes only whether SSO is ready, never IdP credentials.
  useEffect(() => {
    void authApi
      .oidcConfig()
      .then((config) => setOidcEnabled(config.enabled))
      .catch(() => setOidcEnabled(false));
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      cancelLogoutRequest();
      cancelStaleSessionResponses();
      const attempt = beginCredentialRequest();
      const { token, user: u } = await authApi.login(email, password, attempt.signal);
      if (attempt.epoch !== credentialEpoch) throw new ApiClientError('登录已取消', 0, 'ABORTED');
      setToken(token);
      setUser(u);
      setStatus('authed');
      setLoginOpen(false);
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  const register = useCallback(
    async (email: string, password: string) => {
      cancelLogoutRequest();
      cancelStaleSessionResponses();
      const attempt = beginCredentialRequest();
      const { token, user: u } = await authApi.register(email, password, attempt.signal);
      if (attempt.epoch !== credentialEpoch) throw new ApiClientError('登录已取消', 0, 'ABORTED');
      setToken(token);
      setUser(u);
      setStatus('authed');
      setLoginOpen(false);
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  const logout = useCallback(() => {
    // Revoke server-side too, otherwise the refresh cookie stays valid.
    // The bearer is the token from this click, so a newer login is not revoked.
    beginCredentialRequest();
    cancelLogoutRequest();
    cancelStaleSessionResponses();
    const controller = new AbortController();
    logoutRequest = controller;
    const token = getToken();
    void authApi.logout(token, controller.signal).catch(() => {});
    clearSession();
  }, [clearSession]);

  return (
    <Ctx.Provider
      value={{
        user,
        status,
        credits: user?.credits ?? 0,
        login,
        register,
        logout,
        refreshUser,
        oidcEnabled,
        startEnterpriseSso,
        loginOpen,
        openLogin,
        closeLogin,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
