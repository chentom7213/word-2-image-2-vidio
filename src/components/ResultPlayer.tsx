import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Pause, Play, RotateCw, Repeat, Maximize2, AlertTriangle, ExternalLink, X } from 'lucide-react';
import type { Generation, GenerationOutput } from '../lib/types';
import { displayFrame } from '../lib/display-frame';
import { outputExtension } from '../lib/output-extension';
import { pairImageThumbnails } from '../lib/output-thumbs';
import { ownsGeneration } from '../lib/delete-result';
import { useGenerations } from '../lib/generation';
import { useI18n } from '../lib/i18n';
import { cn, formatBytes, seedGradient } from '../lib/utils';
import { Button } from './ui/Button';

/**
 * Placeholder surface shown while a task is rendering (or when a historical
 * task has no artifact). Deterministic per seed so it doesn't flicker.
 */
export function SeedPoster({ seed, className, label }: { seed: string; className?: string; label?: string }) {
  return (
    <div
      className={cn('relative grid size-full place-items-center', className)}
      style={{ background: seedGradient(seed) }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_25%,rgba(255,255,255,0.35),transparent_55%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_75%,rgba(0,0,0,0.35),transparent_60%)]" />
      {label && (
        <span className="relative rounded bg-black/40 px-2 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur">
          {label}
        </span>
      )}
    </div>
  );
}

function videoOf(gen: Generation): GenerationOutput | undefined {
  return gen.outputs.find((o) => o.kind === 'video');
}

function imagesOf(gen: Generation): GenerationOutput[] {
  return gen.outputs.filter((o) => o.kind === 'image');
}

