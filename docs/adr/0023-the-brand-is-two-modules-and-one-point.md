# ADR-0023: The brand is two modules and one point

**Status:** Accepted
**Date:** 2026-10-05
**Phase:** None
**Supersedes:** None
**Superseded by:** None

## Context

Conduit has a product UI system and no brand. `design.md` is a style reference taken from a
component library. The only mark in the product is a 16 px rounded square with a red dot in
`apps/web/src/components.ts`, and the PRD has no brand section. The owner asked for a brand and
a full asset kit, to be built with the brand-design skill, on a plain white page with strong
contrast.

Doing that forces a decision about Ember (`#e7000b`), because three statements in the repository
disagree:

- `design.md`, token table: _"Red decorative accent for icons, marks, and small graphic details.
  Use as a supporting accent, not as a status color."_
- `design.md`, Do list: _"Reserve #e7000b exclusively for destructive states; never use it for
  decoration, branding, or non-error emphasis."_ The colour-discipline note in
  `apps/web/src/theme.ts` agrees: Ember is reserved for destructive and error-adjacent states and
  is never for status or decoration.
- `apps/web/src/components.ts`, `wordmark()`: _"The one Ember mark in the chrome: a supporting
  graphic detail, which is the role `design.md` gives it. It is not a status and not a brand
  fill."_ This is what ships.

CLAUDE.md says that when sources conflict the conflict is documented in an ADR and not chosen
silently. This is that ADR.

A second constraint is recorded here so it is not mistaken for a defect. `theme.ts` and
`worker.ts` explain that Geist is deliberately not served: the Worker sends `default-src 'none'`
with no `font-src`, and adding one is a security decision. Anything the brand needs from Geist has
to arrive without a font file.

## Decision

The identity in `brand/` at version 1.0.0 is adopted as the Conduit brand.

The mark is two equal rounded modules that touch at one corner and a red point seated in a
circular socket between them. The point touches neither module. The construction is a 16u by 16u
grid with every value a whole number of units, and it is recorded in `brand/brand.json`.

Ember is permitted in exactly one brand use: the point inside the symbol, a circle of radius 2u,
at most once in the content of a page. Lockups in page chrome (header, sidebar, footer) do not
count against the content, and the red indicator light on the approved hero render is the landing
page's own point. In the interface Ember keeps the roles `theme.ts` gives it: error text and icon
strokes, the small failed-transaction dot and destructive-action text. It is never a surface fill,
never the colour of HELD, CONTESTED or WAITING FOR FINALITY, and never decoration. This follows
the `design.md` token table and the wordmark that shipped, and it is the owner's request.

All brand lettering is outlined from Geist and carried as vector paths, so the identity needs no
web font. Brand images are same-origin and fit the existing `img-src 'self'`. The web manifest needs
one new Content-Security-Policy directive, `manifest-src 'self'`, which is recorded under
Consequences.

Every SVG in the kit is generated from `brand/brand.json` and `scripts/brand/type.json` by
`scripts/build-brand.mjs`. `pnpm brand:check` compares generated SVG byte for byte, holds every
other file to `brand/manifest.json`, and enforces the contrast floors.

Accepted 2026-10-05, when the owner asked for the identity to be wired into the product.

## Evidence

- `brand/design.md`: source hierarchy, the six concepts and their scores, the refinements, the
  validation report and the remaining risks.
- `brand/explorations/`: the concept sheet and the tests that chose the grid, the point size and
  the socket.
- `brand/validation/`: size ladder, colour-vision simulations, neighbours in the product, link
  previews, avatar and icon masks, tab strips, and the live console and landing with the lockup
  swapped in by script.
- A measured check that `brand/favicon/favicon.svg` renders its modules as `10,10,10` in a light
  browser and `255,255,255` in a dark one.
- `pnpm brand:check` passes. The brand-design skill's SVG validator also passed over `brand/source/`.
  That script is not in this repository, so `pnpm brand:check` is the check anyone can repeat.
- The link card is 46 KB with no alpha channel. The 1024, 512 and 180 px app icons have none
  either, which App Store Connect requires of the 1024 px icon.

This ADR changes no custody, settlement or compliance behaviour.

## Consequences

Easier: one source of truth for the identity, a favicon and a link-preview image, which the site
lacked, and a check that stops the assets drifting from the tokens.

Harder: Ember now has one decorative use in a product where it also means error. The point is a
filled circle inside a logo, and error red is text, icon strokes and a 6 px dot. At the sidebar's
20 px height the point is about the size of the failed-transaction dot, so a page that shows a
failed transaction shows two small red dots, and a reviewer should keep their meanings apart. On
the landing page the header lockup, the footer lockup and the hero render's indicator light are
all red. The lockups are chrome and the light belongs to the hero, so the rule holds, and the
three read as one accent.

Done on 2026-10-05:

1. The colour-discipline comment in `apps/web/src/theme.ts` and four places in `design.md` were
   reworded: the opening sentence, the Ember token row, the Do list line and the note in the
   Destructive Action component.
2. `wordmark()` in `apps/web/src/components.ts` now draws the lockup. Under a forced-colours
   palette the stylesheet repaints it in the palette's text and highlight colours, because a fill
   painted by value is not remapped and the ink letters would vanish on a dark high-contrast
   ground.
3. Every page declares its title, description and canonical path through `apps/web/src/head.ts`.
   The error pages declare a title only and are marked `noindex`, and so is an evidence page for a
   settlement with nothing recorded, since any 64 hex digits reach that route.
4. The favicon set, the web manifest and the Open Graph and Twitter tags are in every page head.
5. The Worker serves the favicon set and the manifest at fixed root paths and the card at a hashed
   path, redirects `www` to the apex, and takes its canonical origin from `SITE_URL`.

One security header changed. `manifest-src 'self'` was added to the Content-Security-Policy that
`apps/web/src/worker.ts` sends, because `default-src 'none'` would otherwise block the web
manifest. Nothing else about the policy changed. `font-src` is
still absent and `script-src` is still `'self'`.

Forbidden: using the point alone, using more than one in the content of a page, and editing a
generated SVG by hand.

Invariants (PRD 14.4): none are touched. No product state, key, value movement or application
database is involved.

## Alternatives rejected

- Keep the placeholder mark. It is a generic rounded square and carries no idea, and the site has
  no favicon or preview image.
- Offset, Interlock, Closing C, Datum and a wordmark with a red i-dot. They read as the letters Z,
  e, C and H, or have no symbol. `brand/design.md` scores all six.
- Forbid Ember in the mark and use an ink-only identity. This honours the stricter reading, but the
  shipped wordmark already uses a red dot, and a single red point is the one memorable thing the
  identity can own in an otherwise monochrome product.
- Serve Geist so live text matches the wordmark. This relaxes the Content-Security-Policy for a
  typographic gain, which `theme.ts` already rejects.
- Overlap the point on the modules without a socket. It read as two nodes and a connector, and in
  one colour the point merged into the modules.

## Assumptions touched

None. No row in [docs/assumptions.md](../assumptions.md) concerns the identity.
