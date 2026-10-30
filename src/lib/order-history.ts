import { request, type OrderDto } from './api';

export type OrderPage = {
  items: OrderDto[];
  nextCursor: { createdAt: string; id: string } | null;
};

/** `nextCursor.createdAt` is the server MySQL timestamp, not `OrderDto.createdAt`. */
export async function listOrderPage(options?: {
  limit?: number;
  before?: string;
  beforeId?: string;
}): Promise<OrderPage> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.before && options.beforeId) {
    params.set('before', options.before);
    params.set('beforeId', options.beforeId);
  }
  const query = params.toString();
  const page = await request<{ items: OrderDto[]; nextCursor?: OrderPage['nextCursor'] }>(
    `/api/billing/orders${query ? `?${query}` : ''}`,
  );
  return { items: page.items, nextCursor: page.nextCursor ?? null };
}