function artifactFrame(width: number | null, height: number | null): { width: number; height: number } | null {
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function downloadName(gen: Generation, out: GenerationOutput, index: number) {
  const safeModel = gen.modelName.replace(/[\\/:*?"<>|\s]+/g, '-');
  const ext = outputExtension(out.mime, out.kind);
  return `${safeModel}-${gen.id.slice(0, 8)}-${index + 1}.${ext}`;
}

/** Real <video> player for a finished generation. */
export function VideoResult({ gen }: { gen: Generation }) {
  const { t: translate } = useI18n();
  const video = videoOf(gen);
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(gen.duration || video?.duration || 0);
  const [seenGenId, setSeenGenId] = useState(gen.id);
  const wrapRef = useRef<HTMLDivElement>(null);
  const genIdRef = useRef(gen.id);
  // Current before a detached media event writes the previous task's position.
  // eslint-disable-next-line react-hooks/refs
  genIdRef.current = gen.id;
  if (gen.id !== seenGenId) {
    setSeenGenId(gen.id);
    setPlaying(true);
    setT(0);
    setDuration(gen.duration || video?.duration || 0);
  }

  if (!video) return null;

  const frame = artifactFrame(video.width, video.height) ?? displayFrame('video', gen.width, gen.height);
  const pct = duration > 0 ? Math.min(100, (t / duration) * 100) : 0;
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  const fullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const seekMax = Number.isFinite(duration) && duration > 0 ? duration : 0;

  const seekTo = (next: number) => {
    const el = ref.current;
    if (!el || seekMax <= 0) return;
    const clamped = Math.min(seekMax, Math.max(0, next));
    el.currentTime = clamped;
    setT(clamped);
  };

  const onSeekKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const current = ref.current?.currentTime ?? t;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seekTo(current - 5);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      seekTo(current + 5);
    } else if (e.key === 'Home') {
      e.preventDefault();
      seekTo(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      seekTo(seekMax);
    }
  };

  return (
    <div
      ref={wrapRef}
      className="group relative mx-auto w-full overflow-hidden rounded-xl bg-black"
      style={{ maxWidth: frame.width >= frame.height ? '100%' : '340px' }}
    >
      <video
        key={gen.id}
        ref={ref}
        src={video.url}
        poster={gen.posterUrl ?? undefined}
        autoPlay
        loop
        playsInline
        controls={false}
        className="block w-full"
        style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
        onLoadedMetadata={(e) => {
          if (genIdRef.current !== gen.id) return;
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onTimeUpdate={(e) => {
          if (genIdRef.current !== gen.id) return;
          setT(e.currentTarget.currentTime);
        }}
        onPlay={() => {
          if (genIdRef.current === gen.id) setPlaying(true);
        }}
        onPause={() => {
          if (genIdRef.current === gen.id) setPlaying(false);
        }}
      />

      <div className="pointer-events-none absolute left-2 top-2 flex gap-1.5">
        <span className="rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur">
          {gen.modelName}
        </span>
        <span className="rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur">
          {frame.width}×{frame.height}
        </span>
        <span className="rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur">
          {translate('result_ai')}
        </span>
      </div>

      {!playing && (
        <button
          onClick={toggle}
          aria-label={translate('result_play')}
          className="absolute inset-0 grid place-items-center"
        >
          <span className="grid size-14 place-items-center rounded-full bg-white/20 backdrop-blur transition hover:scale-105">
            <Play className="size-6 translate-x-0.5 text-white" fill="white" />
          </span>
        </button>
      )}

      <button
        onClick={fullscreen}
        title={translate('result_fullscreen')}
        aria-label={translate('result_fullscreen')}
        className="absolute bottom-11 right-2 grid size-7 place-items-center rounded bg-black/50 text-white/80 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Maximize2 className="size-3.5" />
      </button>

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-6">
        <button
          onClick={toggle}
          aria-label={playing ? translate('result_pause') : translate('result_play')}
          className="grid size-7 place-items-center text-white"
        >
          {playing ? <Pause className="size-4" fill="white" /> : <Play className="size-4" fill="white" />}
        </button>
        <span className="shrink-0 text-[11px] tabular-nums text-white/80">
          {fmt(t)} / {fmt(duration)}
        </span>
        <div
          role="slider"
          tabIndex={0}
          aria-label={translate('result_seek')}
          aria-valuemin={0}
          aria-valuemax={seekMax}
          aria-valuenow={t}
          className="relative h-1 flex-1 cursor-pointer rounded-full bg-white/25"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            seekTo(ratio * seekMax);
          }}
          onKeyDown={onSeekKeyDown}
        >
          <div className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${pct}%` }} />
        </div>
        <Repeat className="size-3.5 text-white/70" />
      </div>
    </div>
  );
}

/** Grid of real generated stills. A following thumbnail is only the cell preview. */
export function ImageResults({ gen, columns = 2 }: { gen: Generation; columns?: number }) {
  const { t } = useI18n();
  const images = pairImageThumbnails(gen.outputs);
  const [active, setActive] = useState<GenerationOutput | null>(null);
  const [seenGenId, setSeenGenId] = useState(gen.id);
  const dialogRef = useRef<HTMLDivElement>(null);
  if (gen.id !== seenGenId) {
    setSeenGenId(gen.id);
    setActive(null);
  }
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActive(null);
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [active]);

  if (images.length === 0) return null;

  return (
    <>
      <div className={cn('grid gap-3', columns === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
        {images.map(({ image: out, gridUrl }, i) => {
          const frame = artifactFrame(out.width, out.height) ?? displayFrame('image', gen.width, gen.height);
          return (
            <div
              key={out.id}
              className="group relative overflow-hidden rounded-xl border border-stone-200 bg-black/20 dark:border-stone-800"
              style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
            >
              <button
                type="button"
                onClick={() => setActive(out)}
                className="block size-full cursor-pointer border-0 bg-transparent p-0"
              >
                <img
                  src={gridUrl}
                  alt={`${gen.prompt} #${i + 1}`}
                  className="size-full object-cover transition duration-300 group-hover:scale-[1.02]"
                  loading="lazy"
                  decoding="async"
                />
              </button>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 transition group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                <span className="truncate text-[10px] text-white/80">
                  {frame.width}×{frame.height} · {out.bytes ? formatBytes(out.bytes) : ''}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <a
                    href={out.url}
                    download={downloadName(gen, out, i)}
                    title={t('result_download')}
                    aria-label={t('result_download')}
                    className="pointer-events-none grid size-7 place-items-center rounded bg-black/60 text-white hover:bg-black/80 group-hover:pointer-events-auto group-focus-within:pointer-events-auto"
                  >
                    <Download className="size-3.5" />
                  </a>
                  <span className="grid size-7 place-items-center rounded bg-black/60 text-white">
                    <ExternalLink className="size-3.5" />
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {active && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={gen.prompt || t('dialog')}
          className="fixed inset-0 z-[200] grid place-items-center bg-black/85 p-4 backdrop-blur-sm"
          onClick={() => setActive(null)}
        >
          <button
            ref={closeRef}
            type="button"
            aria-label={t('close_dialog')}
            onClick={() => setActive(null)}
            className="absolute right-4 top-4 z-10 grid size-9 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <X className="size-5" />
          </button>
          <img
            src={active.url}
            alt={gen.prompt}
            className="max-h-[88vh] w-auto max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="absolute bottom-6 z-10 flex gap-2" onClick={(e) => e.stopPropagation()}>
            <a
              href={active.url}
              download={downloadName(gen, active, 0)}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-white/15 px-4 text-sm text-white backdrop-blur hover:bg-white/25"
            >
              <Download className="size-4" /> {t('result_download_original')}
            </a>
          </div>
        </div>
      )}
    </>
  );
}

export function ResultPlayer({
  gen,
  onRedraw,
  onUseAsRef,
  onDelete,
}: {
  gen: Generation;
  onRedraw: () => void;
  onUseAsRef: () => void;
  onDelete: () => void;
}) {
  const { locale, t } = useI18n();
  const video = videoOf(gen);
  const images = imagesOf(gen);
  const primary = images[0];
  const emptyFrame = displayFrame('video', gen.width, gen.height);
  const metaFrame = video
    ? (artifactFrame(video.width, video.height) ?? emptyFrame)
    : primary
      ? (artifactFrame(primary.width, primary.height) ?? displayFrame('image', gen.width, gen.height))
      : emptyFrame;

  return (
    <div className="flex h-full flex-col gap-3">
      {video ? (
        <VideoResult gen={gen} />
      ) : primary ? (
        <div className="mx-auto w-full">
          <ImageResults gen={gen} columns={1} />
        </div>
      ) : (
        <div
          className="mx-auto w-full overflow-hidden rounded-xl"
          style={{ maxWidth: emptyFrame.width >= emptyFrame.height ? '100%' : '320px' }}
        >
          <div style={{ aspectRatio: `${emptyFrame.width} / ${emptyFrame.height}` }}>
            <SeedPoster seed={gen.seed} label={t('result_no_file')} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onRedraw}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-stone-300 px-3 text-xs font-medium transition hover:bg-white/5 dark:border-stone-700"
        >
          <RotateCw className="size-3.5" /> {t('result_redraw')}
        </button>
        <button
          onClick={onUseAsRef}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-stone-300 px-3 text-xs font-medium transition hover:bg-white/5 dark:border-stone-700"
        >
          <Repeat className="size-3.5" /> {t('result_use_ref')}
        </button>
        <button
          onClick={() => {
            const url = video?.url ?? primary?.url;
            if (!url) return;
            const a = document.createElement('a');
            a.href = url;
            a.download = downloadName(gen, video ?? primary!, 0);
            a.click();
          }}
          disabled={!video && !primary}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-stone-300 px-3 text-xs font-medium transition hover:bg-white/5 disabled:opacity-40 dark:border-stone-700"
        >
          <Download className="size-3.5" /> {t('result_download')}
        </button>
        {ownsGeneration(gen) && (
          <button
            onClick={onDelete}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-red-500/40 px-3 text-xs font-medium text-red-400 transition hover:bg-red-500/10"
          >
            {t('studio_delete')}
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span>{gen.modelName}</span>
        <span>
          {metaFrame.width}×{metaFrame.height}
        </span>
        <span>{gen.duration}s</span>
        <span>{t('result_credits_used', { credits: gen.credits })}</span>
        {gen.finishedAt && (
          <span>
            {t('result_finished', {
              time: new Date(gen.finishedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en'),
            })}
          </span>
        )}
      </div>

      {gen.prompt && (
        <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
          {gen.prompt}
        </p>
      )}

      <RefStrip gen={gen} />
    </div>
  );
}

/** Reference assets used by this generation (loaded from the asset library). */
function RefStrip({ gen }: { gen: Generation }) {
  const { t } = useI18n();
  const refs = [...gen.refImages, ...gen.refVideos, ...gen.refAudios];
  if (refs.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{t('result_refs', { count: refs.length })}</span>
      {refs.map((r) => (
        <a
          key={r.id}
          href={r.url}
          target="_blank"
          rel="noreferrer"
          title={r.name}
          className="relative size-12 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800"
        >
          {r.kind === 'image' ? (
            <img src={r.url} alt={r.name} className="size-full object-cover" loading="lazy" />
          ) : r.kind === 'video' ? (
            <span className="grid size-full place-items-center bg-stone-800">
              <Play className="size-4 text-white/90" />
            </span>
          ) : (
            <span className="grid size-full place-items-center bg-emerald-900/50">
              <Repeat className="size-4 text-emerald-300/90" />
            </span>
          )}
        </a>
      ))}
    </div>
  );
}

/** Shown when a task ends in the `failed` state, with a one-click retry. */
export function FailedResult({
  gen,
  onRetry,
  onDelete,
}: {
  gen: Generation;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const frame = displayFrame('video', gen.width, gen.height);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-red-500/25 bg-red-500/5 p-8 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-red-500/15 text-red-400">
        <AlertTriangle className="size-7" />
      </span>
      <div className="space-y-1">
        <p className="text-base font-semibold text-red-400">
          {gen.errorCode === 'CANCELLED' ? t('result_cancelled') : t('result_failed')}
        </p>
        <p className="text-sm text-stone-500 dark:text-stone-400">{gen.error || t('result_render_error')}</p>
        <p className="text-xs text-stone-400 dark:text-stone-500">
          {gen.modelName} · {frame.width}×{frame.height} · {gen.duration}s
        </p>
        {gen.refunded && gen.credits > 0 && (
          <p className="text-xs text-emerald-500">{t('result_refunded', { credits: gen.credits })}</p>
        )}
      </div>
      {ownsGeneration(gen) && (
        <div className="flex gap-2">
          <Button variant="brand" onClick={onRetry}>
            <RotateCw className="size-4" /> {t('studio_retry')}
          </Button>
          <Button variant="danger" onClick={onDelete}>
            {t('studio_delete')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Progress ring shown while a task renders; uses the last real frame if available. */
export function ProgressOverlay({ gen }: { gen: Generation }) {
  const { t } = useI18n();
  const poster = gen.posterUrl ?? gen.outputs.find((o) => o.kind === 'poster')?.url ?? null;
  const phase =
    gen.status === 'queued'
      ? t('result_queued')
      : gen.progress < 20
        ? t('result_preparing')
        : gen.progress < 75
          ? gen.type === 'image'
            ? t('result_drawing')
            : t('result_rendering')
          : t('result_packaging');

  const strokeDash = useMemo(() => `${(gen.progress / 100) * 97.4} 97.4`, [gen.progress]);
  const frame = displayFrame('video', gen.width, gen.height);

  return (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-xl bg-black"
      style={{ maxWidth: frame.width >= frame.height ? '100%' : '320px' }}
    >
      <div style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
        {poster ? (
          <img src={poster} alt={t('result_progress_alt')} className="size-full object-cover opacity-60 blur-[1px]" />
        ) : (
          <SeedPoster seed={gen.seed} />
        )}
      </div>
      <div className="absolute inset-0 grid place-items-center bg-black/45 backdrop-blur-[1px]">
        <div className="flex flex-col items-center gap-3">
          <div className="relative grid size-16 place-items-center">
            <svg viewBox="0 0 36 36" className="size-16 -rotate-90">
              <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="3" />
              <circle
                cx="18"
                cy="18"
                r="15.5"
                fill="none"
                stroke="url(#pg)"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={strokeDash}
              />
              <defs>
                <linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
                  <stop stopColor="#9b6bff" />
                  <stop offset="1" stopColor="#7b4aff" />
                </linearGradient>
              </defs>
            </svg>
            <span className="absolute text-sm font-semibold text-white">{Math.round(gen.progress)}%</span>
          </div>
          <span className="text-sm text-white/80">{phase}</span>
          <span className="text-[11px] text-white/50">
            {gen.modelName} · {frame.width}×{frame.height}
            {gen.type === 'video' ? ` · ${gen.duration}s` : ''}
          </span>
          {ownsGeneration(gen) && <CancelButton gen={gen} />}
        </div>
      </div>
    </div>
  );
}

function CancelButton({ gen }: { gen: Generation }) {
  const { t } = useI18n();
  const { cancel } = useGenerations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seenGenId, setSeenGenId] = useState(gen.id);
  const genIdRef = useRef(gen.id);
  // Current before a late cancel returns. An effect would run too late.
  // eslint-disable-next-line react-hooks/refs
  genIdRef.current = gen.id;
  if (gen.id !== seenGenId) {
    setSeenGenId(gen.id);
    setBusy(false);
    setError(null);
  }
  return (
    <div className="flex max-w-xs flex-col items-center gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          const requestId = gen.id;
          setBusy(true);
          setError(null);
          void cancel(requestId)
            .catch((err: unknown) => {
              if (genIdRef.current !== requestId) return;
              setError(err instanceof Error ? err.message : t('studio_generate_failed'));
            })
            .finally(() => {
              if (genIdRef.current === requestId) setBusy(false);
            });
        }}
        className="text-[11px] text-white/50 underline underline-offset-2 transition hover:text-white/80 disabled:opacity-60"
      >
        {busy ? t('result_cancelling') : t('result_cancel')}
      </button>
      {error && <p className="text-center text-[11px] leading-4 text-red-300">{error}</p>}
    </div>
  );
}

/** Kept for callers that still need to derive a frame for the "用作参考" flow. */
export async function captureFrameFromUrl(
  url: string,
  filename: string,
  mime?: string | null,
): Promise<File | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const ext = outputExtension(blob.type || mime, 'image');
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    return new File([blob], `${stem}.${ext}`, { type: blob.type || 'image/png' });
  } catch {
    return null;
  }
}

export { videoOf, imagesOf };

/** Lightweight deterministic placeholder used by canvas/tool surfaces. */
export function GenerativeCanvas({
  seed,
  className,
}: {
  seed: string;
  width?: number;
  height?: number;
  playing?: boolean;
  className?: string;
  genId?: string;
}) {
  return (
    <div className={cn('relative size-full overflow-hidden', className)} style={{ background: seedGradient(seed) }}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_25%,rgba(255,255,255,0.25),transparent_55%)]" />
    </div>
  );
}

/** No-op shim kept for legacy callers; real downloads use the signed output URL. */
export async function saveFrame(_genId: string, _filename: string): Promise<void> {
  return;
}
