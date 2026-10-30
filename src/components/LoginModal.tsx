import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Building2, Loader2, Lock, LogIn, Mail, UserPlus, Zap } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { useAuth } from '../lib/auth';
import { ApiClientError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { emailTooLongMessage } from '../lib/email-length';
import { passwordTooLongMessage } from '../lib/password-length';
import { cn } from '../lib/utils';

type Mode = 'login' | 'register';

const DEMO_EMAIL = 'demo@benchu.art';
const DEMO_PASSWORD = 'demo1234';

/**
 * Global login dialog. Visibility is owned by AuthProvider so any page
 * can call `openLogin()` without prop-drilling.
 */
export function LoginModal() {
  const { user, login, register, loginOpen, closeLogin, oidcEnabled, startEnterpriseSso } = useAuth();
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = user?.id ?? null;
  const previousUserId = useRef(userId);
  const loginWasOpen = useRef(loginOpen);
  const currentUserId = useRef<string | null>(userId);
  currentUserId.current = userId;
  const submitId = useRef(0);

  useEffect(() => {
    if (loginWasOpen.current && !loginOpen) {
      setPassword('');
      setError(null);
    }
    loginWasOpen.current = loginOpen;
  }, [loginOpen]);

  useEffect(() => {
    if (previousUserId.current === userId) return;
    previousUserId.current = userId;
    submitId.current += 1;
    setEmail('');
    setPassword('');
    setError(null);
    setLoading(false);
  }, [userId]);

  const submit = async () => {
    if (loading) return;
    const submittedUserId = currentUserId.current;
    const requestId = ++submitId.current;
    setError(null);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(t('login_invalid_email'));
      return;
    }
    const emailTooLong = emailTooLongMessage(email);
    if (emailTooLong) {
      setError(emailTooLong);
      return;
    }
    if (password.length < 6) {
      setError(t('login_password_short'));
      return;
    }
    const tooLong = passwordTooLongMessage(password);
    if (tooLong) {
      setError(tooLong);
      return;
    }

    setLoading(true);
    try {
      if (mode === 'login') await login(email.trim().toLowerCase(), password);
      else await register(email.trim().toLowerCase(), password);
      if (submitId.current !== requestId) return;
      setPassword('');
      closeLogin();
    } catch (err) {
      if (submitId.current !== requestId || currentUserId.current !== submittedUserId) return;
      if (err instanceof ApiClientError && err.code === 'ABORTED') return;
      if (err instanceof ApiClientError) {
        setError(err.code === 'NETWORK' ? t('login_network') : err.message);
      } else {
        setError(t('login_action_failed'));
      }
    } finally {
      if (submitId.current === requestId) setLoading(false);
    }
  };

  const fillDemo = () => {
    setMode('login');
    setEmail(DEMO_EMAIL);
    setPassword(DEMO_PASSWORD);
    setError(null);
  };

  return (
    <Modal
      open={loginOpen}
      onClose={closeLogin}
      title={mode === 'login' ? t('login') : t('login_register_account')}
      className="max-w-sm"
    >
      <div className="space-y-4 pb-2">
        <div className="flex rounded-lg border border-stone-300 p-0.5 dark:border-stone-700">
          {(['login', 'register'] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={cn(
                'flex-1 rounded-md py-1.5 text-sm font-medium transition',
                mode === m
                  ? 'bg-stone-900 text-white dark:bg-white dark:text-stone-900'
                  : 'text-stone-500 hover:text-stone-800 dark:hover:text-stone-200',
              )}
            >
              {m === 'login' ? t('login') : t('login_register')}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">{t('login_email')}</span>
          <div className="flex h-10 items-center gap-2 rounded-lg border border-stone-300 px-3 focus-within:border-stone-500 dark:border-stone-700 dark:focus-within:border-stone-500">
            <Mail className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              placeholder="you@example.com"
              type="email"
              autoComplete="email"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </div>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">{t('login_password')}</span>
          <div className="flex h-10 items-center gap-2 rounded-lg border border-stone-300 px-3 focus-within:border-stone-500 dark:border-stone-700 dark:focus-within:border-stone-500">
            <Lock className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              placeholder={t('login_password_placeholder')}
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </div>
        </label>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-400">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button variant="brand" size="lg" className="mt-2" disabled={loading} onClick={submit}>
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : mode === 'login' ? (
            <LogIn className="size-4" />
          ) : (
            <UserPlus className="size-4" />
          )}
          {loading ? t('login_wait') : mode === 'login' ? t('login') : t('login_register_submit')}
        </Button>

        <button
          onClick={fillDemo}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-stone-300 py-2 text-xs text-muted-foreground transition hover:border-[#9b6bff]/60 hover:text-[#9b6bff] dark:border-stone-700"
        >
          <Zap className="size-3.5" />
          {t('login_demo', { email: DEMO_EMAIL, password: DEMO_PASSWORD })}
        </button>

        {oidcEnabled && (
          <button
            onClick={startEnterpriseSso}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-stone-300 py-2 text-xs font-medium transition hover:border-[#9b6bff]/60 hover:text-[#9b6bff] dark:border-stone-700"
          >
            <Building2 className="size-3.5" /> {t('login_sso')}
          </button>
        )}

        <p className="text-center text-xs text-muted-foreground">
          {t('login_consent')} <span className="text-[#9b6bff]">{t('login_terms')}</span> {t('login_and')}{' '}
          <span className="text-[#9b6bff]">{t('login_privacy')}</span>
        </p>
      </div>
    </Modal>
  );
}
