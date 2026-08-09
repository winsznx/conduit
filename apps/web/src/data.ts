/**
 * The read layer. Every row on every page comes from here.
 *
 * ## Why raw SQL and not the drizzle schema
 *
 * `packages/db/src/schema.ts` declares its tables unqualified — `pgTable(
 * 'settlements', …)` — which resolves to `public.settlements`. Migration 0002
 * moved every table into the `conduit` schema, so that model now points at
 * tables which do not exist, and it also predates `intents.terms_source`. Using
 * it here would put a stale mapping on the path of every page. These queries
 * name `conduit.*` explicitly and are parameterised throughout.
 *
 * ## Where the terms come from
 *
 * `settlement_legs` is written by the bootstrap loader with placeholder amounts
 * and empty addresses, because a verification artifact proves outcomes and
 * carries no terms. The real amounts live in `conduit.intents`, recovered from
 * the run artifact that produced each settlement and marked `terms_source =
 * 'artifact'`. A settlement whose terms were never recovered is marked
 * `'unknown'`, and `termsKnown` carries that to the page so a placeholder zero
 * is never rendered as if it were a trade.
 */

import postgres from 'postgres';

import type {
  DeploymentView,
  DispositionView,
  LegView,
  MessageView,
  SettlementView,
} from './domain.js';

export interface Env {
  readonly DATABASE_URL: string;
  readonly MONAD_RPC_URL: string;
  readonly BASE_RPC_URL: string;
  readonly DEPLOYMENT_ID: string;
  readonly COMMIT_SHA: string;
}

type Sql = ReturnType<typeof postgres>;

/**
 * One connection per request.
 *
 * A Worker isolate may be evicted between requests, so a module-level pool
 * would hold sockets that outlive their usefulness. `max: 1` with
 * `prepare: false` is what the Supabase pooler accepts.
 */
function connect(env: Env): Sql {
  return postgres(env.DATABASE_URL, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
    connection: { application_name: 'conduit-web' },
  });
}

