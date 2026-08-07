import { describe, expect, it } from 'vitest';

import {
  overrideAcceptanceAdditions,
  overrideAssetLegStates,
  prdInvariantIds,
  prdOpenQuestions,
  prdPhases,
  prdThreats,
} from './helpers/prd.js';
import { exists, listFiles, readText } from './helpers/repo.js';

/**
 * CLAUDE.md requires docs/implementation-status.md, docs/assumptions.md,
 * docs/adr/, docs/threat-model/, docs/runbooks/, and contracts/deployments/ to
 * be maintained, and states that "an unresolved assumption must remain visibly
 * unresolved."
 *
 * Coverage is measured against the PRD text itself, so a requirement added
 * upstream fails this gate until the documentation catches up.
 */
describe('implementation status (CLAUDE.md documentation rules)', () => {
  const status = readText('docs/implementation-status.md');

  it.each(prdPhases())('records phase $id — $title', ({ id, title }) => {
    expect(status).toContain(`Phase ${id}`);
    expect(status.toLowerCase()).toContain(title.toLowerCase());
  });

  it('gives every phase an explicit state', () => {
    const states = [...status.matchAll(/^\|\s*Phase (\d{2})\s*\|[^|]*\|\s*([A-Z ]+?)\s*\|/gm)];
    expect(states.length).toBe(prdPhases().length);

    const allowed = ['PASS', 'FAIL', 'BLOCKED', 'IN PROGRESS', 'NOT STARTED'];
    for (const [, id, state] of states) {
      expect(allowed, `phase ${id ?? '?'} has state "${state ?? ''}"`).toContain(state);
    }
  });
});

describe('assumptions register (CLAUDE.md documentation rules)', () => {
  const assumptions = readText('docs/assumptions.md');

  it.each(prdOpenQuestions())('carries PRD 23 question: %s', (question) => {
    expect(assumptions).toContain(question);
  });

  it('marks every entry with a resolution state and never silently confirms one', () => {
    const entries = [...assumptions.matchAll(/^\|\s*(ASM-\d{3})\s*\|/gm)].map((m) => m[1] ?? '');
    expect(entries.length).toBeGreaterThanOrEqual(prdOpenQuestions().length);

    const states = [...assumptions.matchAll(/^\|\s*ASM-\d{3}\s*\|[^|]*\|\s*([A-Z]+)\s*\|/gm)].map(
      (m) => m[1] ?? '',
    );
    expect(states.length).toBe(entries.length);
    for (const state of states) {
      expect(['OPEN', 'RESOLVED', 'REJECTED']).toContain(state);
    }
  });

  it('resolves nothing before the phase that can produce live evidence', () => {
    const resolved = [...assumptions.matchAll(/^\|\s*(ASM-\d{3})\s*\|[^|]*\|\s*RESOLVED\s*\|/gm)];
    for (const [, id] of resolved) {
      expect(
        assumptions,
        `${id ?? ''} is RESOLVED and must cite the evidence that resolved it`,
      ).toMatch(new RegExp(`${id ?? ''}[\\s\\S]{0,400}?(ADR-|0x[0-9a-f]{8}|tx )`));
    }
  });
});

describe('architecture decision records', () => {
  it('publishes the process and a template', () => {
    expect(exists('docs/adr/README.md')).toBe(true);
    expect(exists('docs/adr/0000-template.md')).toBe(true);
  });

  it('reserves ADR-0001 for the cash custody result named by PRD 2.5', () => {
    const adr = listFiles('docs/adr', '.md').find((file) => file.includes('/0001-'));
    expect(adr, 'PRD 2.5 records the custody seam result in ADR-001').toBeDefined();
    expect(readText(adr ?? '')).toContain('Status');
  });

  it('gives every ADR an explicit status', () => {
    const adrs = listFiles('docs/adr', '.md').filter((file) => /\/\d{4}-/.test(file));
    expect(adrs.length).toBeGreaterThan(1);

    for (const adr of adrs) {
      const status = /^\*\*Status:\*\*\s*(\S+)/m.exec(readText(adr))?.[1];
      expect(status, `${adr} has no status`).toBeDefined();
      expect(['Proposed', 'Accepted', 'Open', 'Superseded', 'Rejected', 'Template']).toContain(
        status,
      );
    }
  });
});

