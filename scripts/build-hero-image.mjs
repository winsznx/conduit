#!/usr/bin/env node
/**
 * Turns the hero artwork into the sizes and formats the landing page ships.
 *
 *   node scripts/build-hero-image.mjs           # regenerate the variants
 *   node scripts/build-hero-image.mjs --check   # fail if they have drifted
 *
 * ## Why the variants are generated here and committed, not built on demand
 *
 * `apps/web/build.mjs` runs on every gate and on every deploy, and it must work
 * on a machine that has Node and nothing else. Encoding AVIF and WebP needs
 * `avifenc` and `cwebp`, which are not dependencies of this repository and are
 * not going to become them for one picture. So the encoding happens here, by
 * hand, when the artwork changes; the results are committed; and the build only
 * hashes and embeds bytes that already exist.
 *
 * `--check` re-runs the deterministic half — decode, crop, resize, re-encode the
 * PNGs — and compares. It cannot re-check the AVIF and WebP without the
 * encoders, so it verifies those are present and non-empty rather than claiming
 * to have verified their contents.
 *
 * ## The crop
 *
 * The source is 1536×1024 and the artwork inside it is a wide, short band:
 * nothing above alpha 5/255 exists outside x 118–1428, y 370–668. Shipping the
 * full canvas would reserve an aspect ratio of 1.5 for a subject that fills 29%
 * of it vertically, which is both a large hole in the layout and bytes nobody
 * needs. The crop below keeps every pixel above 1.6% opacity, with roughly 70px
 * of margin on each side so the soft alpha falloff is never cut.
 *
 * ## Resampling
 *
 * Downscaling happens in premultiplied alpha. Averaging straight RGBA across a
 * soft edge pulls the colour of fully transparent pixels into the visible ones,
 * which is where dark halos around transparent artwork come from. Premultiply,
 * average, un-premultiply.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

import { ROOT } from './lib/run.mjs';

const ASSETS = join(ROOT, 'apps', 'web', 'assets');
const SOURCE = join(ASSETS, 'hero-source.png');

/** Kept every pixel above 1.6% opacity. See the note above. */
const CROP = { x: 48, y: 296, width: 1440, height: 448 };

/**
 * The widths the page can ask for.
 *
 * The hero's right column is at most 48% of a 1232px content area, so 560 CSS
 * pixels is the widest it renders on a 1280px canvas — 1120 covers that at 2x.
 * 1440 is there for a wide high-DPI desktop, and 1026 is what a 390px phone
 * needs at 3x, which 1120 also covers. 560 is the mobile 1x and tablet case.
 */
const WIDTHS = [560, 840, 1120, 1440];

/** The one format every browser can read. Only one size: nothing modern needs it. */
const PNG_FALLBACK_WIDTH = 840;

// ── PNG ─────────────────────────────────────────────────────────────────────

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`expected 8-bit RGBA, got depth ${bitDepth} type ${colorType}`);
  }

  const parts = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') parts.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read];
    read += 1;
    const line = raw.subarray(read, read + stride);
    read += stride;
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = above[x];
      const c = x >= bpp ? above[x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = value & 255;
    }
  }
  return { width, height, pixels };
}

/**
 * Encodes RGBA back to PNG.
 *
 * Filter 1 (Sub) on every row rather than an adaptive search: the encoder only
 * has to be deterministic and reasonable, because `cwebp` and `avifenc` produce
 * what the page actually serves and this PNG is the last-resort fallback.
 */
function encodePng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const target = y * (stride + 1);
    raw[target] = 1;
    for (let x = 0; x < stride; x += 1) {
      const here = pixels[y * stride + x];
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      raw[target + 1 + x] = (here - left) & 255;
    }
  }

  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// ── Geometry ────────────────────────────────────────────────────────────────

function crop(image, box) {
  const pixels = Buffer.alloc(box.width * box.height * 4);
  for (let y = 0; y < box.height; y += 1) {
    const from = ((box.y + y) * image.width + box.x) * 4;
    image.pixels.copy(pixels, y * box.width * 4, from, from + box.width * 4);
  }
  return { width: box.width, height: box.height, pixels };
}

