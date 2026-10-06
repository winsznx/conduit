/**
 * What the server and the browser agree on about a visitor who has already been welcomed.
 *
 * The console overview holds blank space for a welcome card that its browser script adds after
 * the first paint. A visitor who dismissed that card needs none of the space, and the server is
 * the only party that can leave it out before the first frame, because the script runs after
 * that frame. The server cannot see `localStorage`, where the dismissal lives. It can see a
 * cookie, and holding the script back until it has run would make every visitor wait for the
 * bundle and leave the page blank if that request hangs. So the browser mirrors the one bit
 * into a first-party cookie and the server reads it on the next request.
 *
 * Both halves import this file, so the name, the value and the parsing cannot drift apart.
 * Nothing here touches the DOM or the Worker runtime.
 */

/** The class on a host that holds the space its content will take. One name, three users. */
export const RESERVE_CLASS = 'reserve';

export const WELCOME_COOKIE = 'conduit-welcomed';
const WELCOME_VALUE = '1';
const ONE_YEAR_SECONDS = 31_536_000;

/**
 * Whether a `Cookie` header, or `document.cookie`, says this visitor was welcomed.
 *
 * Pairs are split on semicolons and compared as whole strings, so a longer name that merely
 * contains ours, a different value, an empty pair and unrelated junk all read as absent. The
 * first pair with our name decides, which is the one a browser sends for the most specific path.
 * There is no pattern to match, so no input can make it backtrack.
 */
export function hasWelcomeCookie(header: string | null | undefined): boolean {
  if (header === null || header === undefined) return false;
  for (const pair of header.split(';')) {
    const entry = pair.trim();
    const equals = entry.indexOf('=');
    if (equals === -1 || entry.slice(0, equals) !== WELCOME_COOKIE) continue;
    return entry.slice(equals + 1) === WELCOME_VALUE;
  }
  return false;
}

/**
 * The string to assign to `document.cookie`.
 *
 * `Secure` is added only on https, because the local console is plain http and a browser would
 * drop the cookie there. It is not `HttpOnly`, since script sets it, and it carries no identifier.
 */
export function welcomeCookieDeclaration(secure: boolean): string {
  return (
    `${WELCOME_COOKIE}=${WELCOME_VALUE}; Path=/; Max-Age=${String(ONE_YEAR_SECONDS)}; SameSite=Lax` +
    (secure ? '; Secure' : '')
  );
}
