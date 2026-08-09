/**
 * Real brand marks, inlined and monochrome.
 *
 * ## Why inline, and why no colour
 *
 * The Worker sends `default-src 'none'`, so nothing can be fetched from an
 * external origin — a remote logo URL would simply not load. These are inlined
 * as SVG markup rather than `img` tags with data URIs, which keeps them
 * styleable: every path is `currentColor`, so a mark inherits Ink or Mid Gray
 * from whatever it sits in.
 *
 * That is also what `design.md` asks for. It permits exactly one chromatic
 * token and calls for "compact monochrome chain marks", so these carry the
 * authentic geometry of each brand and none of the brand colour. Base's mark is
 * `#0000FF` at source and Monad's is purple; rendering either in its own hue
 * would put two more colours into a system that allows none.
 *
 * ## Provenance
 *
 * - `base` — the official Base brand kit, `base-org/brand-kit`,
 *   `logo/TheSquare/Digital/Base_square_black.svg`. Base's current mark is the
 *   rounded square; the geometry here matches that file exactly.
 * - `monad` — `0xa3k5/web3icons`, `networks/mono/monad.svg`. Monad publishes no
 *   first-party SVG at a URL I could retrieve, so this was checked against the
 *   mark the project owner supplied directly: the same rounded diamond with the
 *   offset inner cut, differing only in the brand purple this drops.
 * - `cleanverse` — the official Cleanverse Media Kit,
 *   `Cleanverse logo_SVG/logo icon -black.svg`. Cleanverse released the kit for
 *   use in builds without further permission. The source draws the mark in
 *   white on a black square; the square is dropped and the two rings become
 *   `currentColor`, which is the mark itself rather than its container.
 */

export type MarkName = 'monad' | 'base' | 'cleanverse' | 'bond';

interface Mark {
  /** The source viewBox. Geometry is never rescaled by hand. */
  readonly viewBox: string;
  readonly body: string;
  /** What a screen reader should say when the mark stands alone. */
  readonly label: string;
}

const MARKS: Readonly<Record<MarkName, Mark>> = Object.freeze({
  monad: {
    viewBox: '0 0 24 24',
    label: 'Monad',
    body: '<path fill="currentColor" d="M12 3C9.40096 3 3 9.40082 3 12C3 14.5991 9.40096 21 12 21C14.5989 21 21 14.599 21 12C21 9.40093 14.599 3 12 3ZM10.5975 17.1464C9.5015 16.8478 6.55489 11.6934 6.85359 10.5974C7.15229 9.50142 12.3065 6.55489 13.4025 6.85357C14.4985 7.15223 17.4451 12.3065 17.1464 13.4025C16.8477 14.4985 11.6934 17.4451 10.5975 17.1464Z"/>',
  },
  base: {
    viewBox: '0 0 24 24',
    label: 'Base',
    body: '<path fill="currentColor" d="M3.0009 4.70623C3.0009 4.12129 3.0009 3.82882 3.11069 3.60474C3.21598 3.38966 3.39056 3.21508 3.60564 3.10979C3.82972 3 4.12219 3 4.70623 3H19.2938C19.8787 3 20.1703 3 20.3953 3.10979C20.6103 3.21508 20.784 3.39056 20.8893 3.60474C21 3.82972 21 4.12219 21 4.70623V19.2938C21 19.8787 21 20.1703 20.8893 20.3953C20.784 20.6103 20.6094 20.784 20.3953 20.8893C20.1703 21 19.8778 21 19.2938 21H4.70623C4.12129 21 3.82972 21 3.60474 20.8893C3.38966 20.784 3.21598 20.6094 3.11069 20.3953C3 20.1703 3 19.8778 3 19.2938V4.70623H3.0009Z"/>',
  },
  /**
   * Drawn as the kit's tile rather than as bare rings.
   *
   * The two arcs are hairline-thin at 18px and read as a copyright symbol at
   * that size. Cleanverse's own icon file solves this the same way — the mark
   * knocked out of a filled square — so this follows their treatment, with the
   * fill taken from `currentColor` and the knockout from the paper token
   * instead of their black and white.
   */
  cleanverse: {
    viewBox: '0 0 1016 1016',
    label: 'Cleanverse',
    body:
      '<rect width="1016" height="1016" rx="232" fill="currentColor"/>' +
      '<path fill="var(--color-paper)" d="M510.777 250C620.759 250 714.447 319.763 750.004 417.451C757.039 436.782 741.486 455.661 720.916 455.661C706.058 455.661 693.337 445.515 687.682 431.776C659.063 362.236 590.639 313.279 510.777 313.279C405.166 313.28 319.551 398.894 319.551 504.505C319.551 610.116 405.166 695.731 510.777 695.731C590.638 695.731 659.063 646.774 687.682 577.235C693.337 563.496 706.058 553.35 720.916 553.35C741.486 553.35 757.039 572.229 750.003 591.559C714.447 689.248 620.759 759.011 510.777 759.011C370.217 759.011 256.272 645.064 256.272 504.505C256.272 363.946 370.218 250 510.777 250Z"/>' +
      '<path fill="var(--color-paper)" d="M510.776 352.831C565.299 352.831 613.101 381.599 639.833 424.785C651.797 444.113 635.28 465.944 612.549 465.944C599.238 465.944 587.535 457.915 579.012 447.69C562.725 428.15 538.203 415.714 510.776 415.714C461.738 415.714 421.985 455.467 421.985 504.505C421.985 553.543 461.738 593.296 510.776 593.296C539.002 593.296 564.15 580.126 580.413 559.596C588.864 548.928 600.741 540.496 614.35 540.496C636.656 540.496 653.057 561.714 641.795 580.969C615.482 625.959 566.659 656.18 510.776 656.18C427.009 656.18 359.102 588.273 359.102 504.505C359.102 420.738 427.009 352.831 510.776 352.831Z"/>',
  },
  /**
   * The restricted bond is issued by this project for the demonstration, so it
   * has no brand to borrow. A drawn mark is honest where a borrowed one would
   * imply an issuer that does not exist.
   */
  bond: {
    viewBox: '0 0 24 24',
    label: 'Restricted bond',
    body: '<rect x="3.75" y="5.75" width="16.5" height="12.5" rx="2.25" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 9.5h9M7.5 12.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  },
});

/**
 * A brand mark at a given size.
 *
 * `aria-hidden` by default because these almost always sit beside their own
 * name; pass `standalone` when the mark is the only thing identifying a thing.
 */
export function mark(name: MarkName, size = 18, standalone = false): string {
  const found = MARKS[name];
  const label = standalone
    ? ` role="img" aria-label="${found.label}"`
    : ' aria-hidden="true" focusable="false"';
  return `<svg class="mark" width="${String(size)}" height="${String(size)}" viewBox="${found.viewBox}" fill="none"${label}>${found.body}</svg>`;
}

/** Which mark belongs to a chain. */
export function markForChain(chainId: number): MarkName | undefined {
  if (chainId === 10143) return 'monad';
  if (chainId === 84532) return 'base';
  return undefined;
}

/**
 * Which mark belongs to an asset.
 *
 * `cSETTLE` is a Cleanverse A-Token, so it carries the Cleanverse mark — that
 * is a statement about who issues and governs the unit, not decoration.
 */
export function markForAsset(symbol: string): MarkName {
  return symbol === 'cSETTLE' ? 'cleanverse' : 'bond';
}
