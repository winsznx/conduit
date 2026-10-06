import { describe, expect, it } from 'vitest';

import { hasWelcomeCookie, welcomeCookieDeclaration } from './welcome.js';

describe('reading the welcomed cookie from a Cookie header', () => {
  it.each([
    ['only the cookie', 'conduit-welcomed=1'],
    ['after another cookie', 'theme=dark; conduit-welcomed=1'],
    ['before another cookie', 'conduit-welcomed=1; theme=dark'],
    ['between others', 'a=b; conduit-welcomed=1; c=d'],
    ['with no space after the semicolon', 'a=b;conduit-welcomed=1;c=d'],
    ['with trailing whitespace', 'conduit-welcomed=1 '],
    ['among empty pairs and junk', ';;; =x; junk; =1;; conduit-welcomed=1;;'],
    ['twice with the same value', 'conduit-welcomed=1; conduit-welcomed=1'],
    ['before a later copy with another value', 'conduit-welcomed=1; conduit-welcomed=0'],
  ])('finds it %s', (_label, header) => {
    // #given a header carrying the cookie
    // #when it is read
    // #then the visitor counts as welcomed
    expect(hasWelcomeCookie(header)).toBe(true);
  });

  it.each([
    ['no header', null],
    ['an undefined header', undefined],
    ['an empty header', ''],
    ['a value of 0', 'conduit-welcomed=0'],
    ['an empty value', 'conduit-welcomed='],
    ['a value that only starts with 1', 'conduit-welcomed=11'],
    ['a quoted value', 'conduit-welcomed="1"'],
    ['a name with no value', 'conduit-welcomed'],
    ['another cookie name', 'theme=dark'],
    ['a longer name that contains ours', 'conduit-welcomed-v2=1'],
    ['a longer name that ends with ours', 'x-conduit-welcomed=1'],
    ['a different case', 'Conduit-Welcomed=1'],
    ['spaces around the equals sign', 'conduit-welcomed = 1'],
    ['our name inside another value', 'theme=conduit-welcomed=1'],
    ['a first copy with another value', 'conduit-welcomed=0; conduit-welcomed=1'],
  ])('does not find it with %s', (_label, header) => {
    // #given a header that does not carry the cookie as exactly 1
    // #when it is read
    // #then the visitor does not count as welcomed
    expect(hasWelcomeCookie(header)).toBe(false);
  });

  it('answers a megabyte of junk without backtracking', () => {
    // #given a header built to stall a pattern that retries
    const header = `${'a'.repeat(1_000_000)}=`;

    // #when it is read
    const started = performance.now();
    hasWelcomeCookie(header);

    // #then it finished in a fraction of a second
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('the cookie the browser sets', () => {
  it('is site-wide, lasts a year and carries SameSite=Lax', () => {
    // #given a page served over plain http
    // #when the declaration is built
    const declaration = welcomeCookieDeclaration(false);

    // #then it names the cookie, its scope, its lifetime and its same-site rule, and nothing else
    expect(declaration).toBe('conduit-welcomed=1; Path=/; Max-Age=31536000; SameSite=Lax');
  });

  it('adds Secure over https', () => {
    // #given a page served over https
    // #when the declaration is built
    const declaration = welcomeCookieDeclaration(true);

    // #then the cookie is marked Secure
    expect(declaration).toBe('conduit-welcomed=1; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
  });

  it('is never HttpOnly, because script sets it', () => {
    // #given the declaration over https
    // #then it does not claim an attribute a script-set cookie cannot have
    expect(welcomeCookieDeclaration(true)).not.toContain('HttpOnly');
  });

  it('reads back as welcomed through the same parser', () => {
    // #given the name and value of the declaration, as a browser echoes them in a Cookie header
    const echoed = welcomeCookieDeclaration(false).split(';')[0];

    // #then the server's parser accepts what the browser's setter wrote
    expect(hasWelcomeCookie(echoed)).toBe(true);
  });
});
