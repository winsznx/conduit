#!/usr/bin/env node
/**
 * Builds the Conduit brand kit from its lock record, and proves it has not drifted.
 *
 *   node scripts/build-brand.mjs                  # regenerate every source SVG and export
 *   node scripts/build-brand.mjs --manifest-only  # re-hash the kit without rendering
 *   node scripts/build-brand.mjs --check          # fail on any drift; needs no browser
 *
 * ## What is generated, and from what
 *
 * Every SVG under `brand/source/` is built by `scripts/brand/geometry.mjs` from
 * `brand/brand.json` and the lettering outlines in `scripts/brand/type.json`. No asset
 * carries a number of its own, so the symbol, the lockups, the icons and the social
 * cards cannot disagree. Rasters are rendered from those SVGs in Chromium, which the
 * repository already pins for its browser tests.
 *
 * ## Why `--check` does not re-render
 *
 * SVG generation is plain string building, so `--check` regenerates the SVG and compares
 * bytes. PNG pixels are not stable across Chromium builds and operating systems, so a
 * byte comparison would flake. `--check` instead holds every file to `manifest.json`
 * (hash, size, pixel dimensions, alpha channel) and holds the SVG to structural rules.
 * A re-render produces a different but equivalent PNG, and `brand:build` updates the
 * manifest with it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { createGeometry } from './brand/geometry.mjs';
import { ROOT } from './lib/run.mjs';

const BRAND = join(ROOT, 'brand');
const MANIFEST = join(BRAND, 'manifest.json');

const brand = JSON.parse(readFileSync(join(BRAND, 'brand.json'), 'utf8'));
const type = JSON.parse(readFileSync(join(ROOT, 'scripts', 'brand', 'type.json'), 'utf8'));
const g = createGeometry({ brand, type });

// ── The plan ────────────────────────────────────────────────────────────────

/** The aspect ratio of an svg's viewBox. */
function ratioOf(svg) {
  const [, , w, h] = /viewBox="([^"]+)"/.exec(svg)[1].split(/\s+/).map(Number);
  return w / h;
}

const VARIANTS = ['positive', 'reversed', 'mono-black', 'mono-white'];
const suffix = (variant) => (variant === 'positive' ? '' : `-${variant}`);

/** Every SVG the kit contains: where it goes, and its text. */
function svgPlan() {
  const files = [];
  const add = (path, content, role) => files.push({ path, content, role });

  for (const v of VARIANTS) add(`source/conduit-symbol${suffix(v)}.svg`, g.symbol(v), 'master');
  for (const v of ['positive', 'reversed'])
    add(`source/conduit-wordmark${suffix(v)}.svg`, g.wordmark(v), 'master');
  for (const v of VARIANTS)
    add(`source/conduit-lockup-horizontal${suffix(v)}.svg`, g.lockupHorizontal(v), 'master');
  for (const v of ['positive', 'reversed'])
    add(`source/conduit-lockup-stacked${suffix(v)}.svg`, g.lockupStacked(v), 'master');
  add('source/conduit-app-icon.svg', g.appIcon(), 'master');
  add('source/conduit-favicon-tile.svg', g.faviconTile(), 'master');
  add('favicon/favicon.svg', g.faviconAdaptive(), 'export');
  add('source/conduit-og.svg', g.socialCard(1200, 630), 'master');
  add('source/conduit-github-social.svg', g.socialCard(1280, 640), 'master');
  add('source/conduit-launch-card.svg', g.launchCard(1600, 900), 'master');
  return files;
}

