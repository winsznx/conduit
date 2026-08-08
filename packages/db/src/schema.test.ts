import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { backoffSeconds } from './outbox.js';
import { schema } from './schema.js';

/**
 * The SQL and the typed schema are two descriptions of one database.
 *
 * The SQL is what runs against Supabase. The Drizzle tables are what the API,
 * worker and indexer compile against. Two hand-written descriptions of one
 * thing drift, and the drift is invisible until a query returns `undefined` for
 * a column that was renamed in one of them — at runtime, in production, for one
 * endpoint.
 *
 * So the test parses the migration and compares. It is deliberately a string
 * comparison against the DDL rather than a round trip through a live database:
 * it has to run in CI with no Postgres, and what it is checking is that two
 * files agree, not that Postgres can parse one of them.
 */

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../migrations/0001_initial.sql', import.meta.url)),
  'utf8',
);

/** Every `CREATE TABLE x (...)` body, keyed by table name. */
function tablesInSql(sql: string): Map<string, string> {
  const tables = new Map<string, string>();
  const pattern = /CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    tables.set(match[1] as string, match[2] as string);
  }
  return tables;
}

/** Column names, ignoring constraints and comments. */
function columnsIn(body: string): Set<string> {
  const columns = new Set<string>();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('--')) continue;
    // `REFERENCES` is the continuation line of a multi-line FOREIGN KEY, and
    // reading it as a column name is how this parser first "found" a column
    // called REFERENCES.
    if (/^(PRIMARY KEY|CONSTRAINT|FOREIGN KEY|REFERENCES|UNIQUE|CHECK)\b/i.test(line)) continue;
    const name = /^(\w+)\s/.exec(line);
    if (name !== null) columns.add(name[1] as string);
  }
  return columns;
}

const sqlTables = tablesInSql(MIGRATION);

describe('the migration and the typed schema describe the same database', () => {
  it('parses every table out of the migration', () => {
    // A parser that silently matched nothing would make every test below vacuous.
    expect(sqlTables.size).toBeGreaterThanOrEqual(18);
  });

  for (const [key, table] of Object.entries(schema)) {
    const config = getTableConfig(table);

    it(`${config.name} exists in the migration`, () => {
      expect(sqlTables.has(config.name), `${key} → ${config.name}`).toBe(true);
    });

    it(`${config.name} has the same columns in both`, () => {
      const inSql = columnsIn(sqlTables.get(config.name) ?? '');
      const inDrizzle = new Set(config.columns.map((column) => column.name));
      expect([...inDrizzle].sort()).toEqual([...inSql].sort());
    });
  }
});

/**
 * ADR-0018, as a schema constraint.
 *
 * The deployed system has one address that is the SettlementCoordinator on
 * Monad Testnet and the RWACVASettlementAdapter on Base Sepolia — and
 * generation 3 produced the collision a second time, at a different address.
 * The deployer's nonce lines up across two chains and there is nothing unusual
 * about it happening.
 *
 * A unique key on a bare address would therefore be a live bug, not a
 * theoretical one. This test fails if one appears.
 */
describe('identity is a pair, in the schema itself', () => {
  it('has no unique constraint on a bare address column', () => {
    const offenders: string[] = [];
    for (const table of Object.values(schema)) {
      const config = getTableConfig(table);
      for (const constraint of config.uniqueConstraints) {
        const names = constraint.columns.map((column) => column.name);
        if (names.length === 1 && /address|emitter|^to$|^from$/.test(names[0] as string)) {
          offenders.push(`${config.name}.${String(names[0])}`);
        }
      }
      for (const column of config.columns) {
        if (column.isUnique && /address|emitter/.test(column.name)) {
          offenders.push(`${config.name}.${column.name}`);
        }
      }
      const primary = config.primaryKeys.flatMap((key) => key.columns.map((c) => c.name));
      if (primary.length === 1 && /address|emitter/.test(primary[0] as string)) {
        offenders.push(`${config.name}.${String(primary[0])} (primary key)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keys a contract by chain and address together', () => {
    const config = getTableConfig(schema.deploymentContracts);
    const composite = config.uniqueConstraints.find(
      (constraint) => constraint.name === 'deployment_contracts_identity_unique',
    );
    expect(composite?.columns.map((column) => column.name)).toEqual([
      'deployment_id',
      'chain_id',
      'address',
      'role',
    ]);
  });

  it('keys an indexed event by chain, transaction and log index', () => {
    // `txHash` alone is not an identity across two chains, and this deployment
    // reads logs from two.
    const config = getTableConfig(schema.indexedEvents);
    const primary = config.primaryKeys[0]?.columns.map((column) => column.name);
    expect(primary).toEqual(['chain_id', 'tx_hash', 'log_index']);
  });

  it('keys a Wormhole message by its own namespace, not by an EVM chain id', () => {
    const config = getTableConfig(schema.messages);
    const primary = config.primaryKeys[0]?.columns.map((column) => column.name);
    expect(primary).toEqual(['wormhole_chain_id', 'emitter', 'sequence']);

    // A Wormhole chain ID and an EVM chain ID are both small integers and mean
    // different things. Keeping the source chain as a separate column is what
    // stops one being read as the other.
    expect(config.columns.map((column) => column.name)).toContain('source_chain_id');
  });
});

describe('the projection cannot be mistaken for authority', () => {
  it('stores the canonical state and the verifier classification in separate columns', () => {
    const names = getTableConfig(schema.settlements).columns.map((column) => column.name);
    expect(names).toContain('canonical_state');
    expect(names).toContain('verifier_class');
  });

  it('never stores a private key', () => {
    for (const table of Object.values(schema)) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        expect(/private_key|secret|seed_phrase|mnemonic/.test(column.name)).toBe(false);
      }
    }
  });

  /**
   * A stored compliance decision that lacked its signature would be an opinion
   * the application could be tempted to act on. With both, the row is evidence
   * of something a contract would independently accept, and the contract is
   * still the one that decides.
   */
  it('stores every compliance decision with the signature and domain it must satisfy', () => {
    const names = getTableConfig(schema.complianceAttestations).columns.map((c) => c.name);
    for (const required of [
      'eligible',
      'signature',
      'signer',
      'verifying_chain_id',
      'verifying_contract',
    ]) {
      expect(names).toContain(required);
    }
  });
});

describe('retry backoff', () => {
  it('grows and then caps', () => {
    const early = backoffSeconds(1);
    const late = backoffSeconds(9);
    const capped = backoffSeconds(20);
    expect(late).toBeGreaterThan(early);
    // 2**20 would be twelve days. The cap is what keeps a dead queue readable.
    expect(capped).toBeLessThanOrEqual(768);
  });

  it('is deterministic, so a test can predict a delay', () => {
    expect(backoffSeconds(5)).toBe(backoffSeconds(5));
  });

  it('spreads simultaneous failures rather than retrying them in lockstep', () => {
    const delays = new Set([3, 4, 5, 6].map((attempt) => backoffSeconds(attempt)));
    expect(delays.size).toBeGreaterThan(1);
  });
});
