# Design Specification

## Document control

- Brand: Conduit
- Product: Cross-chain delivery versus payment for verified assets
- Status: approved by the owner on 2026-10-05, when they asked for the identity to be wired into the product. Every file is marked `approved` in `manifest.json`.
- Version: 1.0.0
- Owner: Conduit Labs
- Last updated: 2026-10-05
- Companion files: `brand.json` (the lock record, machine readable), `guidelines.md` (usage rules), `manifest.json` (every file with hash and size), `scripts/build-brand.mjs` (generator and drift check)
- Scope: the identity layer. That is the symbol, the wordmark, the lockups, the icons, the social graphics and the rules that keep them consistent. The product's UI tokens stay in `/design.md`, which this file does not replace.
- Provenance: designed by an AI agent following the brand-design skill (1.0.0). No human designer has reviewed it and no trademark search has been run.

## Source hierarchy

1. The owner's instruction of 2026-10-05: follow the brand-design skill, design the Conduit assets as files, keep the page plain white with strong contrast, and use no amber or cream tones.
2. `/design.md`, the product UI reference. No dedicated brand specification existed before this file.
3. Approved assets. `apps/web/assets/hero-source.png` is the hero render, approved by use on the landing page. The in-app wordmark in `apps/web/src/components.ts` was a 16 px rounded square with a red dot and carried little equity. The lockup replaced it (ADR-0023). The chain marks in `apps/web/src/marks.ts` are third-party marks that sit beside Conduit's.
4. The PRD and the v1.1 override. Neither has a brand section. Sections 0 to 1 of the PRD supply the product truth used below.
5. Tokens in code: `apps/web/src/theme.ts`.
6. Product behaviour: the landing page and console copy.
7. Assumptions, labelled where they occur.

### Conflicts and resolutions

| #   | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                         | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Three statements in the repository disagree about Ember (`#e7000b`). The `/design.md` token table calls it a decorative accent for icons, marks and small graphic details. The `/design.md` Do list and the colour note in `theme.ts` reserve it for destructive states and say never for decoration. The wordmark that shipped in `components.ts` drew a red dot and called it a supporting graphic detail.                           | The brand uses Ember for the point inside the symbol: a circle of radius 2u, at most once in the content of a page. This follows the token table and the wordmark that shipped, and it is the owner's request to brand the product. Error and destructive uses stay text, icon strokes and the small failed-transaction dot. The conflict is recorded in ADR-0023. The colour note in `theme.ts` and four places in `/design.md` (the opening sentence, the Ember token row, the Do list and the Destructive Action note) were reworded when the identity was wired in. |
| 2   | `/design.md` names `#f5f5f5` as the page background. The owner asked for plain white.                                                                                                                                                                                                                                                                                                                                            | `theme.ts` already sets the page to `#ffffff` and `/design.md` carries an amendment that says so. Brand graphics use paper `#ffffff`.                                                                                                                                                                                                                                                                                                                                                            |
| 3   | `/design.md` specifies Geist, and the console does not load it. `theme.ts` explains why: the Worker sends `default-src 'none'` with no `font-src`, and adding one would relax a security header. This is a deliberate constraint, so it is recorded here and not treated as a defect.                                                                                                                                              | The brand does not depend on the font being served. The wordmark and every brand graphic use Geist outlines drawn as vector paths. Product text keeps the platform fallback.                                                                                                                                                                                                                                                                                                                     |

## Brand foundation

### Product truth

Conduit settles one trade between two regulated assets that live on different chains: verified cash on Monad Testnet (a Cleanverse Verified Asset, issued in the live deployment as a sandbox CVA with no reserve behind it), and a transfer-restricted real-world asset on Base Sepolia. Both parties sign one intent. Wormhole carries authenticated settlement state between the chains and nothing is bridged or wrapped. The decision to commit waits for economic finality and for a fresh Cleanverse eligibility answer, and after COMMIT there is no refund. If a recipient becomes ineligible after COMMIT, the value is held and resolved by an authorised disposition. It is not reverted.

### Audience

Choosers and users, from PRD 1.2: brokers, issuers, transfer agents, institutional treasuries and compliant DeFi desks. People affected by it: compliance officers, auditors and counterparties, who need a record they can check without trusting the vendor. People evaluating it today: hackathon judges and developers reading a testnet deployment.

