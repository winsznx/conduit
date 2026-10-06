import { describe, expect, it } from 'vitest';

import { withoutTrailingSlashes } from './request-path.js';

describe('withoutTrailingSlashes', () => {
  it.each([
    ['/app/', '/app'],
    ['/app////', '/app'],
    ['/app', '/app'],
    ['/a//b/', '/a//b'],
    ['/', '/'],
    ['/////', '/'],
  ])('turns %s into %s', (pathname, expected) => {
    // #given a request path
    // #when its trailing slashes are removed
    const result = withoutTrailingSlashes(pathname);

    // #then interior slashes stay, and a path of only slashes is the root
    expect(result).toBe(expected);
  });

  it('returns a long run of slashes that ends in another character unchanged', () => {
    // #given a path with nothing to trim
    const pathname = `${'/'.repeat(30_000)}x`;

    // #when it is normalised
    const result = withoutTrailingSlashes(pathname);

    // #then it comes back as it went in
    expect(result).toBe(pathname);
  });

  it('scans that same path in linear time', () => {
    // #given the shape an end-anchored `/\/+$/` took about two seconds over
    const pathname = `${'/'.repeat(30_000)}x`;

    // #when it is normalised
    const started = performance.now();
    withoutTrailingSlashes(pathname);
    const elapsed = performance.now() - started;

    // #then it finishes far inside what a quadratic scan needs, with room for a loaded runner
    expect(elapsed).toBeLessThan(250);
  });
});
