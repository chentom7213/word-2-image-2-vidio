import { useRef, useState } from 'react';
import { Upload, Clipboard, X, Film, Music, Play, Loader2 } from 'lucide-react';
import type { Asset, AssetKind } from '../lib/types';
import { cn, formatBytes, uid } from '../lib/utils';
import { assetApi } from '../lib/api';
import { appendReferenceAssets } from '../lib/reference-append';
import { referenceMaxBytes } from '../lib/reference-limit';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/Button';

type Props = {
  kind: AssetKind;
  title: string;
  items: Asset[];
  onChange: (items: Asset[] | ((prev: Asset[]) => Asset[])) => void;
  max: number;
  emptyText: string;
  showClipboard?: boolean;
  accept?: string;
  maxSizeMB?: number;
};

export function ReferenceUploader({
  kind,
  title,
  items,
  onChange,
  max,
  emptyText,
  showClipboard,
  accept,
  maxSizeMB,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { user } = useAuth();
  const { t } = useI18n();
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const userId = user?.id || 'guest';
  const userIdRef = useRef(userId);
  const [seenUserId, setSeenUserId] = useState(userId);
  userIdRef.current = userId;
  if (userId !== seenUserId) {
    setSeenUserId(userId);
    setError(null);
    setUploading(0);
  }
  const limitBytes = maxSizeMB == null ? referenceMaxBytes(kind) : maxSizeMB * 1024 * 1024;
  const limitMB = maxSizeMB ?? Math.trunc(limitBytes / (1024 * 1024));

  const addFiles = async (files: FileList | File[]) => {
    const requestUserId = userIdRef.current;
    const list = Array.from(files);
    const remaining = max - items.length;
    const picked = list.slice(0, Math.max(0, remaining));
    if (picked.length === 0) return;

    const accepted: Asset[] = [];
    let hasOversize = false;
    for (const f of picked) {
      if (f.size > limitBytes) {
        hasOversize = true;
        continue;
      }
      if (user) {
        // 上传到素材库，拿到真实资源 id 以在生成时引用
        setUploading((n) => n + 1);
        try {
          const uploaded = await assetApi.upload(f);
          if (userIdRef.current === requestUserId) accepted.push(uploaded);
        } catch (err) {
          if (userIdRef.current === requestUserId) {
            setError(err instanceof Error ? err.message : t('assets_upload_failed'));
          }
        } finally {
          if (userIdRef.current === requestUserId) setUploading((n) => n - 1);
        }
        if (userIdRef.current !== requestUserId) return;
      } else {
        // 未登录：仅本地预览（不持久化、不会被生成引用）
        accepted.push({ id: uid(), kind, name: f.name, url: URL.createObjectURL(f), size: f.size });
      }
    }
    if (userIdRef.current !== requestUserId) return;
    if (hasOversize) {
      setError(t('ref_too_large', { size: limitMB }));
    } else if (accepted.length === picked.length) {
      setError(null);
    }
    if (accepted.length) onChange((prev) => appendReferenceAssets(prev, accepted, max));
  };

  const remove = (id: string) => onChange((prev) => prev.filter((item) => item.id !== id));

  const pasteFromClipboard = async () => {
    const requestUserId = userIdRef.current;
    try {
      const res = await navigator.clipboard.read();
      if (userIdRef.current !== requestUserId) return;
      const files: File[] = [];
      for (const item of res) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            if (userIdRef.current !== requestUserId) return;
            files.push(new File([blob], `clipboard-${Date.now()}.png`, { type }));
          }
        }
      }
      if (userIdRef.current !== requestUserId) return;
      if (files.length) void addFiles(files);
      else setError(t('ref_clipboard_empty'));
    } catch {
      if (userIdRef.current !== requestUserId) return;
      setError(t('ref_clipboard_denied'));
    }
  };

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-base font-semibold">{title}</span>
        <div className="flex gap-2">
          {showClipboard && (
            <Button size="sm" onClick={pasteFromClipboard}>
              <Clipboard className="size-3.5" />
              {t('ref_clipboard')}
            </Button>
          )}
          <Button size="sm" onClick={() => inputRef.current?.click()}>
            <Upload className="size-3.5" />
            {t('ref_upload')}
          </Button>
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void addFiles(e.dataTransfer.files);
        }}
        role={items.length === 0 ? 'button' : undefined}
        tabIndex={items.length === 0 ? 0 : undefined}
        aria-label={items.length === 0 ? t('ref_upload_zone', { title }) : undefined}
        onClick={() => items.length === 0 && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (items.length === 0 && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={cn(
          'hover-scrollbar flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-stone-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9b6bff] dark:border-stone-700',
          items.length === 0 && 'cursor-pointer items-center justify-center',
          items.length > 0 && 'items-center p-2',
          over && 'border-[#9b6bff] bg-[#9b6bff]/5',
        )}
      >
        {items.length === 0 ? (
          <div className="flex min-w-full items-center justify-center px-4 py-6 text-center text-sm text-stone-500">
            {emptyText}
          </div>
        ) : (
          items.map((a) => (
            <div
              key={a.id}
              className="group relative size-20 shrink-0 overflow-hidden rounded-lg border border-stone-200 bg-black/40 dark:border-stone-700"
              title={a.name}
            >
              {a.kind === 'image' ? (
                <img src={a.url} alt={a.name} className="size-full object-cover" />
              ) : a.kind === 'video' ? (
                <>
                  <video src={a.url} className="size-full object-cover" muted />
                  <span className="absolute inset-0 grid place-items-center bg-black/20">
                    <Play className="size-5 text-white" />
                  </span>
                </>
              ) : (
                <div className="flex size-full flex-col items-center justify-center gap-1 px-1 text-center">
                  <Music className="size-5 text-emerald-400" />
                  <span className="w-full truncate text-[10px] text-stone-300">{a.name}</span>
                  <span className="text-[9px] text-stone-500">{formatBytes(a.size)}</span>
                </div>
              )}
              {a.kind !== 'audio' && (
                <span className="absolute bottom-0 left-0 right-0 truncate bg-black/50 px-1 py-0.5 text-[9px] text-white/80">
                  {formatBytes(a.size)}
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  remove(a.id);
                }}
                className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t('ref_remove', { name: a.name })}
              >
                <X className="size-3" />
              </button>
            </div>
          ))
        )}
        {Array.from({ length: uploading }).map((_, i) => (
          <div
            key={`uploading-${i}`}
            className="grid size-20 shrink-0 place-items-center rounded-lg border border-dashed border-[#9b6bff]/50 bg-[#9b6bff]/5"
          >
            <Loader2 className="size-5 animate-spin text-[#9b6bff]" />
          </div>
        ))}
        {items.length > 0 && items.length < max && uploading === 0 && (
          <button
            onClick={() => inputRef.current?.click()}
            className="grid size-20 shrink-0 place-items-center rounded-lg border border-dashed border-stone-300 text-stone-500 transition hover:border-[#9b6bff] hover:text-[#9b6bff] dark:border-stone-700"
            aria-label={t('ref_upload_more', { title })}
          >
            <Upload className="size-5" />
          </button>
        )}
      </div>
      {error && <div className="mt-1 text-xs text-red-400">{error}</div>}
      <input
        ref={inputRef}
        type="file"
        aria-label={t('ref_choose', { title })}
        accept={accept ?? (kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : 'audio/*')}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      {items.length === 0 && kind === 'video' && (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-stone-500">
          <Film className="size-3" /> {t('ref_video_hint')}
        </div>
      )}
    </div>
  );
}