### Promise

Both legs reach a policy-valid terminal state, or neither party receives an unaccounted economic advantage (PRD section 0).

### Load-bearing idea

Two assets stay where they are. One decision crosses, and it cannot be taken back.

### Personality

Defined as behaviour, not adjectives.

- Exact. It states what the chains proved and links the proof, for example "18 of 18 independent checks passed".
- Restrained. One accent, one red point in the content of a page, no ornament. Whitespace and hairlines do the structuring.
- Evidential. The record comes before the claim.
- Plain. Sentence case, plain verbs, no hype words. A trade is settled, not transformed.
- Self-limiting. It says what it did not verify, for example "Cleanverse did not answer. That is not a refusal."

### Reasons to believe

- Live settlements on Monad Testnet and Base Sepolia with transaction evidence (`docs/implementation-status.md`).
- An independent verifier that derives SETTLED_FINAL from two chain RPCs and the guardian set, with no application database (`/verify/:id`).
- Compliance asked again after finality and before COMMIT.
- Core contracts are non-upgradeable and relayers are untrusted for correctness (`CLAUDE.md` invariants).

### Verbal identity

| Item              | Text                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tagline           | Two chains. One commitment.                                                                                                                             |
| Descriptor        | Cross-chain delivery versus payment for verified assets. A page title may shorten it, as the landing page does: "Conduit: cross-chain delivery versus payment". |
| Short description | Conduit settles a restricted asset on one chain against verified cash on another under one signed intent, without bridging or wrapping either.        |
| Voice             | Sentence case. Plain verbs. One claim per sentence. Numbers beat adjectives.                                                                            |
| Never claim       | Atomic (PRD section 0 forbids it for simultaneous execution across chains, and the brand avoids the word altogether). Trustless. Instant. Bridged or bridging as a feature. Refundable after COMMIT. Mainnet. Audited.                     |
| Always disclose   | Any surface that names the networks says Testnet or Sepolia. Observed Base finality has run 999 to 1485 seconds, so a copy line never promises speed.   |

### Avoid

The standing avoid list is in `brand.json` under `forbidden` and repeated under Image and render system. Two items are specific to this product. Anything that implies an asset travelling between chains (bridges, arches, tunnels, portals, swap arrows) contradicts the claim that nothing moves. Atoms and orbits contradict the rule against calling cross-chain execution atomic.

## Visual identity

### Concept territory

Territory: emotional outcome, two independent forms resolved at a single point. The user gains certainty that two separate things are settled together, so the mark shows exactly that: two equal modules and one point.

| Part    | What it is                                                                                           | What it says                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Modules | Two equal rounded squares that touch at one corner and never overlap.                                | The two parties and the two assets. Equal and separate. Neither leads.                                          |
| Point   | A circle in Ember at the contact.                                                                    | The commit decision. The only chromatic value in the system.                                                    |
| Socket  | A circular bite taken from each module's contact corner, leaving a 1u gap around the point.          | The decision belongs to neither party. Conduit holds no key that can move value, and the point touches nothing. |

The mark is unchanged by a 180 degree turn about the point. The descending diagonal is fixed: it reads as settling, where the ascending one reads as growth.

### Logo construction

The canvas is 16u by 16u with 1u = 4 units, so the master viewBox is 64 by 64. Every coordinate is a whole number of units. `showcase/conduit-construction.png` draws it.

| Element              | Value                                                                               |
| -------------------- | ----------------------------------------------------------------------------------- |
| Module               | 7u square. Module A spans 1u to 8u on both axes, module B spans 8u to 15u.          |
| Outer corner radius  | 2u, on the three corners of each module that do not touch.                          |
| Contact corner       | Sharp, then cut by the socket.                                                      |
| Socket radius        | 3u, centred on the contact point (8u, 8u).                                          |
| Point radius         | 2u, so the clearance ring is 1u.                                                    |
| Symmetry             | 180 degrees about the contact point. Module B is module A turned.                   |
| Angles               | 0 and 90 degrees only. Curves are circular arcs.                                    |
| Strokes              | None. The mark is fills, so no renderer can change its weight.                      |
| Negative space       | Never narrower than 1u, which is one whole pixel at 16 px.                          |
| Optical corrections  | None needed. The point is centred on the contact and the mass is symmetric.         |

