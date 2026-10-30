import { request, type CreditTx } from './api';

export const CREDIT_HISTORY_PAGE_SIZE = 50;

export type CreditHistoryCursor = { createdAt: string; id: string };

export async function loadCreditHistory(params?: {
  limit?: number;
  before?: string;
  beforeId?: string;
}): Promise<{ items: CreditTx[]; nextCursor: CreditHistoryCursor | null }> {
  const search = new URLSearchParams();
  if (params?.limit) search.set('limit', String(params.limit));
  if (params?.before) search.set('before', params.before);
  if (params?.beforeId) search.set('beforeId', params.beforeId);
  const query = search.toString();
  const body = await request<{ items: CreditTx[]; nextCursor?: CreditHistoryCursor | null }>(
    `/api/credits/transactions${query ? `?${query}` : ''}`,
  );
  return { items: body.items, nextCursor: body.nextCursor ?? null };
}
