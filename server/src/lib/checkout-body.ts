/** 下单请求体 Zod 路径第一段。kind / skuId 换成中文，其余交给原 message。 */
export function checkoutBodyMessage(issuePath: PropertyKey | undefined): string | null {
  if (issuePath === 'kind') return '下单种类无效';
  if (issuePath === 'skuId') return '套餐编号无效';
  return null;
}