Wordmark: Geist SemiBold (600), tracking -0.025em, outlined. Spacing is the typeface's own kerning (shaped with HarfBuzz) and no pair needed a manual change after review between 100 and 1024 px wide. The one custom detail is the tittle of the i. It is a rounded square as wide as the stem, with the module's corner ratio (8 to 28, so 0.2857), a miniature module. The rest is the font as drawn.

Lockups:

- Horizontal. The symbol is drawn at 1.5 times the master scale, which makes its canvas 0.96 em and its artwork 84 units against a cap height of 71 at 100 units per em. It is centred on the cap-height midline. The gap to the wordmark is 1.5 point diameters (0.36 em).
- Stacked. The symbol is drawn at 3 times the master scale and centred above the wordmark. The gap is 0.6 of a module.

### Responsive marks

| Use                           | File                                                                   | Notes                                                                       |
| ----------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Full                          | `source/conduit-lockup-horizontal.svg`                                 | Headers and documents. 96 px wide or more.                                  |
| Stacked                       | `source/conduit-lockup-stacked.svg`                                    | Square and tall spaces, covers.                                             |
| Compact                       | `source/conduit-symbol.svg`                                            | Wherever the name appears next to it or the space is under 96 px wide.      |
| Micro                         | `source/conduit-symbol.svg`, unchanged                                 | No separate drawing. See Minimum sizes.                                     |
| Wordmark alone                | `source/conduit-wordmark.svg`                                          | Only when the symbol is already on the same surface, as in the social cards. |
| Tile                          | `source/conduit-favicon-tile.svg`, `source/conduit-app-icon.svg`       | Browser fallback icons and app icons.                                       |
| Adaptive favicon              | `favicon/favicon.svg`                                                  | Bare symbol whose modules turn paper in a dark browser.                     |

### Clear space

One module of the symbol, as drawn at the size in use, on every side. In product chrome, where the sidebar and the header set their own padding, half a module is allowed. `showcase/conduit-clear-space-and-minimum-size.png` shows both.

### Minimum sizes

| Item                  | Minimum                |
| --------------------- | ---------------------- |
| Symbol                | 16 px, 4 mm in print   |
| Wordmark              | 72 px wide             |
| Horizontal lockup     | 96 px wide             |

The symbol needs no micro variant. Every coordinate is a whole pixel at 16, 32, 48 and 64 px, so the socket ring renders as a crisp 1 px line at 16 px (`explorations/03-pixel-check.png`, `validation/conduit-size-ladder.png`). Between those sizes, at 24 px for example, edges antialias and the mark stays legible.

### Motion principle

There is no motion asset yet. If one is built, the point arrives last. The modules settle into contact first, over about 200 ms with ease-out. Then the point appears from 60 percent to full size over about 120 ms with no overshoot and stays. The mark never loops, spins or pulses. A waiting state keeps the final frame and shows progress elsewhere. With reduced motion, show the final frame.

### Decision record

Six concepts were drawn on the same 64-unit grid, two for each of three territories, and compared on a neutral sheet before any polish (`explorations/01-concept-sheet.png`).

| Concept                    | Territory           | Family                        | Mechanism                                                       | Fails where                                                      | At 16 px                               | One colour                    | Without the wordmark                |
| -------------------------- | ------------------- | ----------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- | ----------------------------- | ----------------------------------- |
| C1 Offset                  | Literal mechanism   | Flow and path                 | Two runs at different heights joined by one step                | Reads as a letter Z or L                                         | A stair, the point is lost             | Holds                         | Reads as a glyph, not a mark        |
| C2 Interlock               | Literal mechanism   | Container and cut             | A square cut by a stepped slit into two congruent halves        | Reads as a letter e in a box                                     | Slit becomes a speck                   | Holds                         | Reads as a letter                   |
| C3 Pair and point          | Emotional outcome   | Paired and resolved forms     | Two modules touching at a corner, a point at the contact        | Looks like generic connected nodes until the socket is added     | Two blocks and a point, legible        | Holds, the point merges       | Holds                               |
| C4 Closing C               | Emotional outcome   | Aperture and monogram         | A C that stays open until the point closes it                   | Reads as the letter C followed by a full stop                    | Legible, heavy                         | Holds                         | Holds, but a crowded field of C marks |
| C5 Datum                   | Cultural position   | Interface grammar             | A dimension line between two fixed datums                       | Reads as the letter H                                            | Fails                                  | Holds                         | Reads as an H beam                  |
| C6 Dot-i wordmark          | Cultural position   | Wordmark led                  | Only the dot of the i is red                                    | No symbol, and the avatar is a red dot that reads as a status light | Fine as text                       | Holds                         | There is no symbol                  |

