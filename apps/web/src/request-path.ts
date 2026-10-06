const SLASH = 0x2f;

/**
 * A request path with its trailing slashes removed, so `/app/` and `/app` reach the same
 * route. A path of nothing but slashes is the root.
 *
 * This scans from the end instead of matching `/\/+$/`. That pattern restarts at every
 * slash of a long run that ends in anything else, which makes it quadratic: a 32,000
 * slash path held V8 for about two seconds, and the caller chooses the path.
 */
export function withoutTrailingSlashes(pathname: string): string {
  let end = pathname.length;
  while (end > 0 && pathname.charCodeAt(end - 1) === SLASH) end -= 1;
  return end === 0 ? '/' : pathname.slice(0, end);
}
