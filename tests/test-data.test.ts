import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const keyIn = (path: string): string | undefined =>
  /const KEY = '(0x[0-9a-fA-F]{64})'/.exec(read(path))?.[1];

describe('the throwaway wallet the browser specs sign with', () => {
  it('is the same key in the signing spec and the settlement spec', () => {
    // #given the two specs that sign an intent
    // #when their keys are read
    const keys = [keyIn('apps/web/qa/signing.spec.ts'), keyIn('apps/web/qa/settlement.spec.ts')];

    // #then they agree, and both are present
    expect(keys[0] !== undefined && keys[0] === keys[1]).toBe(true);
  });

  it('is the address the purge script treats as test data', () => {
    // #given the key the specs sign with
    const key = keyIn('apps/web/qa/signing.spec.ts') ?? '';
    const address = privateKeyToAccount(key as `0x${string}`).address.toLowerCase();

    // #when the script's constant is read
    const declared = /const SPEC_WALLET = '(0x[0-9a-f]{40})'/.exec(
      read('scripts/purge-test-intents.mjs'),
    )?.[1];

    // #then the script removes rows of exactly that wallet
    expect(declared).toBe(address);
  });
});

/**
 * live.spec.ts also signs, and it has its own opt-in: CONDUIT_LIVE=1 and a private key, because it
 * settles for real on two testnets. It is the one spec that does not use the database-writes guard.
 */
const HAS_ITS_OWN_OPT_IN = 'live.spec.ts';

describe('the specs that store an intent', () => {
  const specs = readdirSync(join(ROOT, 'apps/web/qa'))
    .filter((name) => name.endsWith('.spec.ts') && name !== HAS_ITS_OWN_OPT_IN)
    .filter((name) => read(`apps/web/qa/${name}`).includes("name: 'Sign with my wallet'"));

  it('are found by what they do, so a new one is covered without being listed', () => {
    // #given every spec in the browser suite
    // #when those that click "Sign with my wallet" are collected
    // #then the two known ones are there
    expect(specs.sort()).toEqual(['settlement.spec.ts', 'signing.spec.ts']);
  });

  it.each(['signing.spec.ts', 'settlement.spec.ts'])(
    'a spec that signs also contains the database-writes guard: %s',
    (name) => {
      // #given a spec that clicks "Sign with my wallet"
      const spec = read(`apps/web/qa/${name}`);

      // #when it is searched for the guard call
      const guarded = spec.includes('skipUnlessDatabaseWritesAllowed();');

      // #then the guard is there
      expect(guarded).toBe(true);
    },
  );

  it('keeps live.spec.ts behind its own opt-in', () => {
    // #given the live spec
    const spec = read(`apps/web/qa/${HAS_ITS_OWN_OPT_IN}`);

    // #when it is searched for its opt-in
    const gated = spec.includes("process.env['CONDUIT_LIVE'] === '1'");

    // #then it does not run by accident
    expect(gated).toBe(true);
  });
});