Scores on the eight criteria from the skill, 1 to 5, where 5 is best and the last column is lowest risk:

| Concept           | Relevance | Distinct | Recognisable | Silhouette | Small size | System | Category fit | Low risk | Total  |
| ----------------- | --------- | -------- | ------------ | ---------- | ---------- | ------ | ------------ | -------- | ------ |
| C1 Offset         | 5         | 3        | 3            | 3          | 3          | 3      | 4            | 3        | 27     |
| C2 Interlock      | 4         | 3        | 2            | 3          | 3          | 3      | 3            | 3        | 24     |
| C3 Pair and point | 5         | 4        | 4            | 5          | 4          | 5      | 4            | 3        | 34     |
| C4 Closing C      | 4         | 3        | 5            | 4          | 3          | 3      | 3            | 2        | 27     |
| C5 Datum          | 4         | 2        | 2            | 3          | 2          | 3      | 5            | 4        | 25     |
| C6 Dot-i          | 3         | 2        | 3            | 4          | 3          | 2      | 4            | 4        | 25     |

C3 scored 33 on the first sheet and 34 after the refinements below. These are an agent's scores, not a panel's.

Refinements made to C3, each from `explorations/`:

- Hollow-and-solid pair rejected. The hollow module's counter turns into a speck at 16 px.
- Ascending diagonal rejected. It reads as growth, which is the wrong message for settlement.
- Corner radius 8 and point radius 8 chosen over 10 and 7, because 10 smears into blobs at 16 px and 8 lands on whole pixels.
- Socket adopted. Overlapping the point on the modules looked like two nodes and a connector. Seating the point in a cut with a 1u clearance reads as a precision joint, survives in one colour as an ink ball in a paper ring, and says the decision touches neither party.

What would reopen this decision: a trademark search finding a conflicting mark, the owner asking for a different territory, or a failed legibility test on a platform not tested here.

## Colour

### Tokens

| Token      | Value     | Role                                                                                    |
| ---------- | --------- | --------------------------------------------------------------------------------------- |
| `ink`      | `#0a0a0a` | Modules, wordmark, text on paper.                                                       |
| `paper`    | `#ffffff` | Page surface. Modules and text on ink.                                                  |
| `ember`    | `#e7000b` | The point. The only chromatic value in brand graphics. At most one red point in the content of a page. Lockups in page chrome (header, sidebar, footer) do not count. In the interface it also marks errors and destructive actions, as text, icon strokes and a 6 px dot. Never a surface fill. |
| `inkSoft`  | `#171717` | Filled UI surfaces.                                                                     |
| `midGray`  | `#525252` | Secondary text on paper.                                                                |
| `hairline` | `#d4d4d4` | Rules and borders. Never text.                                                          |
| `canvas`   | `#f5f5f5` | Muted fills and secondary buttons.                                                      |
| `surfaceAlt` | `#fafafa` | Subtle surfaces.                                                                      |

There are no gradients and no tints of Ember.

### Roles

Identity colour is ink, paper and the single ember point. Everything else is a UI neutral for supporting text, rules and fills. Colour is never the only cue: the point is found by its position and its socket.

### Contrast and accessibility

Measured by `pnpm brand:check`, which fails if any floor is missed.

| Pair             | Ratio  | Floor | Use                                      |
| ---------------- | ------ | ----- | ---------------------------------------- |
| ink on paper     | 19.8:1 | 15    | Text and modules                         |
| paper on ink     | 19.8:1 | 15    | Reversed text and modules                |
| midGray on paper | 7.8:1  | 7     | Secondary text                           |
| ember on paper   | 4.8:1  | 4.5   | The point on paper                       |
| ember on ink     | 4.2:1  | 3     | The point on ink, non-text               |
| hairline on paper | 1.5:1 | none  | Decorative rules only, never carries meaning |