/** Area-average downscale, in premultiplied alpha so soft edges keep their colour. */
function resize(image, width) {
  const height = Math.round((image.height * width) / image.width);
  if (width === image.width && height === image.height) return image;

  const pixels = Buffer.alloc(width * height * 4);
  const scaleX = image.width / width;
  const scaleY = image.height / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * image.width + sx) * 4;
          const alpha = image.pixels[i + 3];
          r += image.pixels[i] * alpha;
          g += image.pixels[i + 1] * alpha;
          b += image.pixels[i + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }

      const target = (y * width + x) * 4;
      const meanAlpha = a / n;
      if (a === 0) {
        pixels[target] = 0;
        pixels[target + 1] = 0;
        pixels[target + 2] = 0;
        pixels[target + 3] = 0;
        continue;
      }
      pixels[target] = Math.round(r / a);
      pixels[target + 1] = Math.round(g / a);
      pixels[target + 2] = Math.round(b / a);
      pixels[target + 3] = Math.round(meanAlpha);
    }
  }
  return { width, height, pixels };
}

// ── Run ─────────────────────────────────────────────────────────────────────

const digest = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 16);

function main() {
  const check = process.argv.includes('--check');
  mkdirSync(ASSETS, { recursive: true });

  const source = decodePng(readFileSync(SOURCE));
  if (
    CROP.x + CROP.width > source.width ||
    CROP.y + CROP.height > source.height ||
    source.width !== 1536 ||
    source.height !== 1024
  ) {
    throw new Error(`the crop does not fit a ${source.width}×${source.height} source`);
  }

  const cropped = crop(source, CROP);
  const failures = [];
  const produced = [];

  for (const width of WIDTHS) {
    const scaled = resize(cropped, width);
    const png = encodePng(scaled);
    const pngPath = join(ASSETS, `hero-${width}.png`);

    // Only the fallback width is committed, so it is the only one `--check` can
    // byte-compare. The others exist to feed the encoders and are removed after.
    if (check) {
      if (width === PNG_FALLBACK_WIDTH) {
        if (!existsSync(pngPath)) failures.push(`missing ${pngPath}`);
        else if (!readFileSync(pngPath).equals(png)) {
          failures.push(`hero-${width}.png differs from what the source and crop produce`);
        }
      }
    } else if (width === PNG_FALLBACK_WIDTH) {
      writeFileSync(pngPath, png);
    } else {
      // The intermediate PNGs are only inputs to the two encoders below, so they
      // are written, consumed and left out of the repository.
      writeFileSync(join(ASSETS, `.hero-${width}.tmp.png`), png);
    }

    const input = width === PNG_FALLBACK_WIDTH ? pngPath : join(ASSETS, `.hero-${width}.tmp.png`);
    const webp = join(ASSETS, `hero-${width}.webp`);
    const avif = join(ASSETS, `hero-${width}.avif`);

    if (!check) {
      execFileSync('cwebp', [
        '-quiet',
        '-q',
        '86',
        '-alpha_q',
        '100',
        '-m',
        '6',
        input,
        '-o',
        webp,
      ]);
      // q 72 rather than the default: the artwork is a smooth gradient against
      // transparency, which is exactly where AVIF's chroma handling shows banding
      // if it is pushed. Checked at 2x on a 1440 desktop, not assumed.
      execFileSync('avifenc', ['-q', '72', '--speed', '2', '--jobs', 'all', input, avif]);
    }

    for (const path of [webp, avif]) {
      if (!existsSync(path) || statSync(path).size === 0) failures.push(`missing or empty ${path}`);
    }

    if (!check && width !== PNG_FALLBACK_WIDTH) rmSync(input, { force: true });

    produced.push({
      width,
      height: scaled.height,
      png: existsSync(pngPath) ? statSync(pngPath).size : 0,
      webp: existsSync(webp) ? statSync(webp).size : 0,
      avif: existsSync(avif) ? statSync(avif).size : 0,
    });
  }

  const manifest = {
    source: 'apps/web/assets/hero-source.png',
    sourceSha256: digest(readFileSync(SOURCE)),
    sourceSize: [source.width, source.height],
    crop: CROP,
    intrinsic: [CROP.width, CROP.height],
    pngFallbackWidth: PNG_FALLBACK_WIDTH,
    variants: produced,
  };

  if (check) {
    if (failures.length > 0) {
      console.error('hero image check FAILED');
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.log(`hero image OK — ${produced.length} widths, crop ${CROP.width}×${CROP.height}`);
    return;
  }

  writeFileSync(join(ASSETS, 'hero.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const variant of produced) {
    console.log(
      `hero-${variant.width}  ${variant.width}×${variant.height}  ` +
        `avif ${(variant.avif / 1024).toFixed(1)}kb  webp ${(variant.webp / 1024).toFixed(1)}kb` +
        (variant.png > 0 ? `  png ${(variant.png / 1024).toFixed(1)}kb` : ''),
    );
  }
}

main();