/** Every PNG: the svg it comes from, its pixel size, and whether it may be transparent. */
function rasterPlan() {
  const jobs = [];
  const add = (path, svg, width, height, transparent, budget = 150_000) =>
    jobs.push({ path, svg, width, height, transparent, budget });
  const byWidth = (path, svg, width, transparent) =>
    add(path, svg, width, Math.round(width / ratioOf(svg)), transparent);

  const symbolSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  for (const v of ['positive', 'reversed']) {
    for (const s of symbolSizes)
      add(`raster/transparent/conduit-symbol${suffix(v)}-${s}.png`, g.symbol(v), s, s, true);
  }
  for (const v of ['mono-black', 'mono-white']) {
    for (const s of [256, 1024])
      add(`raster/transparent/conduit-symbol${suffix(v)}-${s}.png`, g.symbol(v), s, s, true);
  }
  for (const v of ['positive', 'reversed']) {
    for (const w of [512, 1024])
      byWidth(`raster/transparent/conduit-wordmark${suffix(v)}-${w}.png`, g.wordmark(v), w, true);
  }
  for (const v of ['positive', 'reversed']) {
    for (const w of [256, 512, 1024, 2048])
      byWidth(
        `raster/transparent/conduit-lockup-horizontal${suffix(v)}-${w}.png`,
        g.lockupHorizontal(v),
        w,
        true,
      );
  }
  for (const v of ['mono-black', 'mono-white']) {
    for (const w of [512, 1024])
      byWidth(
        `raster/transparent/conduit-lockup-horizontal${suffix(v)}-${w}.png`,
        g.lockupHorizontal(v),
        w,
        true,
      );
  }
  for (const v of ['positive', 'reversed']) {
    for (const w of [512, 1024])
      byWidth(
        `raster/transparent/conduit-lockup-stacked${suffix(v)}-${w}.png`,
        g.lockupStacked(v),
        w,
        true,
      );
  }

  // Opaque: platforms mask these, and the App Store refuses an alpha channel.
  for (const s of [1024, 512, 180])
    add(`app-icons/conduit-app-icon-${s}.png`, g.appIcon(), s, s, false);

  const tile = g.faviconTile();
  add('favicon/favicon-16x16.png', tile, 16, 16, true);
  add('favicon/favicon-32x32.png', tile, 32, 32, true);
  add('favicon/apple-touch-icon.png', g.appIcon(), 180, 180, false);
  add('favicon/icon-192.png', g.appIcon(brand.geometry.appIcon.anyPurposeRatio), 192, 192, false);
  add('favicon/icon-512.png', g.appIcon(brand.geometry.appIcon.anyPurposeRatio), 512, 512, false);
  add(
    'favicon/icon-maskable-512.png',
    g.appIcon(brand.geometry.appIcon.symbolCanvasRatio),
    512,
    512,
    false,
  );

  add('social/conduit-og-1200x630.png', g.socialCard(1200, 630), 1200, 630, false, 300_000);
  add(
    'social/conduit-github-social-1280x640.png',
    g.socialCard(1280, 640),
    1280,
    640,
    false,
    300_000,
  );
  add(
    'social/conduit-launch-card-1600x900.png',
    g.launchCard(1600, 900),
    1600,
    900,
    false,
    400_000,
  );
  add('social/conduit-avatar-1024.png', g.appIcon(), 1024, 1024, false);
  add('social/conduit-avatar-400.png', g.appIcon(), 400, 400, false);
  return jobs;
}

/** Icons rendered once and packed into favicon.ico. */
const ICO_SIZES = [16, 32, 48];

function webManifest() {
  return (
    JSON.stringify(
      {
        name: 'Conduit',
        short_name: 'Conduit',
        description: brand.concept.descriptor,
        start_url: '/',
        display: 'standalone',
        background_color: brand.colour.paper.value,
        theme_color: brand.colour.paper.value,
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      null,
      2,
    ) + '\n'
  );
}

// ── Files ───────────────────────────────────────────────────────────────────

const abs = (path) => join(BRAND, path);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function write(path, data) {
  mkdirSync(dirname(abs(path)), { recursive: true });
  writeFileSync(abs(path), data);
}

/** Every file under brand/, relative, sorted, minus the manifest and OS noise. */
function walk(dir = BRAND) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === '.DS_Store') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full !== MANIFEST) out.push(relative(BRAND, full).split('\\').join('/'));
  }
  return out;
}

// ── PNG and ICO ─────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngInfo(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  const colourType = buffer[25];
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colourType,
    hasAlpha: colourType === 4 || colourType === 6,
  };
}

