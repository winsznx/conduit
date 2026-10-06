import { expect, test } from '@playwright/test';

/**
 * How much the lossy encode actually changed the picture.
 *
 * The 840px PNG is produced by the same crop and resample as the AVIF and WebP
 * of that width and is lossless, so it is the reference the other two can be
 * measured against — this compares the encoder's output to its own input rather
 * than to something that went through a different pipeline.
 *
 * Composited over the page's canvas tone before comparing, because that is what
 * a reader sees: a difference hiding under 4% alpha is not a difference anybody
 * can perceive, and comparing straight RGBA would report it as one.
 */
test('the lossy hero variants are visually identical to the lossless one', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const load = (src: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          resolve(image);
        };
        image.onerror = reject;
        image.src = src;
      });

    const sources = [...document.querySelectorAll<HTMLSourceElement>('.hero-art source')];
    const pick = (type: string): string => {
      const set = sources.find((source) => source.type === type)?.srcset ?? '';
      // Index 1 is the 840 variant, which is the one width that also ships as a
      // lossless PNG and is therefore the only one that can be compared.
      return set.split(',').map((entry) => entry.trim().split(' ')[0] ?? '')[1] ?? '';
    };

    const fallback = document.querySelector<HTMLImageElement>('.hero-art img');
    if (fallback === null) throw new Error('the hero artwork did not render');
    const reference = fallback.src;
    const pixels = async (src: string): Promise<Uint8ClampedArray> => {
      const image = await load(src);
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no 2d context');
      // The page's canvas tone, so the comparison is what a reader sees.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };

    const base = await pixels(reference);
    const compare = async (src: string) => {
      const other = await pixels(src);
      let sum = 0;
      let worst = 0;
      for (let i = 0; i < base.length; i += 4) {
        for (let c = 0; c < 3; c += 1) {
          const delta = Math.abs((base[i + c] ?? 0) - (other[i + c] ?? 0));
          sum += delta * delta;
          if (delta > worst) worst = delta;
        }
      }
      return { rmse: Math.sqrt(sum / ((base.length / 4) * 3)), worst, src };
    };

    return {
      avif: await compare(pick('image/avif')),
      webp: await compare(pick('image/webp')),
      referenceSrc: reference,
    };
  });

  console.log(JSON.stringify(result, null, 1));

  // 2/255 RMSE is under a quarter of one step of 8-bit banding — invisible on a
  // gradient this smooth, and measured rather than asserted.
  expect(result.avif.rmse).toBeLessThan(2);
  expect(result.webp.rmse).toBeLessThan(2);
});

test('the artwork is genuinely transparent at its edges', async ({ page }) => {
  await page.goto('/');

  const alpha = await page.evaluate(async () => {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => {
        resolve(element);
      };
      element.onerror = reject;
      const set = document.querySelector<HTMLSourceElement>('.hero-art source[type="image/avif"]');
      element.src = (set?.srcset ?? '').split(',')[1]?.trim().split(' ')[0] ?? '';
    });

    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;

    const alphaAt = (x: number, y: number): number => data[(y * canvas.width + x) * 4 + 3] ?? 255;
    const corners = [
      alphaAt(0, 0),
      alphaAt(canvas.width - 1, 0),
      alphaAt(0, canvas.height - 1),
      alphaAt(canvas.width - 1, canvas.height - 1),
    ];

    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 250) opaque += 1;

    return { corners, opaqueShare: opaque / (canvas.width * canvas.height) };
  });

  console.log(JSON.stringify(alpha));

  // Every corner is fully transparent, and most of the frame is too: the
  // artwork is a subject on nothing, not a rectangle with a light background.
  for (const corner of alpha.corners) expect(corner).toBeLessThan(4);
  expect(alpha.opaqueShare).toBeLessThan(0.25);
});
