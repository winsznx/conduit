# Conduit Guidelines

Version 1.0.0, approved. The reasoning and the evidence are in `design.md`. The values are in `brand.json`. This file says how to use the kit.

## 1. Brand idea

Two assets stay where they are. One decision crosses, and it cannot be taken back. The mark is two equal modules and one red point that touches neither.

## 2. Identity system

### Master mark

`source/conduit-symbol.svg`, version 1.0.0. One path for both modules and one circle for the point, on a 64 by 64 canvas.

### Construction

A 16u by 16u grid where 1u is 4 units. Each module is 7u wide with a 2u corner radius on its three outer corners. They touch at the centre of the canvas, where a 3u circle is cut from both and a 2u point sits in the cut. Turning the mark 180 degrees about the point changes nothing. The drawing is `showcase/conduit-construction.png`.

### Responsive variants

| Space                              | Use                                                        |
| ---------------------------------- | ---------------------------------------------------------- |
| 96 px wide or more, name needed    | `conduit-lockup-horizontal`                                |
| Square or tall                     | `conduit-lockup-stacked`                                   |
| Under 96 px wide, or name nearby   | `conduit-symbol` (16 px minimum)                           |
| Symbol already on the same surface | `conduit-wordmark` alone (72 px minimum)                   |
| Browser tab                        | `favicon.svg`, with `favicon.ico` and the PNGs as fallback |
| Home screen or store               | `app-icons/conduit-app-icon-*.png`, opaque                 |
| Profile picture                    | `social/conduit-avatar-*.png`                              |

Colourways: positive (ink modules, ember point), reversed (paper modules on ink, ember point), one-colour black and one-colour white (the point takes the module colour and stays visible through its socket). Pick one-colour when printing in a single ink, embossing or stamping, or when a grayscale copy has to keep the point visible on a dark ground.

Clear space is one module on every side, or half a module inside product chrome. Minimums are 16 px for the symbol, 72 px for the wordmark and 96 px for the horizontal lockup. See `showcase/conduit-clear-space-and-minimum-size.png`.

### Incorrect use

`showcase/conduit-incorrect-use.png` draws each of these from the real master.

- Do not rotate, mirror or stretch it.
- Do not recolour the modules, or make them red.
- Do not move the point off the socket, or use the point alone as an icon or an avatar.
- Do not add outlines, shadows, glow or gradients.
- Do not put it on a low-contrast or busy ground.
- Do not set the wordmark in another typeface.
- Do not use more than one red point in the content of a page. Lockups in page chrome (header, sidebar, footer) do not count.

## 3. Colour

| Token      | Value     | Role                                                      |
| ---------- | --------- | --------------------------------------------------------- |
| `ink`      | `#0a0a0a` | Modules, wordmark, text on paper                          |
| `paper`    | `#ffffff` | Page, and modules and text on ink                         |
| `ember`    | `#e7000b` | The point. Once per page of content. Never a surface fill |
| `midGray`  | `#525252` | Secondary text                                            |
| `hairline` | `#d4d4d4` | Rules and borders, never text                             |
| `canvas`   | `#f5f5f5` | Muted fills                                               |

The page is plain white. There are no gradients, no tints of red and no warm greys. Contrast floors are enforced by `pnpm brand:check`.

## 4. Typography

Geist. SemiBold for the wordmark and for headlines, Regular for supporting text. Headlines are sentence case with tight tracking (-0.045em in brand graphics). The wordmark and the strings in the social cards are outlined, so no font file is needed to display them. Geist is SIL OFL 1.1 and its files are not in this repository.

## 5. Layout and UI

Brand graphics: a 72 px margin on a 1200 by 630 card, text left aligned (the launch card's URL is the one exception), the symbol on the vertical centre line at the right, no shadows and no containers. Product UI follows `/design.md`: 18 px radius on interactive elements, 24 px on containers, 1 px hairlines, flat surfaces.

## 6. Iconography and illustration

The symbol is the only brand icon. It is not a bullet, a spinner, a pattern or a decoration. Product functional icons are thin-stroke and are outside this kit.

## 7. Photography and 3D

The hero render (`apps/web/assets/hero-source.png`) is the only 3D asset. Reuse it as it is. A future render of the same object keeps its materials: satin white base, clear acrylic, brushed steel, matte black, one red indicator light and no glow, on a transparent ground with a soft contact shadow. Bases should be neutral white. The current ones are about five levels warm.

## 8. Applications

Website. The kit is wired into the console and covered by unit and browser tests. It has not been deployed yet. What was done, and where:

- `wordmark()` in `apps/web/src/components.ts` draws `conduit-lockup-horizontal.svg` inline, at 20 px high in the sidebar, 26 px in the landing nav (22 px under 360 px wide) and 24 px in the landing footer. `apps/web/build.mjs` reads the SVG from `brand/` and generates the markup, so `brand/` is the only copy. `validation/conduit-context-console-sidebar.png` and `conduit-context-landing-nav.png` are previews made before the wiring.
- `apps/web/src/head.ts` puts the favicon set (`favicon.svg` with `type="image/svg+xml"`, `favicon.ico` and `apple-touch-icon.png`), `site.webmanifest`, `<meta name="theme-color" content="#ffffff">`, the canonical link and the Open Graph and Twitter tags in the head of every page. The error pages have no canonical link and are marked `noindex`.
- The link card is `og:image` as an absolute https URL, with `og:image:width` 1200, `og:image:height` 630, `og:image:alt` and `twitter:card` set to `summary_large_image`. `apps/web/build.mjs` puts the card at a content-hashed path and the Worker serves it there. The card is 46 KB and has no alpha channel.
- `apps/web/src/worker.ts` serves the favicon set and the manifest at fixed root paths (`/favicon.ico`, `/favicon.svg`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, `/icon-maskable-512.png` and `/site.webmanifest`) and redirects the `www` host to the apex with a 308. `SITE_URL` in `apps/web/wrangler.toml` is the canonical origin.
- The Content-Security-Policy gained `manifest-src 'self'`, because `default-src 'none'` would otherwise block the web manifest. `img-src 'self'` already covered same-origin brand images, and `font-src` is still absent because nothing in this kit needs a web font.
- The colour-discipline comment in `apps/web/src/theme.ts` and the lines in `/design.md` that said Ember is never decoration were reworded so the code agrees with the identity. ADR-0023 records them.

Social. Use the 1200 by 630 card for link previews on every platform, the 1280 by 640 card for the GitHub repository social preview, the 1600 by 900 card for launches, and the 400 or 1024 px avatar. Crops and masks are in `validation/conduit-avatar-and-icon-masks.png`.

Documents and presentations. Put the horizontal lockup top left on paper, set headlines in Geist SemiBold in sentence case, keep one red point per slide, not counting a lockup in the header or footer, and use `midGray` for supporting text. A cover can reuse the launch card layout.

Motion. See the motion principle in `design.md`. None is built.

## 9. Asset registry

Every file, with its SHA-256, size, pixel size and alpha channel, is listed in `manifest.json`. Each file's approval is read from `status` in `brand.json`, which is `approved`.

To change the brand, edit `brand.json`, then:

```text
pnpm brand:build        # regenerate every SVG and export, rewrite manifest.json
pnpm brand:check        # prove nothing drifted; needs no browser
```

`brand:build` renders in Chromium, the one already pinned for the browser tests. If only documents changed, `node scripts/build-brand.mjs --manifest-only` re-hashes without rendering. To change the lettering or the copy on the social cards, edit `scripts/brand/author-type.py`, run it with `GEIST_DIR` pointing at the Geist files, then build. Do not edit a generated SVG by hand: the check will fail it.
