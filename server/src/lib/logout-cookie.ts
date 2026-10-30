/**
 * Logout may revoke and clear the refresh cookie only when that cookie still
 * belongs to the access token that started the logout. A newer login in the
 * same browser keeps its cookie.
 */
export function logoutMayClearCookie(
  bearerUserId: string | null,
  cookieUserId: string | null,
  bearerUnreadable = false,
): boolean {
  if (bearerUnreadable && cookieUserId) return false;
  return !(bearerUserId && cookieUserId && bearerUserId !== cookieUserId);
}