/** Runs a read and always closes the socket, including on failure. */
export async function withDb<T>(env: Env, read: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = connect(env);
  try {
    return await read(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * A JSON column, whichever way it arrives.
 *
 * Malformed JSON returns the fallback rather than throwing: a page that cannot
 * parse one column should still render the rest of what it knows.
 */
function jsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Column coercions.
 *
 * The driver hands back `unknown` per column, and `String(unknown)` will
 * happily stringify an object as `[object Object]` — which is how a page ends
 * up rendering that instead of a value. These narrow first and return empty
 * rather than a lie.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return '';
}

/** Empty and absent are the same thing to a page: there is nothing to show. */
function optionalText(value: unknown): string | undefined {
  const resolved = text(value);
  return resolved === '' ? undefined : resolved;
}

function num(value: unknown): number {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

const ASSET_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  '0xfefd2ea28db25c720ec5298964f8d2f34e3f1f16': 'cSETTLE',
  '0xddb1ae5685f4033ed10b3dfce5e9dc13d3e4989b': 'cBOND',
});

function symbolFor(assetAddress: string): string {
  return ASSET_SYMBOLS[assetAddress.toLowerCase()] ?? 'unit';
}

/**
 * Amounts are stored as base units. Both assets in this deployment carry six
 * decimals, which is read from the intent rather than assumed per-symbol.
 */
function formatAmount(base: string, decimals = 6): string {
  const negative = base.startsWith('-');
  const digits = (negative ? base.slice(1) : base).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction === '' ? '' : `.${fraction}`}`;
}

interface SettlementRow {
  readonly settlement_id: string;
  readonly deployment_id: string;
  readonly intent_hash: string;
  readonly canonical_state: string;
  readonly decision: string;
  readonly verifier_class: string | null;
  readonly generation: number;
}

/** Newest first. `created_at` is when the projection saw it, not chain order. */
export async function recentSettlements(env: Env, limit = 50): Promise<readonly SettlementView[]> {
  return withDb(env, async (sql) => {
    const rows = (await sql`
      SELECT s.settlement_id, s.deployment_id, s.intent_hash, s.canonical_state,
             s.decision, s.verifier_class, d.generation
        FROM conduit.settlements s
        JOIN conduit.deployments d USING (deployment_id)
       ORDER BY s.created_at DESC
       LIMIT ${limit}
    `) as unknown as readonly SettlementRow[];

    return rows.map((row) => shallowView(row));
  });
}

/** The list view needs state and generation, not terms — so it does not load them. */
function shallowView(row: SettlementRow): SettlementView {
  const empty: LegView = {
    chain: '',
    chainId: 0,
    asset: '',
    assetSymbol: '',
    amount: '',
    outcome: '',
    counterparty: '',
  };
  return {
    settlementId: row.settlement_id,
    deploymentId: row.deployment_id,
    generation: row.generation,
    canonicalState: row.canonical_state,
    decision: row.decision,
    verifierClass: row.verifier_class ?? undefined,
    cash: empty,
    asset: empty,
    messages: [],
    compliance: [],
    disposition: undefined,
    conservation: [],
    termsKnown: false,
  };
}

export async function settlementView(
  env: Env,
  settlementId: string,
): Promise<SettlementView | undefined> {
  return withDb(env, async (sql) => {
    const [head] = (await sql`
      SELECT s.settlement_id, s.deployment_id, s.intent_hash, s.canonical_state,
             s.decision, s.verifier_class, d.generation
        FROM conduit.settlements s
        JOIN conduit.deployments d USING (deployment_id)
       WHERE s.settlement_id = ${settlementId}
    `) as unknown as readonly SettlementRow[];
    if (head === undefined) return undefined;

    const [terms] = (await sql`
      SELECT cash_chain_id, cash_asset, cash_amount, cash_payer, cash_receiver,
             asset_chain_id, asset_token, asset_amount, asset_seller, asset_receiver,
             terms_source
        FROM conduit.intents WHERE intent_hash = ${head.intent_hash}
    `) as unknown as readonly Record<string, unknown>[];

    const legs = (await sql`
      SELECT leg, chain_id, outcome FROM conduit.settlement_legs
       WHERE settlement_id = ${settlementId}
    `) as unknown as readonly { leg: string; chain_id: number; outcome: string }[];

    const messageRows = (await sql`
      SELECT message_type, sequence, finality, emitter, wormhole_chain_id, destination_chain_id
        FROM conduit.messages WHERE settlement_id = ${settlementId}
       ORDER BY wormhole_chain_id, sequence
    `) as unknown as readonly Record<string, unknown>[];

    const termsKnown = terms !== undefined && terms['terms_source'] !== 'unknown';
    const outcomeOf = (leg: string): string =>
      legs.find((row) => row.leg === leg)?.outcome ?? 'UNKNOWN';

    const leg = (side: 'cash' | 'asset'): LegView => {
      const chainId = num(terms?.[`${side}_chain_id`]) || (side === 'cash' ? 10143 : 84532);
      const asset = text(terms?.[side === 'cash' ? 'cash_asset' : 'asset_token']);
      const amount = text(terms?.[`${side}_amount`]) || '0';
      const counterparty = text(terms?.[side === 'cash' ? 'cash_payer' : 'asset_receiver']);
      return {
        chain: '',
        chainId,
        asset,
        assetSymbol: asset === '' ? '—' : symbolFor(asset),
        amount: termsKnown ? formatAmount(amount) : 'not recovered',
        outcome: outcomeOf(side === 'cash' ? 'CASH' : 'ASSET'),
        counterparty,
      };
    };

    const messages: readonly MessageView[] = messageRows.map((row) => ({
      messageType: text(row['message_type']),
      sequence: text(row['sequence']),
      finality: text(row['finality']),
      emitter: text(row['emitter']),
      wormholeChainId: num(row['wormhole_chain_id']),
      consumed: text(row['destination_chain_id']) !== '',
      finalitySeconds: undefined,
    }));

    return {
      settlementId: head.settlement_id,
      deploymentId: head.deployment_id,
      generation: head.generation,
      canonicalState: head.canonical_state,
      decision: head.decision,
      verifierClass: head.verifier_class ?? undefined,
      cash: leg('cash'),
      asset: leg('asset'),
      messages,
      compliance: await complianceFor(sql, settlementId),
      disposition: await dispositionFor(sql, settlementId),
      conservation: [],
      termsKnown,
    };
  });
}

async function complianceFor(sql: Sql, settlementId: string) {
  const rows = (await sql`
    SELECT subject, eligible, issued_at, cleanverse_endpoint, evidence_hash
      FROM conduit.compliance_attestations
     WHERE settlement_id = ${settlementId} ORDER BY issued_at
  `) as unknown as readonly Record<string, unknown>[];
  return rows.map((row) => ({
    subject: text(row['subject']),
    eligible: row['eligible'] === true,
    at: text(row['issued_at']),
    source: optionalText(row['cleanverse_endpoint']) ?? 'verify_apass',
    evidenceHash: text(row['evidence_hash']),
  }));
}

async function dispositionFor(
  sql: Sql,
  settlementId: string,
): Promise<DispositionView | undefined> {
  const [row] = (await sql`
    SELECT case_id, leg, case_state, policy_hash, executed_type, executed_destination
      FROM conduit.disposition_cases WHERE settlement_id = ${settlementId} LIMIT 1
  `) as unknown as readonly Record<string, unknown>[];
  if (row === undefined) return undefined;

  const orders = (await sql`
    SELECT authority, authority_type FROM conduit.disposition_orders
     WHERE case_id = ${text(row['case_id'])}
  `) as unknown as readonly Record<string, unknown>[];

  return {
    caseId: text(row['case_id']),
    leg: text(row['leg']),
    state: text(row['case_state']),
    dispositionType: optionalText(row['executed_type']),
    destination: optionalText(row['executed_destination']),
    authorities: orders.map((order) => ({
      address: text(order['authority']),
      authorityType: text(order['authority_type']),
    })),
    policyHash: text(row['policy_hash']),
  };
}

export interface VerificationResult {
  readonly classification: string;
  readonly findings: readonly { check: string; ok: boolean; detail: string }[];
  readonly hadScanGap: boolean;
  readonly searchedRanges: Readonly<Record<string, { from: string; to: string }>>;
  readonly trustRoot: string;
  readonly ranAt: string;
}

export async function latestVerification(
  env: Env,
  settlementId: string,
): Promise<VerificationResult | undefined> {
  return withDb(env, async (sql) => {
    const [row] = (await sql`
      SELECT classification, findings, searched_ranges, had_scan_gap, trust_root, ran_at
        FROM conduit.verification_runs
       WHERE settlement_id = ${settlementId}
       ORDER BY ran_at DESC LIMIT 1
    `) as unknown as readonly Record<string, unknown>[];
    if (row === undefined) return undefined;

    // These arrive as JSON text rather than parsed objects, so both shapes are
    // accepted: a driver that parses jsonb and a column that hands back a
    // string are equally valid sources and neither should 500 the page.
    const findings = jsonColumn<readonly { check: string; ok: boolean; detail: string }[]>(
      row['findings'],
      [],
    );
    const ranges = jsonColumn<Readonly<Record<string, { from: string; to: string }>>>(
      row['searched_ranges'],
      {},
    );

    return {
      classification: text(row['classification']),
      findings,
      hadScanGap: row['had_scan_gap'] === true,
      searchedRanges: ranges,
      trustRoot: text(row['trust_root']),
      ranAt: text(row['ran_at']),
    };
  });
}

export async function deployments(env: Env): Promise<readonly DeploymentView[]> {
  return withDb(env, async (sql) => {
    const rows = (await sql`
      SELECT deployment_id, generation, git_commit, solc_version, superseded_by
        FROM conduit.deployments ORDER BY generation
    `) as unknown as readonly Record<string, unknown>[];

    const contracts = (await sql`
      SELECT deployment_id, role, address, chain_id FROM conduit.deployment_contracts
       ORDER BY deployment_id, role
    `) as unknown as readonly Record<string, unknown>[];

    return rows.map((row) => ({
      deploymentId: text(row['deployment_id']),
      generation: num(row['generation']),
      gitCommit: text(row['git_commit']),
      solcVersion: text(row['solc_version']),
      supersededBy: optionalText(row['superseded_by']),
      contracts: contracts
        .filter((contract) => contract['deployment_id'] === row['deployment_id'])
        .map((contract) => ({
          role: text(contract['role']),
          address: text(contract['address']),
          chainId: num(contract['chain_id']),
        })),
    }));
  });
}

export interface DispositionRow {
  readonly caseId: string;
  readonly settlementId: string;
  readonly leg: string;
  readonly caseState: string;
}

export async function dispositionCases(env: Env): Promise<readonly DispositionRow[]> {
  return withDb(env, async (sql) => {
    const rows = (await sql`
      SELECT case_id, settlement_id, leg, case_state FROM conduit.disposition_cases
       ORDER BY filed_at DESC NULLS LAST
    `) as unknown as readonly Record<string, unknown>[];
    return rows.map((row) => ({
      caseId: text(row['case_id']),
      settlementId: text(row['settlement_id']),
      leg: text(row['leg']),
      caseState: text(row['case_state']),
    }));
  });
}

export interface Totals {
  readonly settlements: number;
  readonly messages: number;
  readonly verifications: number;
  readonly generations: number;
  readonly held: number;
}

export async function totals(env: Env): Promise<Totals> {
  return withDb(env, async (sql) => {
    const [row] = (await sql`
      SELECT (SELECT count(*) FROM conduit.settlements)                              AS settlements,
             (SELECT count(*) FROM conduit.messages)                                 AS messages,
             (SELECT count(*) FROM conduit.verification_runs)                        AS verifications,
             (SELECT count(*) FROM conduit.deployments)                              AS generations,
             (SELECT count(*) FROM conduit.settlements WHERE canonical_state='HELD') AS held
    `) as unknown as readonly Record<string, unknown>[];
    return {
      settlements: Number(row?.['settlements'] ?? 0),
      messages: Number(row?.['messages'] ?? 0),
      verifications: Number(row?.['verifications'] ?? 0),
      generations: Number(row?.['generations'] ?? 0),
      held: Number(row?.['held'] ?? 0),
    };
  });
}

export async function evidenceFor(
  env: Env,
  settlementId: string,
): Promise<readonly { label: string; detail: string; at: string }[]> {
  return withDb(env, async (sql) => {
    const rows = (await sql`
      SELECT kind, content_sha256, storage_uri, created_at FROM conduit.evidence_artifacts
       WHERE settlement_id = ${settlementId} ORDER BY created_at
    `) as unknown as readonly Record<string, unknown>[];
    return rows.map((row) => ({
      label: text(row['kind']),
      detail: String(row['content_sha256']),
      at: text(row['created_at']),
    }));
  });
}