Colour-vision simulations are in `validation/conduit-accessibility.png`. Under protanopia and deuteranopia the point turns olive and stays clearly distinct from ink. Under a grayscale conversion the point becomes `#323232` or `#464646` depending on the weights used. That is 12.8:1 or 9.4:1 against paper but only 1.5:1 or 2.1:1 against ink. On paper that is fine. On the reversed lockup and the app icon the ground is ink, so the point nearly matches it and the socket ring alone marks its place. Where grayscale reproduction matters on a dark ground, use the one-colour white versions, whose point is white.

Forced colours. The lockup is drawn with fixed fills, which a forced-colours palette cannot remap, so the stylesheet repaints it in that mode: the letters and modules in the palette's text colour and the point in its highlight colour. Without that, the near-black letters sit on the forced black ground of a dark high-contrast theme and only the point shows.

### Forbidden combinations

- Ember on any ground other than paper or ink.
- Ember as a surface fill or a background, and Ember on HELD, CONTESTED or WAITING FOR FINALITY, which are not errors.
- A second chromatic value of any kind.
- Warm cream, beige or amber grounds.
- The Ember point on any grey from about `#2b2b2b` to `#cccccc`, where its contrast falls under 3:1 (1.07:1 at `#6e6e6e`). Ink and paper stay above 3:1 on greys from about `#5c5c5c` to `#959595`, so mid-grey grounds are ruled out by the point and not by the modules.

## Typography

### Display

Geist SemiBold (600). In brand graphics the headline tracking is -0.045em and the line height 1.04. The product UI uses 48 px at 600 with -0.05em, from `/design.md`. Headlines are sentence case, never all caps.

### Text

Geist Regular (400), tracking -0.005em, in `midGray` for supporting lines. No text under 21 px on a 1600 px wide graphic.

### Mono

The product's own `ui-monospace` stack, for addresses, hashes and states. The brand adds no monospace face.

### Licensing and fallbacks

Geist 1.8 is SIL Open Font License 1.1, from `https://github.com/vercel/geist-font`. The font files are not in this repository. The outlines of the wordmark and of the strings in `scripts/brand/type.json` are, as vector paths. `scripts/brand/author-type.py` regenerates them given the font files. The console does not serve Geist and falls back to the platform sans (see Source hierarchy, conflict 3). The Medium (500) weight was not available when the outlines were made, so no brand graphic uses it.

## Layout

### Grid and spacing

