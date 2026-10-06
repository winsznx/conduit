# ADR-0024: A one-bit cookie lets the server hold the right space

**Status:** Accepted
**Date:** 2026-10-06
**Phase:** None
**Supersedes:** None
**Superseded by:** None

## Context

The console overview at `/app` moved after the first paint. A review measured layout shift of
0.10 at 1440 px and 0.29 at 390 px for a first-time visitor, on the live site and locally. Two
empty hosts, `[data-onboarding]` and `[data-overview]`, are filled by the browser script once the
wallet session has hydrated, and the first section of the page moves down by the height of what
arrives: a welcome card of 206 to 470 px at the five widths measured (the reserve table covers 186 to 538 px), and a line of caption.

Reserving the space in the server-rendered HTML fixes it for a first-time visitor, who is about to
get the card. It is wrong for a visitor who dismissed the card earlier, because the script that
knows this runs after the first paint even when it is cached. That visitor would see the blank
space painted and then removed, which measured worse than before the change (0.08 to 0.26).

The server cannot see `localStorage`, where the dismissal lives. It can see a cookie.

## Decision

The server holds the space on both hosts. When the request carries the cookie
`conduit-welcomed=1`, it leaves the welcome host without a reserve.

- The browser script sets the cookie, and the server never sends `Set-Cookie`. It is set when the
  visitor clicks Dismiss, at start-up when `localStorage` already says welcomed (which covers
  everyone who dismissed before this change), and when the session hydrates as connected and
  oriented, since no card will show then.
- Only `GET /app` reads it. The name, the value, the parsing and the cookie's attributes live in
  `apps/web/src/welcome.ts`, which the Worker and the browser script both import.
- The cookie is first-party, `Path=/`, `SameSite=Lax`, one year, `Secure` on https, not
  `HttpOnly` because script sets it, and holds one bit with no identifier.
- Failure paths are handled in CSS. A `<noscript>` rule releases the space when JavaScript is off,
  and a fallback animation releases it after 4 seconds when the script never runs.

## Consequences

Easier: layout shift for a first-time visitor fell from 0.10 and 0.29 to 0.00, and for a visitor
who dismissed the card it is 0.00. The page paints as soon as the HTML arrives, with no
render-blocking script and no extra request.

Harder: this is the first cookie the product sets. It is a preference with no identifier, but it
is new state, and it is why this decision is recorded. Everyone who dismissed the card before this
change gets one jump on their next visit to `/app`, measured at 0.08 to 0.24, and none after.
A visitor with a remembered wallet still sees the position card arrive late (0.2 to 0.4), as they
did before. The reserved heights come from the system font stack and were checked in Chromium and
WebKit on macOS only, so another platform may wrap a few pixels differently.

Invariants (PRD 14.4): none are touched. No state, key, value movement or application database is
involved, and the cookie carries nothing that authorises anything.

## Alternatives rejected

- A render-blocking module script in the head of `/app`. It fixes the returning visitor in
  Chromium, and was built and measured. It makes a first-time visitor's first paint wait for the
  412 kB bundle, about 125 kB compressed (2148 ms against 1464 ms on an emulated slow 4G link with
  a cold cache; with a warm cache the difference was 1404 ms against 1356 ms). A script request
  that hangs leaves the page blank, and a browser that ignores `blocking="render"` keeps the
  shift.
- A small render-blocking classic script that reads `localStorage`. It adds a request, keeps the
  hang risk and the browser-support gap, and needs a new asset route.
- Reserving the space for everyone with no release. Returning visitors get the blank band and
  then a jump.
- Doing nothing. First-time visitors keep a layout shift of 0.10 to 0.37.
- Rendering the welcome card on the server. It gives the best first frame and needs the browser
  script to adopt the markup instead of building its own, which is a larger change than the
  problem warrants.
