/**
 * Every Conduit brand asset, as SVG, derived from `brand/brand.json` and the lettering
 * outlines in `scripts/brand/type.json`.
 *
 * Nothing here draws a colour, a radius or a distance of its own: they are all read from
 * the lock record, so the symbol, the lockups, the icons and the social cards cannot
 * drift apart. Output is deterministic string building, which is what lets
 * `build-brand.mjs --check` compare committed SVG byte for byte.
 */

/** Two decimals, no trailing zeros, never "-0". */
export const n = (value) => {
  const text = (Math.round(value * 100) / 100).toString();
  return text === '-0' ? '0' : text;
};

const XMLNS = 'http://www.w3.org/2000/svg';

/**
 * @param {{ brand: any, type: any }} inputs
 */
export function createGeometry({ brand, type }) {
  const colour = Object.fromEntries(Object.entries(brand.colour).map(([k, v]) => [k, v.value]));
  const sym = brand.geometry.symbol;
  const canvas = brand.geometry.grid.canvas;
  const word = type.strings.wordmark;
  const tittleSpec = brand.typography.wordmark.tittle;

  // ── Palettes: the four ways the mark may be coloured ──────────────────────
  const palettes = {
    positive: { module: colour.ink, point: colour.ember, text: colour.ink, ground: colour.paper },
    reversed: { module: colour.paper, point: colour.ember, text: colour.paper, ground: colour.ink },
    'mono-black': { module: colour.ink, point: colour.ink, text: colour.ink, ground: colour.paper },
    'mono-white': {
      module: colour.paper,
      point: colour.paper,
      text: colour.paper,
      ground: colour.ink,
    },
  };

  /**
   * Every master carries an intrinsic size equal to its viewBox. A viewBox alone makes
   * an <img> stretch to its container, which is how a logo ends up filling a README.
   */
  const wrap = (viewBox, body, { title } = {}) => {
    const [, , w, h] = viewBox.split(' ').map(Number);
    return (
      `<svg xmlns="${XMLNS}" viewBox="${viewBox}" width="${n(w)}" height="${n(h)}" fill="none"${title === undefined ? '' : ' role="img"'}>` +
      `${title === undefined ? '' : `<title>${title}</title>`}${body}</svg>\n`
    );
  };

  // ── The symbol ────────────────────────────────────────────────────────────
  /**
   * Two modules and a point, on the 64-unit canvas.
   *
   * Module A is the top-left square: three rounded corners, and a fourth that is sharp
   * and then bitten away by the socket. Module B is A turned 180 degrees about the
   * contact point, so the two are equal and neither leads. The point sits in the socket
   * and touches neither.
   */
  function symbolPaths() {
    const { inset: i, cornerRadius: r, socketRadius: b } = sym;
    const c = sym.contact[0];
    const m = (x) => 2 * c - x; // the 180 degree turn about (c, c)

    const a =
      `M${i + r} ${i}H${c - r}A${r} ${r} 0 0 1 ${c} ${i + r}V${c - b}A${b} ${b} 0 0 0 ${c - b} ${c}` +
      `H${i + r}A${r} ${r} 0 0 1 ${i} ${c - r}V${i + r}A${r} ${r} 0 0 1 ${i + r} ${i}Z`;
    const bm =
      `M${m(i + r)} ${m(i)}H${m(c - r)}A${r} ${r} 0 0 1 ${m(c)} ${m(i + r)}V${m(c - b)}A${b} ${b} 0 0 0 ${m(c - b)} ${m(c)}` +
      `H${m(i + r)}A${r} ${r} 0 0 1 ${m(i)} ${m(c - r)}V${m(i + r)}A${r} ${r} 0 0 1 ${m(i + r)} ${m(i)}Z`;
    return { modules: a + bm, point: { cx: c, cy: c, r: sym.pointRadius } };
  }

  /** The symbol's drawing, without an svg wrapper, in canvas units. */
  function symbolBody(variant) {
    const p = palettes[variant];
    const { modules, point } = symbolPaths();
    return `<path fill="${p.module}" d="${modules}"/><circle cx="${point.cx}" cy="${point.cy}" r="${point.r}" fill="${p.point}"/>`;
  }

  /** The symbol alone, as a square on its 64-unit canvas. */
  function symbol(variant) {
    return wrap(`0 0 ${canvas} ${canvas}`, symbolBody(variant), { title: 'Conduit' });
  }

  // ── The wordmark ──────────────────────────────────────────────────────────
  const roundedSquare = (x, y, s, r) =>
    `M${n(x + r)} ${n(y)}H${n(x + s - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + s)} ${n(y + r)}V${n(y + s - r)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + s - r)} ${n(y + s)}H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + s - r)}` +
    `V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`;

  /**
   * "Conduit" at 100 units per em with baseline at y=0, plus its own tittle.
   *
   * The font's dotless i is used and the dot is drawn here: a rounded square that is a
   * miniature of a module, with the module's corner ratio. That is the wordmark's one
   * deliberate departure from the typeface.
   */
  function wordmarkBody(variant) {
    const p = palettes[variant];
    const stem = word.stem;
    const side = (stem.x1 - stem.x0) * tittleSpec.sideToStem;
    const x = (stem.x0 + stem.x1) / 2 - side / 2;
    const top = -tittleSpec.topEm * 100;
    const tittle = roundedSquare(x, top, side, side * tittleSpec.radiusToSide);
    const bbox = [word.bbox[0], Math.min(word.bbox[1], top), word.bbox[2], word.bbox[3]];
    return {
      body: `<path fill="${p.text}" d="${word.d}"/><path fill="${p.text}" d="${tittle}"/>`,
      bbox,
    };
  }

  function wordmark(variant) {
    const { body, bbox } = wordmarkBody(variant);
    const pad = 0;
    const vb = [
      bbox[0] - pad,
      bbox[1] - pad,
      bbox[2] - bbox[0] + 2 * pad,
      bbox[3] - bbox[1] + 2 * pad,
    ];
    return wrap(vb.map(n).join(' '), body, { title: 'Conduit' });
  }

  // ── Lockups ───────────────────────────────────────────────────────────────
  const artwork = canvas - 2 * sym.inset; // 56: the symbol without its inset

  function lockupHorizontal(variant) {
    const spec = brand.geometry.lockup.horizontal;
    const k = spec.symbolScale;
    const w = wordmarkBody(variant);
    const capMid = -word.capHeight / 2;
    const tx = -sym.inset * k;
    const ty = capMid - (canvas / 2) * k;
    const artTop = ty + sym.inset * k;
    const artBottom = ty + (canvas - sym.inset) * k;
    const artRight = artwork * k;
    const gap = spec.gapPointDiameters * 2 * sym.pointRadius * k;
    const textLeft = artRight + gap;
    const dx = textLeft - w.bbox[0];

    const top = Math.min(artTop, w.bbox[1]);
    const bottom = Math.max(artBottom, w.bbox[3]);
    const right = textLeft + (w.bbox[2] - w.bbox[0]);
    const body =
      `<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(k)})">${symbolBody(variant)}</g>` +
      `<g transform="translate(${n(dx)} 0)">${w.body}</g>`;
    return wrap([0, top, right, bottom - top].map(n).join(' '), body, { title: 'Conduit' });
  }

  function lockupStacked(variant) {
    const spec = brand.geometry.lockup.stacked;
    const k = spec.symbolScale;
    const w = wordmarkBody(variant);
    const textW = w.bbox[2] - w.bbox[0];
    const artW = artwork * k;
    const gap = spec.gapModules * sym.module * k;

    const tx = textW / 2 - artW / 2 - sym.inset * k;
    const ty = -sym.inset * k;
    const wordTop = artW + gap;
    const baseline = wordTop - w.bbox[1];
    const dx = -w.bbox[0];
    const bottom = baseline + w.bbox[3];

    const body =
      `<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(k)})">${symbolBody(variant)}</g>` +
      `<g transform="translate(${n(dx)} ${n(baseline)})">${w.body}</g>`;
    return wrap([0, 0, textW, bottom].map(n).join(' '), body, { title: 'Conduit' });
  }

  // ── Icons ─────────────────────────────────────────────────────────────────
  /** Full-bleed ink square. Platforms apply their own mask, so there is no corner radius. */
  function appIcon(ratio = brand.geometry.appIcon.symbolCanvasRatio) {
    const size = 1024;
    const canvasPx = size * ratio;
    const scale = canvasPx / canvas;
    const offset = (size - canvasPx) / 2;
    const body =
      `<rect width="${size}" height="${size}" fill="${colour.ink}"/>` +
      `<g transform="translate(${n(offset)} ${n(offset)}) scale(${n(scale)})">${symbolBody('reversed')}</g>`;
    return wrap(`0 0 ${size} ${size}`, body, { title: 'Conduit' });
  }

  /**
   * The tile used for raster favicons: the symbol on ink with the tile corner concentric
   * with the module corner, so the padding is exactly the symbol's own inset.
   */
  function faviconTile() {
    const r = sym.inset + sym.cornerRadius;
    const body = `<rect width="${canvas}" height="${canvas}" rx="${r}" fill="${colour.ink}"/>${symbolBody('reversed')}`;
    return wrap(`0 0 ${canvas} ${canvas}`, body, { title: 'Conduit' });
  }

  /** The bare symbol, switching its modules to paper when the tab strip is dark. */
  function faviconAdaptive() {
    const { modules, point } = symbolPaths();
    const style = `<style>.m{fill:${colour.ink}}@media (prefers-color-scheme:dark){.m{fill:${colour.paper}}}</style>`;
    const body = `${style}<path class="m" d="${modules}"/><circle cx="${point.cx}" cy="${point.cy}" r="${point.r}" fill="${colour.ember}"/>`;
    return wrap(`0 0 ${canvas} ${canvas}`, body);
  }

  // ── Social cards ──────────────────────────────────────────────────────────
  /** Places an outlined string: left edge of its ink at x, baseline at y, cap size in px. */
  const textAt = (key, x, baseline, fontPx, fill) => {
    const s = type.strings[key];
    const scale = fontPx / 100;
    return `<g transform="translate(${n(x - s.bbox[0] * scale)} ${n(baseline)}) scale(${n(scale)})"><path fill="${fill}" d="${s.d}"/></g>`;
  };
  const widthOf = (key, fontPx) => {
    const s = type.strings[key];
    return (s.bbox[2] - s.bbox[0]) * (fontPx / 100);
  };

  /** The wordmark alone, placed by its ink: left at x, baseline at y, font size in px. */
  const wordmarkAt = (x, baseline, fontPx, variant) => {
    const w = wordmarkBody(variant);
    const scale = fontPx / 100;
    return `<g transform="translate(${n(x - w.bbox[0] * scale)} ${n(baseline)}) scale(${n(scale)})">${w.body}</g>`;
  };

  /** The symbol drawn so its artwork (not its canvas) is `artPx` wide, top-left at (x, y). */
  const symbolAt = (x, y, artPx, variant) => {
    const k = artPx / artwork;
    return `<g transform="translate(${n(x - sym.inset * k)} ${n(y - sym.inset * k)}) scale(${n(k)})">${symbolBody(variant)}</g>`;
  };

  /**
   * The link-preview card. White ground, the wordmark top left, the claim and its
   * descriptor on the left, and the symbol large on the right. The point in the symbol
   * is the only ember on the card.
   */
  function socialCard(w, h) {
    const s = Math.min(w / 1200, h / 630);
    const M = 72 * s;
    const ink = colour.ink;
    const gray = colour.midGray;

    const wordPx = 44 * s;
    const wordBaseline = M + 0.71 * wordPx;

    const art = 372 * s; // symbol artwork width
    const artX = w - M - art;
    const artY = (h - art) / 2;

    const headPx = 78 * s;
    const lead = headPx * 1.04;
    const headBase1 = h / 2 - 0.42 * headPx;
    const headBase2 = headBase1 + lead;

    const descPx = 27 * s;
    const descBase1 = headBase2 + 1.55 * descPx + 0.3 * headPx;
    const descBase2 = descBase1 + descPx * 1.42;

    const urlPx = 24 * s;
    const urlBase = h - M;

    const body =
      `<rect width="${w}" height="${h}" fill="${colour.paper}"/>` +
      wordmarkAt(M, wordBaseline, wordPx, 'positive') +
      textAt('headline.1', M, headBase1, headPx, ink) +
      textAt('headline.2', M, headBase2, headPx, ink) +
      textAt('descriptor.1', M, descBase1, descPx, gray) +
      textAt('descriptor.2', M, descBase2, descPx, gray) +
      textAt('url', M, urlBase, urlPx, ink) +
      symbolAt(artX, artY, art, 'positive');
    return wrap(`0 0 ${w} ${h}`, body, { title: 'Conduit. Two chains. One commitment.' });
  }

  /** The 16:9 launch card: the same voice with room for three plain claims. */
  function launchCard(w, h) {
    const s = w / 1600;
    const M = 96 * s;
    const ink = colour.ink;
    const gray = colour.midGray;

    const wordPx = 52 * s;
    const wordBaseline = M + 0.71 * wordPx;

    const art = 440 * s;
    const artX = w - M - art;
    const artY = 176 * s;

    const headPx = 112 * s;
    const lead = headPx * 1.04;
    const headBase1 = 360 * s;
    const headBase2 = headBase1 + lead;

    const descPx = 34 * s;
    const descBase1 = headBase2 + 1.9 * descPx + 0.25 * headPx;
    const descBase2 = descBase1 + descPx * 1.42;

    const ruleY = h - 238 * s;
    const colW = (w - 2 * M - 2 * 56 * s) / 3;
    const titlePx = 29 * s;
    const bodyPx = 21 * s;
    const facts = [1, 2, 3]
      .map((i) => {
        const x = M + (i - 1) * (colW + 56 * s);
        const y0 = ruleY + 66 * s;
        return (
          textAt(`fact.${i}.title`, x, y0, titlePx, ink) +
          textAt(`fact.${i}.body.1`, x, y0 + 44 * s, bodyPx, gray) +
          textAt(`fact.${i}.body.2`, x, y0 + 44 * s + bodyPx * 1.45, bodyPx, gray)
        );
      })
      .join('');

    const body =
      `<rect width="${w}" height="${h}" fill="${colour.paper}"/>` +
      wordmarkAt(M, wordBaseline, wordPx, 'positive') +
      textAt('headline.1', M, headBase1, headPx, ink) +
      textAt('headline.2', M, headBase2, headPx, ink) +
      textAt('descriptor.1', M, descBase1, descPx, gray) +
      textAt('descriptor.2', M, descBase2, descPx, gray) +
      symbolAt(artX, artY, art, 'positive') +
      `<rect x="${n(M)}" y="${n(ruleY)}" width="${n(w - 2 * M)}" height="${n(Math.max(1, s))}" fill="${colour.hairline}"/>` +
      facts +
      textAt('url', w - M - widthOf('url', 26 * s), wordBaseline, 26 * s, gray);
    return wrap(`0 0 ${w} ${h}`, body, { title: 'Conduit. Two chains. One commitment.' });
  }

  return {
    colour,
    palettes,
    symbolPaths,
    symbol,
    wordmark,
    lockupHorizontal,
    lockupStacked,
    appIcon,
    faviconTile,
    faviconAdaptive,
    socialCard,
    launchCard,
  };
}