Brand graphics use a margin of 72 px on a 1200 by 630 card and scale from there. Two layouts exist: the link card (wordmark top left, claim and descriptor left, symbol right, URL bottom left) and the launch card (the same headline, descriptor and symbol, with the URL at top right on the wordmark's baseline and three plain claims under a hairline). The symbol sits on the vertical centre line. Text is left aligned, except the launch card's URL. Product spacing is the 4 px scale in `/design.md`.

### Radius and borders

Brand graphics use only the symbol's own radii. Hairlines are 1 px `#d4d4d4`. Product radii are 18 px for interactive elements and 24 px for containers, from `/design.md`.

### Shadow and depth

None in brand graphics. The symbol is flat.

### Responsive behaviour

The link card is generated at 1200 by 630 and 1280 by 640 from one layout function, scaled by the smaller of the two ratios. The launch card is 1600 by 900. Text and symbol keep their proportions. The headline stays readable at 150 px card width (`validation/conduit-link-previews.png`).

## Iconography

### Grid

The symbol is the only brand icon. It lives on the 16u canvas. The product's own functional icons are thin-stroke geometric marks per `/design.md`, and are outside this specification.

### Stroke and fill

The symbol is fills only. It has no strokes, which keeps it identical across renderers.

### Perspective

Flat.

### Reuse rules

- The symbol is never used as a bullet, a loading spinner, a repeated pattern or a decoration.
- The point is never used alone as an icon or an avatar. Alone it reads as a record button or a status light.
- Large crops of the symbol are allowed in layouts, as in the link card, if the whole mark is visible.
- The wordmark alone is allowed only when the symbol appears elsewhere on the same surface.

## Image and render system

The only render in the family is `apps/web/assets/hero-source.png`. It is reused as it is. These notes are observed from the image. The tool and prompt that produced it are not recorded in the repository.

### Composition

One wide object, two modules left and right joined by a cable, on a transparent ground. The modules are the same scale and angle, so neither dominates. A small connector sits at the midpoint.

### Camera

A high three-quarter view with mild perspective. The horizon is not visible.

### Lighting

Soft, diffuse studio light from above. No hard specular highlights except the gentle sheen of the steel top. No coloured light.

### Materials and finishes

One finish per material: satin white base, clear acrylic top over a black card on the left module, brushed stainless top on the right module, matte black flat cable, matte black connector housing. The connector carries one red indicator light, which is the only emissive element and casts no glow.

The bases measure (248, 247, 243) on the left and (240, 239, 235) on the right, about five levels warmer than neutral. The brand standard is neutral white. A neutral re-render is a sensible follow-up and was not done, since regenerating approved artwork is outside this task.

### Background and shadows

Transparent. A soft contact shadow only. No floor, no reflection, no backdrop gradient.

### Reference roles

| ID | File                              | Single allowed role                                   | Must not transfer                              |
| -- | --------------------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| R1 | `apps/web/assets/hero-source.png` | Material, composition and lighting of the hero object | Scale, crop, and the warm cast of the bases    |

### Standing avoid list

- Bridges, arches, tunnels, portals, vortices, swap arrows, double arrows.
- Chain links, hexagons, cubes, node networks, coins.
- Shields, padlocks, handshakes, checkmark-in-shield.
- Atoms, orbits, the word atomic.
- Gradients, glow, glass, blur, aurora, neon, dark-tech styling, bloom on the indicator light.
- Warm cream or amber grounds and warm casts on neutral materials.
- More than one red point in the content of a page.
- Text generated inside raster images.
- Soft plastic or clay looks, floating objects with no compositional reason, isometric rooms.

## Required deliverables

| Group                | Path                                                   | Purpose                                                                                      |
| -------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Lock record          | `brand/brand.json`                                     | Tokens, geometry, minimum sizes, forbidden list.                                             |
| Specification        | `brand/design.md`, `brand/guidelines.md`               | This file and the usage rules.                                                               |
| Masters              | `brand/source/*.svg`                                   | Symbol (4 colourways), wordmark (2), horizontal lockup (4), stacked lockup (2), app icon, favicon tile, three social cards. Generated. |
| Transparent exports  | `brand/raster/transparent/*.png`                       | Symbol 16 to 1024 px, wordmark, lockups.                                                     |
| App icons            | `brand/app-icons/*.png`                                | 1024, 512 and 180 px, opaque, no alpha channel.                                              |
| Favicons             | `brand/favicon/*`                                      | `favicon.svg`, `favicon.ico` (16, 32, 48), PNGs, Apple touch icon, 192 and 512 icons, maskable icon, `site.webmanifest`. |
| Social               | `brand/social/*.png`                                   | Link card 1200 by 630, GitHub card 1280 by 640, launch card 1600 by 900, avatars 400 and 1024. |
| Guideline diagrams   | `brand/showcase/*.png`                                 | Construction, clear space and minimum size, incorrect use.                                   |
| Evidence             | `brand/explorations/`, `brand/validation/`             | Concept sheets and the validation sheets. Captured on 2026-10-05, not regenerated by the build. |
| Registry             | `brand/manifest.json`                                  | Path, role, size, SHA-256, pixel size and alpha for every file.                              |
| Generator            | `scripts/build-brand.mjs`, `scripts/brand/`            | `pnpm brand:build` regenerates the kit and `pnpm brand:check` proves it has not drifted.     |

Not delivered, by design: a prompt ledger (no image generation was used), a motion asset, a print kit and merchandise. The kit is wired into the console; `guidelines.md` section 8 says where.

## Validation

### Acceptance report

- Source integrity: PASS. The hierarchy is documented, three conflicts are resolved and one goes to ADR-0023, existing assets were inspected, and the scope is explicit.
- Strategic relevance: PASS. The mark maps to the promise in PRD section 0 and its meaning is readable without a long explanation.
- Distinctiveness: CONDITIONAL. Two-module marks exist in other products. The socketed point, the 180 degree symmetry and the clear gap from the Monad, Base and Cleanverse marks that sit beside it (`validation/conduit-neighbours.png`) set it apart, but no search of external marks was run.
- Construction: PASS. A 16u grid, whole-number coordinates, no strokes, SVG is single-path. The brand-design skill's own validator, which is not in this repository, reported no errors, and `pnpm brand:check` is the check anyone can repeat.
- System consistency: PASS. Every SVG is generated from `brand.json` and `pnpm brand:check` compares bytes.
- Accessibility: CONDITIONAL. Contrast floors are enforced and colour is not the only cue. In grayscale on an ink ground the point is weak, noted above. No motion asset exists to test for reduced motion.
- Production: PASS. Masters exist, exports come from them, dimensions and alpha channels are checked, a manifest and guidelines exist, and no lettering is raster or live text.
- Integrity and risk: CONDITIONAL. No trademark clearance. The provenance of the hero render is unrecorded. Geist outlines are used under the OFL. The work was done by an AI agent without a human design review.

### Anti-slop scorecard

| Category              | Score | Reason                                                                                                       |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| Product specificity   | 2     | Two equal parties and a decision that touches neither, taken from the promise.                               |
| Concept clarity       | 1     | Two modules and a point reads at once. The socket's meaning needs a sentence.                                |
| Distinctiveness       | 1     | A modified familiar structure. The socket and symmetry are the departures.                                   |
| Geometry              | 2     | 16u grid, whole numbers, one symmetry.                                                                       |
| Small-size performance | 2    | Verified pixel by pixel at 16, 24 and 32 px.                                                                 |
| System potential      | 2     | Lockups, icons, cards, a point rule and a motion principle all derive from the same constants.               |
| Consistency           | 2     | One generator and a byte-level drift check.                                                                  |
| Accessibility         | 1     | Contrast and colour-vision checks pass. The grayscale-on-ink limit remains.                                  |
| Production readiness  | 2     | Masters, exports, manifest and checks.                                                                       |
| Integrity             | 2     | Limits and provenance are stated.                                                                            |
| Total                 | 17/20 | Above the 16 threshold, with no zero in the four hard-fail categories.                                       |

### Evidence

- `validation/conduit-size-ladder.png`: the exported files at native size, plus one-colour and lockup rows. The sheet labels the 96 px wordmark "(minimum)" and leaves the 72 px one unlabelled. The wordmark minimum is 72 px wide, as in Minimum sizes above; the 96 px minimum belongs to the horizontal lockup row.
- `validation/conduit-accessibility.png`: colour-vision and blur simulations.
- `validation/conduit-neighbours.png`: Conduit beside the Monad, Base, Cleanverse and bond marks it will sit next to.
- `validation/conduit-link-previews.png`, `validation/conduit-avatar-and-icon-masks.png`, `validation/conduit-tab-strip-light.png`, `validation/conduit-tab-strip-dark.png`.
- `validation/conduit-context-console-sidebar.png` and `validation/conduit-context-landing-nav.png`: the live console and landing with the lockup swapped in by script. They are previews made before the identity was wired in.
- A measured check that `favicon/favicon.svg` renders its modules as `10,10,10` in a light browser and `255,255,255` in a dark one.

### Remaining risks

- Trademark clearance has not been performed and a specialist review is advisable before commercial use.
- The hero render has an unrecorded origin and a faint warm cast.
- Ember is the error colour elsewhere in the product. The comments and `design.md` lines that called it never decoration were reworded when the identity was wired in (ADR-0023). Error red is text, icon strokes and a 6 px dot, and the point is a filled circle inside a logo. At the sidebar's 20 px height the point is about the size of the failed-transaction dot, so a page that shows a failed transaction shows two small red dots, and a reader still meets red in both roles.
- On the landing page the header lockup, the footer lockup and the hero render's indicator light are all red. The lockups are page chrome and the light is the hero's own point, so the rule holds, but a stricter reading would ask for a neutral re-render of the hero.
- The wordmark's custom tittle is invisible below roughly 24 px, where the lockup reads as plain Geist.
- Colour-vision simulations use common approximate matrices and not a calibrated tool.
