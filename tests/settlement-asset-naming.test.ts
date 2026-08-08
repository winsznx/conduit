import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROOT } from './helpers/repo.js';

/**
 * The Monad leg settles in a CVA this project issued and registered. It is not
 * aUSDC.
 *
 * `generate_apass` is 403 for this credential, the sandbox faucet's own
 * reservoir is empty, and a deposit executes and is refunded by policy about
 * forty blocks later (ASM-035). There is no route to real aUSDC, so the cash
 * leg settles in `ConduitSandboxSettlementCVA`, symbol `cSETTLE` — a real
 * Cleanverse CVA, registered, enforcing the same live CCP policy, and not
 * fiat-backed by anyone.
 *
 * The architecture targets aUSDC. The evidence does not get to borrow that.
 * Describing the demo's cash leg as USDC would be the single most misleading
 * thing this repository could say, so the forbidden phrasings are a test rather
 * than a convention: prose drifts, and a reviewer reading a settlement report
 * has no way to tell an aspiration from a measurement.
 *
 * Historical measurements against the real aUSDC contract are legitimate and
 * are exempted by path. They describe probes that genuinely used it, and
 * ADR-0001 says in terms that the settled leg does not.
 */

const FORBIDDEN = [
  /\baUSDC settlement\b/i,
  /\bUSDC cash leg\b/i,
  /\bcash leg (?:is|settles) (?:in )?(?:real )?a?USDC\b/i,
  /\bfiat[- ]backed\b/i,
  /\bsettles? in a?USDC\b/i,
  /\bUSDC[- ]denominated\b/i,
];

/**
 * Files whose subject genuinely is the real aUSDC contract.
 *
 * ADR-0001's custody probe ran against aUSDC on Monad before we knew there was
 * no route to it, and ASM-027 and ASM-035 exist to record that absence. Erasing
 * the word from those would rewrite what was measured.
 */
const HISTORICAL = new Set([
  'docs/adr/0001-cash-custody-mode.md',
  'docs/assumptions.md',
  'docs/implementation-status.md',
  'tests/settlement-asset-naming.test.ts',
]);

function publicProse(): string[] {
  const root = ROOT;
  const files: string[] = ['README.md'];

  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative))) {
      const path = `${relative}/${entry}`;
      if (statSync(join(root, path)).isDirectory()) {
        if (entry === 'artifacts') continue;
        walk(path);
        continue;
      }
      if (entry.endsWith('.md') || entry.endsWith('.json')) files.push(path);
    }
  };
  walk('docs');

  return files.filter((path) => !HISTORICAL.has(path));
}

describe('the Monad settlement asset is named for what it is', () => {
  it.each(publicProse())('%s does not describe the cash leg as USDC', (path) => {
    // #given a file that a reader could take as a description of the demo
    const contents = readFileSync(join(ROOT, path), 'utf8');

    // #when the forbidden phrasings are searched for
    const found = FORBIDDEN.filter((pattern) => pattern.test(contents)).map(String);

    // #then none of them appear
    expect(found, `${path} claims a USDC cash leg`).toEqual([]);
  });

  it('the phase 06 evidence names the asset it actually settled', () => {
    const evidence = JSON.parse(
      readFileSync(join(ROOT, 'docs/evidence/phase-06-dvp-attempt-4.json'), 'utf8'),
    ) as { amounts: { cash: string }; deployment: { monadTestnet: Record<string, string> } };

    expect(evidence.amounts.cash).toContain('cSETTLE');
    expect(Object.keys(evidence.deployment.monadTestnet)).toContain('ConduitSandboxSettlementCVA');
  });

  it('the forbidden patterns would actually catch the claim', () => {
    // A guard that matches nothing is a guard that passes forever.
    expect(FORBIDDEN.some((pattern) => pattern.test('the USDC cash leg settled'))).toBe(true);
    expect(FORBIDDEN.some((pattern) => pattern.test('a fiat-backed settlement asset'))).toBe(true);
    expect(FORBIDDEN.some((pattern) => pattern.test('the cash leg settles in aUSDC'))).toBe(true);
    expect(
      FORBIDDEN.some((pattern) =>
        pattern.test('Cleanverse-native sandbox settlement CVA on Monad'),
      ),
    ).toBe(false);
  });
});