describe('threat model skeleton (PRD 14)', () => {
  const register = readText('docs/threat-model/threat-register.md');

  it.each(prdThreats())('tracks PRD 14.3 threat: %s', (threat) => {
    expect(register.toLowerCase()).toContain(threat.toLowerCase());
  });

  it.each(prdInvariantIds())('binds fundamental invariant %s to at least one threat', (id) => {
    expect(register).toMatch(new RegExp(`\\b${id}\\b`));
  });

  it('documents the trust boundaries the invariants depend on', () => {
    const boundaries = readText('docs/threat-model/trust-boundaries.md');
    for (const party of ['Cleanverse', 'Wormhole', 'relayer', 'compliance signer', 'RPC']) {
      expect(boundaries.toLowerCase()).toContain(party.toLowerCase());
    }
  });
});

describe('PRD v1.1 override (ADR-0004)', () => {
  const status = readText('docs/implementation-status.md');
  const register = readText('docs/threat-model/threat-register.md');

  it.each(overrideAcceptanceAdditions())('tracks acceptance addition: %s', (item) => {
    expect(status).toContain(item);
  });

  it.each(overrideAssetLegStates())('documents asset-leg state %s', (state) => {
    expect(register).toContain(state);
  });

  it('binds every reservation invariant to at least one override threat', () => {
    for (const id of ['R1', 'R2', 'R3', 'R4', 'R5']) {
      const bindings = [...register.matchAll(/^\| V-\d{2} \|[^|]*\|[^|]*\|([^|]*)\|/gm)].filter(
        (row) => new RegExp(`\\b${id}\\b`).test(row[1] ?? ''),
      );
      expect(bindings.length, `${id} has no override threat bound to it`).toBeGreaterThan(0);
    }
  });

  it('records the adoption decision as an accepted ADR', () => {
    const adr = readText('docs/adr/0004-prd-v1-1-override-adoption.md');
    expect(adr).toContain('**Status:** Accepted');
    expect(readText('docs/adr/README.md')).toContain('0004-prd-v1-1-override-adoption.md');
  });

  it('stops describing the Arbitrum leg as an ERC-3643 token (override section 18)', () => {
    for (const doc of ['README.md', 'docs/implementation-status.md']) {
      expect(readText(doc)).not.toMatch(/\bERC-3643-style (restricted )?(security )?token\b/);
    }
  });
});

describe('runbooks (PRD 17.4)', () => {
  it.each(['key-rotation', 'emergency-revocation', 'incident-response'])(
    'ships a %s runbook',
    (name) => {
      expect(exists(`docs/runbooks/${name}.md`)).toBe(true);
    },
  );
});

describe('security waivers (PRD 15.5)', () => {
  it('documents the waiver process', () => {
    expect(exists('docs/security-waivers/README.md')).toBe(true);
  });

  it('gives every waiver a status, a scope, and an expiry that has not passed', () => {
    // Asserting zero waivers only held while there were none. What matters is
    // that each one is bounded: PRD 15.5 permits a documented waiver, and an
    // undated one is a permanent suppression wearing a document.
    const waivers = listFiles('docs/security-waivers', '.md').filter(
      (file) => !file.endsWith('README.md'),
    );

    for (const waiver of waivers) {
      const body = readText(waiver);
      expect(body, `${waiver} has no status`).toMatch(/^\*\*Status:\*\* (Active|Expired)$/m);
      expect(body, `${waiver} has no scope`).toMatch(/^\*\*Scope:\*\*/m);

      const expiry = /^\*\*Expires:\*\* (\d{4}-\d{2}-\d{2})$/m.exec(body)?.[1];
      expect(expiry, `${waiver} has no expiry date`).toBeDefined();
      expect(
        new Date(`${expiry ?? ''}T00:00:00Z`).getTime(),
        `${waiver} expired on ${expiry ?? ''}`,
      ).toBeGreaterThan(Date.parse('2026-08-07T00:00:00Z'));

      expect(readText('docs/security-waivers/README.md')).toContain(waiver.split('/').pop() ?? '');
    }
  });
});