/** A PNG-compressed icon directory: legal since Windows Vista, and every browser reads it. */
function buildIco(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, i) => {
    const at = 6 + i * 16;
    header[at] = size >= 256 ? 0 : size;
    header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

function icoInfo(buffer) {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return undefined;
  const count = buffer.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    const length = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    const info = pngInfo(buffer.subarray(offset, offset + length));
    if (info === undefined || info.width !== (buffer[at] || 256)) return undefined;
    sizes.push(info.width);
  }
  return sizes;
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** Replaces the master's intrinsic size with the pixel size being rendered. */
const withSize = (svg, width, height) =>
  svg
    .replace(/ width="[^"]*" height="[^"]*"/, '')
    .replace('<svg ', `<svg width="${width}" height="${height}" `);

async function render(jobs, icoSvg) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const context = await browser.newContext({ deviceScaleFactor: 1 });

  const shoot = async (svg, width, height, transparent) => {
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${withSize(svg, width, height)}</body></html>`,
    );
    const png = await page.screenshot({
      omitBackground: transparent,
      clip: { x: 0, y: 0, width, height },
    });
    await page.close();
    return png;
  };

  try {
    for (const job of jobs) {
      write(job.path, await shoot(job.svg, job.width, job.height, job.transparent));
      console.log(`  ${job.path}`);
    }
    const entries = [];
    for (const size of ICO_SIZES)
      entries.push({ size, png: await shoot(icoSvg, size, size, true) });
    write('favicon/favicon.ico', buildIco(entries));
    console.log('  favicon/favicon.ico');
  } finally {
    await browser.close();
  }
}

// ── Manifest ────────────────────────────────────────────────────────────────

const ROLE_BY_DIR = {
  source: 'master',
  raster: 'export',
  'app-icons': 'export',
  favicon: 'export',
  social: 'export',
  showcase: 'guideline',
  explorations: 'evidence',
  validation: 'evidence',
};

function describe(path) {
  const data = readFileSync(abs(path));
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const top = path.split('/')[0];
  const item = {
    path,
    role: ROLE_BY_DIR[top] ?? 'document',
    bytes: data.length,
    sha256: sha256(data),
    extension: ext,
    version: brand.brand.version,
    source: top === 'source' || ['.md', '.json'].includes(ext),
    approval: brand.brand.status,
  };
  if (ext === '.svg') item.viewBox = /viewBox="([^"]+)"/.exec(data.toString('utf8'))?.[1] ?? null;
  if (ext === '.png') {
    const info = pngInfo(data);
    item.width = info.width;
    item.height = info.height;
    item.alpha = info.hasAlpha;
  }
  if (ext === '.ico') item.sizes = icoInfo(data);
  return item;
}

function buildManifest() {
  const assets = walk().map(describe);
  return (
    JSON.stringify(
      { version: brand.brand.version, root: 'brand', assetCount: assets.length, assets },
      null,
      2,
    ) + '\n'
  );
}

// ── Checks ──────────────────────────────────────────────────────────────────

const luminance = (hex) => {
  const [r, g2, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g2) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const FORBIDDEN_IN_SVG = [
  [/<text[\s>]/, 'a <text> element: lettering must be outlined'],
  [/<image[\s>]/, 'an embedded raster'],
  [/<script[\s>]|<foreignObject|<iframe|<object|<embed/, 'an unsafe element'],
  [/(?:xlink:)?href=/, 'a reference'],
  [/data:/, 'a data URL'],
  [
    /<(?:linear|radial)Gradient|<filter|<mask|<clipPath/,
    'a gradient, filter, mask or clip: the system has none',
  ],
  [/sodipodi:|inkscape:/, 'editor metadata'],
];

function check() {
  const problems = [];
  const fail = (message) => problems.push(message);

  // 1. Generated text is exactly what the lock record produces.
  for (const file of svgPlan()) {
    if (!existsSync(abs(file.path))) fail(`${file.path} is missing`);
    else if (readFileSync(abs(file.path), 'utf8') !== file.content)
      fail(`${file.path} differs from what brand.json generates`);
  }
  const generatedText = [['favicon/site.webmanifest', webManifest()]];
  for (const [path, content] of generatedText) {
    if (!existsSync(abs(path))) fail(`${path} is missing`);
    else if (readFileSync(abs(path), 'utf8') !== content)
      fail(`${path} differs from what brand.json generates`);
  }

  // 2. SVG structure, and no colour outside the palette.
  const palette = new Set(Object.values(brand.colour).map((c) => c.value.toLowerCase()));
  for (const path of walk().filter((p) => p.endsWith('.svg') && !p.startsWith('explorations/'))) {
    const text = readFileSync(abs(path), 'utf8');
    if (!/viewBox="[\d.\s-]+"/.test(text)) fail(`${path} has no viewBox`);
    for (const [pattern, what] of FORBIDDEN_IN_SVG)
      if (pattern.test(text)) fail(`${path} contains ${what}`);
    for (const hex of text.match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
      if (!palette.has(hex.toLowerCase())) fail(`${path} uses ${hex}, which is not a brand colour`);
    }
  }

  // 3. The kit on disk is the kit in the manifest, and nothing is stray or missing.
  if (!existsSync(MANIFEST)) {
    fail('manifest.json is missing');
  } else {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const listed = new Map(manifest.assets.map((a) => [a.path, a]));
    for (const path of walk()) {
      const entry = listed.get(path);
      if (entry === undefined) fail(`${path} is not in manifest.json`);
      else if (sha256(readFileSync(abs(path))) !== entry.sha256)
        fail(`${path} has changed since manifest.json was written`);
    }
    for (const path of listed.keys())
      if (!existsSync(abs(path))) fail(`${path} is in manifest.json but missing`);
  }

  // 4. Every raster is the size and transparency the plan says it is.
  const jobs = rasterPlan();
  for (const job of jobs) {
    if (!existsSync(abs(job.path))) {
      fail(`${job.path} is missing`);
      continue;
    }
    const data = readFileSync(abs(job.path));
    const info = pngInfo(data);
    if (info === undefined) fail(`${job.path} is not a PNG`);
    else {
      if (info.width !== job.width || info.height !== job.height)
        fail(`${job.path} is ${info.width}x${info.height}, expected ${job.width}x${job.height}`);
      if (!job.transparent && info.hasAlpha)
        fail(`${job.path} has an alpha channel but is meant to be opaque`);
      if (job.transparent && !info.hasAlpha)
        fail(`${job.path} has no alpha channel but is meant to be transparent`);
    }
    if (data.length > job.budget)
      fail(`${job.path} is ${data.length} bytes, over its ${job.budget} byte budget`);
  }
  if (!existsSync(abs('favicon/favicon.ico'))) fail('favicon/favicon.ico is missing');
  else {
    const sizes = icoInfo(readFileSync(abs('favicon/favicon.ico')));
    if (sizes === undefined || sizes.join() !== ICO_SIZES.join())
      fail(
        `favicon.ico should hold ${ICO_SIZES.join(', ')}, holds ${sizes?.join(', ') ?? 'nothing readable'}`,
      );
  }

  // 5. The contrast the lock record promises is the contrast the colours deliver.
  for (const pair of brand.contrast) {
    const ratio = contrast(
      brand.colour[pair.foreground].value,
      brand.colour[pair.background].value,
    );
    if (ratio < pair.min)
      fail(
        `${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1, below the ${pair.min}:1 floor for ${pair.use}`,
      );
  }

  return problems;
}

// ── Main ────────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));

if (args.has('--check')) {
  const problems = check();
  if (problems.length > 0) {
    console.error(`brand kit has drifted (${problems.length}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const ratios = brand.contrast.map(
    (p) =>
      `${p.foreground}/${p.background} ${contrast(brand.colour[p.foreground].value, brand.colour[p.background].value).toFixed(1)}:1`,
  );
  console.log(
    `brand kit ok: ${walk().length} files, ${rasterPlan().length + 1} rasters, contrast ${ratios.join(', ')}`,
  );
} else {
  for (const file of svgPlan()) write(file.path, file.content);
  write('favicon/site.webmanifest', webManifest());
  if (!args.has('--manifest-only')) {
    console.log('rendering');
    await render(rasterPlan(), g.faviconTile());
  }
  writeFileSync(MANIFEST, buildManifest());
  console.log(`manifest: ${walk().length} files`);
}
