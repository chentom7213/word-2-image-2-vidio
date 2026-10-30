/** True when the IdP callback sent the browser back after a successful login. */
export function ssoJustSucceeded(search: string): boolean {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  return new URLSearchParams(raw).get('sso') === 'success';
}

/** Drops the one-time flag so a refresh does not exchange the session again. */
export function stripSsoParam(href: string): string {
  const url = new URL(href, 'http://local.invalid');
  url.searchParams.delete('sso');
  const search = url.search;
  return `${url.pathname}${search}${url.hash}`;
}
