import { useQuery } from '@tanstack/react-query';
import { modelApi } from './api';
import type { ModelOption } from './types';
import { VIDEO_MODELS, IMAGE_MODELS } from '../data/models';

/**
 * Model catalogue from `GET /api/models`.
 *
 * The bundled static list is only a fallback for the first paint / offline case;
 * pricing shown to the user always comes from the server so the estimate can
 * never drift from what is actually charged.
 */
type State = { models: ModelOption[]; loading: boolean; offline: boolean };

function fallback(kind: 'image' | 'video'): ModelOption[] {
  const list = kind === 'video' ? VIDEO_MODELS : IMAGE_MODELS;
  return list.map((m) => {
    const amount = parseInt(m.price.replace(/[^\d]/g, ''), 10) || 0;
    return {
      id: m.id,
      name: m.name,
      kind,
      priceLabel: m.price,
      priceAmount: amount,
      priceUnit: /秒/.test(m.price) ? 'per_second' : 'per_call',
      tag: m.tag ?? null,
      refs: m.refs ?? [],
      durations: m.durations ?? [],
      provider: 'builtin',
      maxDuration: m.durations ? Math.max(...m.durations) : null,
    } satisfies ModelOption;
  });
}

export function useModels(kind: 'image' | 'video'): State {
  const query = useQuery({
    queryKey: ['models', kind],
    queryFn: () => modelApi.list(kind),
    staleTime: 5 * 60_000,
  });
  const available = query.data ?? [];
  const offline = query.isError || (query.isSuccess && available.length === 0);
  return {
    models: available.length > 0 ? available : fallback(kind),
    loading: query.isLoading,
    offline,
  };
}

/** Server-side pricing rule, mirrored for the pre-submit estimate. */
export function estimateCredits(model: ModelOption, duration: number, count: number): number {
  switch (model.priceUnit) {
    case 'per_second':
      return model.priceAmount * Math.max(1, duration);
    case 'per_image':
      return model.priceAmount * Math.max(1, count);
    default:
      return model.priceAmount;
  }
}
