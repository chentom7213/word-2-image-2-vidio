import { useEffect, useRef, useState } from 'react';
import { MessageSquare, History, Plus, Paperclip, ArrowUp, Bot, Sparkles, ChevronsRight } from 'lucide-react';
import { Switch } from './ui/Switch';
import { cn, uid } from '../lib/utils';
import { useAuth } from '../lib/auth';
import { useI18n, type Locale } from '../lib/i18n';
import type { ChatMessage } from '../lib/types';

type Translate = ReturnType<typeof useI18n>['t'];

function mockReply(input: string, locale: Locale, t: Translate): string {
  const text = input.trim();
  const video = locale === 'zh' ? /视频|短片|镜头|运镜/ : /video|clip|shot|camera/i;
  const image = locale === 'zh' ? /图|海报|封面/ : /image|poster|cover|picture|photo/i;
  if (video.test(text)) return t('agent_reply_video');
  if (image.test(text)) return t('agent_reply_image');
  return t('agent_reply_default', { text });
}

export function AgentPanel({ onClose }: { onClose: () => void }) {
  const { locale, t } = useI18n();
  const { user } = useAuth();
  const [tab, setTab] = useState<'chat' | 'history'>('chat');
  const [toolConfirm, setToolConfirm] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    { id: 'greet', role: 'assistant', content: t('agent_greeting') },
  ]);
  const userId = user?.id || 'guest';
  const [input, setInput] = useState('');
  const [width, setWidth] = useState(440);
  const [seenUserId, setSeenUserId] = useState(userId);
  const chatEpoch = useRef(0);
  const epochUserId = useRef(userId);
  const dragging = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  if (userId !== seenUserId) {
    setSeenUserId(userId);
    setMessages([{ id: 'greet', role: 'assistant', content: t('agent_greeting') }]);
    setInput('');
    if (epochUserId.current !== userId) {
      epochUserId.current = userId;
      chatEpoch.current += 1;
    }
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const w = window.innerWidth - e.clientX;
      setWidth(Math.min(600, Math.max(320, w)));
    };
    const onUp = () => (dragging.current = false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    const epoch = chatEpoch.current;
    const userMsg: ChatMessage = { id: uid(), role: 'user', content: text };
    const pendingId = uid();
    setMessages((m) => [...m, userMsg, { id: pendingId, role: 'assistant', content: '', pending: true }]);
    setInput('');
    setTimeout(() => {
      if (chatEpoch.current !== epoch) return;
      setMessages((m) =>
        m.map((x) => (x.id === pendingId ? { ...x, content: mockReply(text, locale, t), pending: false } : x)),
      );
    }, 900);
  };

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-card text-card-foreground"
    >
      <div
        onMouseDown={() => (dragging.current = true)}
        className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize"
      />
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg brand-gradient">
            <Bot className="size-4 text-white" />
          </span>
          <div className="min-w-0">
            <div className="text-base font-semibold leading-5">Agent</div>
            <div className="truncate text-xs text-muted-foreground">{t('agent_subtitle')}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t('agent_tool_confirm')}
            <Switch checked={toolConfirm} onChange={setToolConfirm} ariaLabel={t('agent_tool_confirm_aria')} />
          </label>
          <button
            onClick={onClose}
            aria-label={t('agent_collapse_aria')}
            className="grid size-8 place-items-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
            title={t('agent_collapse')}
          >
            <ChevronsRight className="size-4" />
          </button>
        </div>
      </header>

      <div className="border-b border-border px-3">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <nav className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto text-sm">
            <button
              onClick={() => setTab('chat')}
              className={cn(
                'inline-flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-0.5 transition',
                tab === 'chat' ? 'border-current font-medium' : 'border-transparent font-normal text-muted-foreground',
              )}
            >
              {t('agent_chat')}
            </button>
            <button
              onClick={() => setTab('history')}
              className={cn(
                'inline-flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-0.5 transition',
                tab === 'history'
                  ? 'border-current font-medium'
                  : 'border-transparent font-normal text-muted-foreground',
              )}
            >
              <History className="size-3.5" />
              {t('agent_history')}
            </button>
          </nav>
          <button
            onClick={() => setMessages([{ id: 'greet', role: 'assistant', content: t('agent_greeting') }])}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
          >
            <Plus className="size-4" />
            {t('agent_new_chat')}
          </button>
        </div>
      </div>

      {tab === 'chat' ? (
        <>
          <div ref={scrollRef} className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {messages.map((m) =>
              m.role === 'assistant' ? (
                <div key={m.id} className="flex items-start gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg brand-gradient">
                    <Sparkles className="size-4 text-white" />
                  </span>
                  <div className="min-w-0 max-w-[82%] whitespace-pre-wrap text-sm leading-6">
                    {m.pending ? (
                      <span className="inline-flex gap-1">
                        <Dot /> <Dot /> <Dot />
                      </span>
                    ) : (
                      m.content
                    )}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[82%] whitespace-pre-wrap rounded-2xl rounded-tr-sm brand-gradient px-3 py-2 text-sm leading-6 text-white">
                    {m.content}
                  </div>
                </div>
              ),
            )}
          </div>
          <div className="px-2 pb-2 pt-2">
            <div className="rounded-[24px] border border-border bg-background/60 px-3 pb-3 pt-3 shadow-lg">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={t('agent_placeholder')}
                aria-label={t('agent_input_aria')}
                className="thin-scrollbar max-h-32 min-h-20 w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-5 outline-none placeholder:opacity-45"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <button
                  className="grid size-9 place-items-center rounded-full text-muted-foreground transition hover:bg-white/5"
                  aria-label={t('agent_attach_aria')}
                >
                  <Paperclip className="size-4" />
                </button>
                <button
                  onClick={send}
                  disabled={!input.trim()}
                  aria-label={t('agent_send_aria')}
                  className="grid size-10 place-items-center rounded-full brand-gradient text-white transition hover:opacity-90 disabled:opacity-40"
                >
                  <ArrowUp className="size-5" />
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
            <MessageSquare className="size-8 opacity-40" />
            {t('agent_empty_history')}
          </div>
        </div>
      )}
    </aside>
  );
}

function Dot() {
  return <span className="inline-block size-1.5 animate-bounce rounded-full bg-current opacity-60" />;
}
