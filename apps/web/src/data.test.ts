/**
 * The read layer's order of work, and what the landing does when a read fails.
 *
 * `postgres` is replaced by a fake connection that answers each query from a script and records
 * when the query started and when it ended. That is what these tests protect: the shape of the
 * traffic, which no page test can see. They pin which reads wait for which, and how many
 * connections a route opens. A connection costs several times what a query does, so the count
 * is part of how long a page takes.
 *
 * The fake is lazy, like the driver's own queries: nothing starts until something awaits it. A
 * read that is built early and awaited late would run in sequence against the real driver and
 * in parallel against an eager fake, and the test would pass for the wrong reason.
 *
 * The Worker's `Env` is built by cast, as in `eligibility.test.ts`. `security-boundaries.test.ts`
 * fails every file under `apps/web/src`, other than the Worker's own test, that names the
 * connection-string variable, and the driver is mocked here so nothing would read it anyway.
 */

import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { landingFacts, settlementView, type Env } from './data.js';
import worker from './worker.js';

vi.mock('postgres', () => ({ default: vi.fn() }));

const ENV = {
  MONAD_RPC_URL: 'https://unused.invalid',
  BASE_RPC_URL: 'https://unused.invalid',
  DEPLOYMENT_ID: '0x0',
  COMMIT_SHA: 'test',
} as unknown as Env;

/** A piece of each query's text that no other query contains. */
const FRAGMENTS = {
  totals: 'AS generations',
  newest: 'ORDER BY s.created_at DESC',
  head: 'WHERE s.settlement_id =',
  terms: 'FROM conduit.intents WHERE intent_hash',
  legs: 'FROM conduit.settlement_legs',
  messages: 'FROM conduit.messages m',
  compliance: 'FROM conduit.compliance_attestations',
  dispositionCase: 'FROM conduit.disposition_cases',
  dispositionOrders: 'FROM conduit.disposition_orders',
} as const;

type QueryName = keyof typeof FRAGMENTS;
type Row = Readonly<Record<string, unknown>>;
type Rows = readonly Row[];

/** What each query answers. A query left out answers no rows, and an error rejects. */
type Script = Readonly<Partial<Record<QueryName, Rows | Error>>>;

type Event =
  { readonly kind: 'start' | 'end'; readonly query: QueryName } | { readonly kind: 'closed' };

interface Call {
  readonly query: QueryName;
  readonly values: readonly unknown[];
}

const QUERY_NAMES = Object.keys(FRAGMENTS) as readonly QueryName[];

function queryNamed(text: string): QueryName {
  const named = QUERY_NAMES.filter((name) => text.includes(FRAGMENTS[name]));
  const [only] = named;
  if (only === undefined || named.length > 1) {
    throw new Error(`the fake connection cannot tell which query this is: ${text}`);
  }
  return only;
}

const turn = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * A connection that answers from `script`, installed as what the driver returns.
 *
 * Each query takes one turn of the event loop, so queries issued in the same tick are all in
 * flight before any of them ends.
 */
function database(script: Script) {
  const events: Event[] = [];
  const calls: Call[] = [];
  const end = vi.fn(() => {
    events.push({ kind: 'closed' });
    return Promise.resolve();
  });

  const tag = (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<Rows> => {
    const query = queryNamed(strings.join('?'));
    calls.push({ query, values });

    let started: Promise<Rows> | undefined;
    const run = async (): Promise<Rows> => {
      events.push({ kind: 'start', query });
      await turn();
      events.push({ kind: 'end', query });
      const answer = script[query] ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { then: (onFulfilled, onRejected) => (started ??= run()).then(onFulfilled, onRejected) };
  };

  vi.mocked(postgres).mockReturnValue(
    Object.assign(tag, { end }) as unknown as ReturnType<typeof postgres>,
  );
  return { events, calls, end };
}

/** The queries that were in flight together, group by group, in the order the groups began. */
function waves(events: readonly Event[]): readonly (readonly QueryName[])[] {
  const groups: QueryName[][] = [];
  let previous: 'start' | 'end' = 'end';
  for (const event of events) {
    if (event.kind === 'closed') continue;
    if (event.kind === 'start') {
      if (previous === 'end') groups.push([]);
      groups[groups.length - 1]?.push(event.query);
    }
    previous = event.kind;
  }
  return groups.map((group) => group.sort());
}

const SETTLEMENT_ID = `0x${'ab'.repeat(32)}`;
const INTENT_HASH = `0x${'ee'.repeat(32)}`;
const CASH_TOKEN = '0xFEfd2eA28dB25c720ec5298964F8d2F34e3f1F16';
const BOND_TOKEN = '0xDdB1AE5685F4033Ed10B3DfCe5e9dc13D3e4989B';
const BUYER = `0x${'11'.repeat(20)}`;
const SELLER = `0x${'22'.repeat(20)}`;

const HEAD: Row = {
  settlement_id: SETTLEMENT_ID,
  deployment_id: 'gen3',
  intent_hash: INTENT_HASH,
  canonical_state: 'SETTLED',
  decision: 'COMMIT',
  verifier_class: 'SETTLED_FINAL',
  generation: 3,
};

const TERMS: Row = {
  cash_chain_id: 10143,
  cash_asset: CASH_TOKEN,
  cash_amount: '25000000',
  cash_payer: BUYER,
  cash_receiver: SELLER,
  asset_chain_id: 84532,
  asset_token: BOND_TOKEN,
  asset_amount: '500000',
  asset_seller: SELLER,
  asset_receiver: BUYER,
  terms_source: 'artifact',
};

const SETTLED: Script = {
  totals: [{ settlements: '3', messages: '9', verifications: '4', generations: '2', held: '1' }],
  newest: [HEAD],
  head: [HEAD],
  terms: [TERMS],
  legs: [
    { leg: 'CASH', chain_id: 10143, outcome: 'RELEASED' },
    { leg: 'ASSET', chain_id: 84532, outcome: 'HELD' },
  ],
  messages: [
    {
      message_type: 'ASSET_PREPARED',
      sequence: 7,
      finality: 'FINALIZED',
      emitter: '0xbase',
      wormhole_chain_id: 10004,
      source_chain_id: 84532,
      published_tx_hash: '0xpublished1',
      finality_seconds: 1200,
    },
    {
      message_type: 'COMMIT',
      sequence: '12',
      finality: 'FINALIZED',
      emitter: '0xmonad',
      wormhole_chain_id: 10009,
      source_chain_id: 10143,
      published_tx_hash: '0xpublished2',
      finality_seconds: null,
    },
  ],
  compliance: [
    {
      subject: BUYER,
      eligible: true,
      issued_at: new Date('2026-01-01T00:00:00Z'),
      cleanverse_endpoint: 'verify_apass',
      evidence_hash: '0xevidence1',
    },
    {
      subject: SELLER,
      eligible: false,
      issued_at: '2026-01-01T00:01:00Z',
      cleanverse_endpoint: null,
      evidence_hash: '0xevidence2',
    },
  ],
};

const HELD: Script = {
  ...SETTLED,
  dispositionCase: [
    {
      case_id: '0xca5e',
      leg: 'ASSET',
      case_state: 'OPEN',
      policy_hash: '0xpolicy',
      executed_type: null,
      executed_destination: null,
    },
  ],
  dispositionOrders: [
    { authority: '0xauthority1', authority_type: 'ISSUER' },
    { authority: '0xauthority2', authority_type: 'REGULATOR' },
  ],
};

/** What follows the head, one read at a time, in the order the view asks for them. */
const THE_READS_AFTER_THE_HEAD: readonly (readonly QueryName[])[] = [
  ['terms'],
  ['legs'],
  ['messages'],
  ['compliance'],
  ['dispositionCase'],
];

beforeEach(() => {
  vi.mocked(postgres).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a settlement read on one connection', () => {
  it('reads the head first and then one read at a time', async () => {
    // #given a settlement with no disposition case
    const db = database(SETTLED);

    // #when it is read
    await settlementView(ENV, SETTLEMENT_ID);

    // #then no read started before the one ahead of it had ended, because the driver would not
    // have sent them together anyway and a failure could strand the ones queued behind it
    expect(waves(db.events)).toEqual([['head'], ...THE_READS_AFTER_THE_HEAD]);
  });

  it('reads the orders of a case only after the case itself', async () => {
    // #given a settlement with a disposition case
    const db = database(HELD);

    // #when it is read
    await settlementView(ENV, SETTLEMENT_ID);

    // #then the orders come last, because the case id comes from the case
    expect(waves(db.events)).toEqual([
      ['head'],
      ...THE_READS_AFTER_THE_HEAD,
      ['dispositionOrders'],
    ]);
  });

  it('asks for the terms by the intent hash that the head returned', async () => {
    // #given a settlement
    const db = database(SETTLED);

    // #when it is read
    await settlementView(ENV, SETTLEMENT_ID);

    // #then the terms were looked up by the head's intent hash, which is why the head goes first
    expect(db.calls.find((call) => call.query === 'terms')?.values).toEqual([INTENT_HASH]);
  });

  it('asks for nothing else when the settlement is not indexed', async () => {
    // #given a settlement the projection does not hold
    const db = database({});

    // #when it is read
    await settlementView(ENV, SETTLEMENT_ID);

    // #then only the head was asked for
    expect(waves(db.events)).toEqual([['head']]);
  });

  it('answers nothing when the settlement is not indexed', async () => {
    // #given a settlement the projection does not hold
    database({});

    // #when it is read
    const view = await settlementView(ENV, SETTLEMENT_ID);

    // #then there is no view
    expect(view).toBeUndefined();
  });

  it('opens one connection', async () => {
    // #given a settlement
    database(HELD);

    // #when it is read
    await settlementView(ENV, SETTLEMENT_ID);

    // #then the driver was asked for one
    expect(postgres).toHaveBeenCalledTimes(1);
  });

  it('closes the connection when it is done', async () => {
    // #given a settlement
    const db = database(HELD);

    // #when it is read
    await settlementView(ENV, SETTLEMENT_ID);

    // #then the connection was ended once
    expect(db.end).toHaveBeenCalledTimes(1);
  });

  it('shows a message as consumed only when the independent verifier proved it', async () => {
    // #given a settlement whose verifier has not reached SETTLED_FINAL
    database({ ...SETTLED, head: [{ ...HEAD, verifier_class: 'HELD_PENDING_DISPOSITION' }] });

    // #when it is read
    const view = await settlementView(ENV, SETTLEMENT_ID);

    // #then no message claims to have been consumed
    expect(view?.messages.map((message) => message.consumed)).toEqual([false, false]);
  });

  it('gives up on a database that accepts nothing after five seconds, not thirty', async () => {
    // #given a settlement read
    database(SETTLED);

    // #when the connection is opened
    await settlementView(ENV, SETTLEMENT_ID);

    // #then the driver was told to stop waiting for a connection after five seconds
    expect(vi.mocked(postgres).mock.calls[0]?.[1]).toMatchObject({ connect_timeout: 5 });
  });

  it('drains the connection after a good read', async () => {
    // #given a settlement read that succeeds
    const db = database(SETTLED);

    // #when it is read
    await settlementView(ENV, SETTLEMENT_ID);

    // #then the socket is ended with the usual five second drain
    expect(db.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('drops the connection at once after a failed read', async () => {
    // #given a settlement whose messages cannot be read
    const db = database({ ...SETTLED, messages: new Error('messages read failed') });

    // #when it is read and fails
    await Promise.allSettled([settlementView(ENV, SETTLEMENT_ID)]);

    // #then the socket is not held open for a drain that has nothing to wait for
    expect(db.end).toHaveBeenCalledWith({ timeout: 0 });
  });

  it('returns every field of the view, in the order the rows came back', async () => {
    // #given a settlement with terms, legs, messages, attestations and a disposition case
    database(HELD);

    // #when it is read
    const view = await settlementView(ENV, SETTLEMENT_ID);

    // #then each field is what the rows say
    expect(view).toEqual({
      settlementId: SETTLEMENT_ID,
      deploymentId: 'gen3',
      generation: 3,
      canonicalState: 'SETTLED',
      decision: 'COMMIT',
      verifierClass: 'SETTLED_FINAL',
      cash: {
        chain: '',
        chainId: 10143,
        asset: CASH_TOKEN,
        assetSymbol: 'cSETTLE',
        amount: '25',
        outcome: 'RELEASED',
        counterparty: BUYER,
      },
      asset: {
        chain: '',
        chainId: 84532,
        asset: BOND_TOKEN,
        assetSymbol: 'cBOND',
        amount: '0.5',
        outcome: 'HELD',
        counterparty: BUYER,
      },
      messages: [
        {
          messageType: 'ASSET_PREPARED',
          sequence: '7',
          finality: 'FINALIZED',
          emitter: '0xbase',
          wormholeChainId: 10004,
          consumed: true,
          finalitySeconds: 1200,
          publishedTxHash: '0xpublished1',
          publishedChainId: 84532,
        },
        {
          messageType: 'COMMIT',
          sequence: '12',
          finality: 'FINALIZED',
          emitter: '0xmonad',
          wormholeChainId: 10009,
          consumed: true,
          finalitySeconds: undefined,
          publishedTxHash: '0xpublished2',
          publishedChainId: 10143,
        },
      ],
      compliance: [
        {
          subject: BUYER,
          eligible: true,
          at: '2026-01-01T00:00:00.000Z',
          source: 'verify_apass',
          evidenceHash: '0xevidence1',
        },
        {
          subject: SELLER,
          eligible: false,
          at: '2026-01-01T00:01:00Z',
          source: 'verify_apass',
          evidenceHash: '0xevidence2',
        },
      ],
      disposition: {
        caseId: '0xca5e',
        leg: 'ASSET',
        state: 'OPEN',
        dispositionType: undefined,
        destination: undefined,
        authorities: [
          { address: '0xauthority1', authorityType: 'ISSUER' },
          { address: '0xauthority2', authorityType: 'REGULATOR' },
        ],
        policyHash: '0xpolicy',
      },
      conservation: [],
      termsKnown: true,
    });
  });

  it('marks the amounts as not recovered when no intent row exists', async () => {
    // #given a settlement whose terms were never recovered
    database({ head: [HEAD], legs: SETTLED.legs ?? [] });

    // #when it is read
    const view = await settlementView(ENV, SETTLEMENT_ID);

    // #then neither leg shows a placeholder amount as if it were a trade
    expect([view?.cash.amount, view?.asset.amount, view?.termsKnown]).toEqual([
      'not recovered',
      'not recovered',
      false,
    ]);
  });

  it('rejects when a read fails', async () => {
    // #given a settlement whose messages cannot be read
    database({ ...SETTLED, messages: new Error('messages read failed') });

    // #when it is read
    const read = settlementView(ENV, SETTLEMENT_ID);

    // #then the whole read fails with that error
    await expect(read).rejects.toThrow('messages read failed');
  });

  it('closes the connection when a read fails', async () => {
    // #given a settlement whose messages cannot be read
    const db = database({ ...SETTLED, messages: new Error('messages read failed') });

    // #when it is read and fails
    await Promise.allSettled([settlementView(ENV, SETTLEMENT_ID)]);

    // #then the connection was still ended
    expect(db.end).toHaveBeenCalledTimes(1);
  });
});

describe('the landing facts', () => {
  it('opens one connection', async () => {
    // #given a database with a settlement that has a disposition case
    database(HELD);

    // #when the facts for the landing are read
    await landingFacts(ENV);

    // #then the driver was asked for one connection
    expect(postgres).toHaveBeenCalledTimes(1);
  });

  it('closes that connection when it is done', async () => {
    // #given a database with a settlement
    const db = database(HELD);

    // #when the facts for the landing are read
    await landingFacts(ENV);

    // #then the connection was ended once
    expect(db.end).toHaveBeenCalledTimes(1);
  });

  it('reads the totals and the newest settlement together, then that settlement one read at a time', async () => {
    // #given a database with a settlement that has no disposition case
    const db = database(SETTLED);

    // #when the facts for the landing are read
    await landingFacts(ENV);

    // #then the two opening reads were in flight at once, and the view followed them
    expect(waves(db.events)).toEqual([['newest', 'totals'], ['head'], ...THE_READS_AFTER_THE_HEAD]);
  });

  it('asks for only the newest settlement', async () => {
    // #given a database with settlements
    const db = database(SETTLED);

    // #when the facts for the landing are read
    await landingFacts(ENV);

    // #then the list query was limited to one
    expect(db.calls.find((call) => call.query === 'newest')?.values).toEqual([1]);
  });

  it('reads the featured settlement by the id of the newest one', async () => {
    // #given a database whose newest settlement has an id
    const db = database(SETTLED);

    // #when the facts for the landing are read
    await landingFacts(ENV);

    // #then the head query was for that id
    expect(db.calls.find((call) => call.query === 'head')?.values).toEqual([SETTLEMENT_ID]);
  });

  it('returns the counts it read', async () => {
    // #given a database with counts
    database(SETTLED);

    // #when the facts for the landing are read
    const facts = await landingFacts(ENV);

    // #then they are the counts, as numbers
    expect(facts.totals).toEqual({
      settlements: 3,
      messages: 9,
      verifications: 4,
      generations: 2,
      held: 1,
    });
  });

  it('features the newest settlement in full', async () => {
    // #given a database with a settled trade
    database(SETTLED);

    // #when the facts for the landing are read
    const facts = await landingFacts(ENV);

    // #then the featured view carries its terms, which the list query leaves out
    expect(facts.featured?.cash.amount).toBe('25');
  });

  it('features nothing when no settlement is indexed', async () => {
    // #given a database with counts and no settlements
    database({ totals: SETTLED.totals ?? [] });

    // #when the facts for the landing are read
    const facts = await landingFacts(ENV);

    // #then nothing is featured
    expect(facts.featured).toBeUndefined();
  });

  it('asks for nothing beyond the opening two reads when no settlement is indexed', async () => {
    // #given a database with counts and no settlements
    const db = database({ totals: SETTLED.totals ?? [] });

    // #when the facts for the landing are read
    await landingFacts(ENV);

    // #then there was no head to ask for
    expect(waves(db.events)).toEqual([['newest', 'totals']]);
  });

  it.each(['totals', 'newest', 'head', 'legs', 'dispositionCase'] as const)(
    'rejects when the %s read fails',
    async (failing) => {
      // #given a database in which one read fails
      database({ ...SETTLED, [failing]: new Error(`${failing} failed`) });

      // #when the facts for the landing are read
      const read = landingFacts(ENV);

      // #then the whole read fails, because half a landing would print a wrong figure
      await expect(read).rejects.toThrow(`${failing} failed`);
    },
  );

  it('closes the connection when a read fails', async () => {
    // #given a database in which the legs cannot be read
    const db = database({ ...SETTLED, legs: new Error('legs failed') });

    // #when the facts for the landing are read and fail
    await Promise.allSettled([landingFacts(ENV)]);

    // #then the connection was still ended
    expect(db.end).toHaveBeenCalledTimes(1);
  });
});

describe('the landing route', () => {
  const landing = (): Promise<Response> =>
    worker.fetch(new Request('https://tryconduit.xyz/'), ENV);

  const statLabels = (html: string): readonly string[] =>
    [...html.matchAll(/<div class="stat-label">([^<]*)<\/div>/g)].map((match) => match[1] ?? '');

  const statValues = (html: string): readonly string[] =>
    [...html.matchAll(/<div class="stat-value">([^<]*)<\/div>/g)].map((match) => match[1] ?? '');

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('opens one connection', async () => {
    // #given a database with a featured settlement
    database(SETTLED);

    // #when the landing is requested
    await landing();

    // #then the route read everything it needs on a single connection
    expect(postgres).toHaveBeenCalledTimes(1);
  });

  it('shows the counts it read', async () => {
    // #given a database with counts
    database(SETTLED);

    // #when the landing is requested
    const html = await (await landing()).text();

    // #then the four figures are the four counts
    expect(statValues(html)).toEqual(['3', '9', '4', '2']);
  });

  it('features the newest settlement it read', async () => {
    // #given a database with a settlement
    database(SETTLED);

    // #when the landing is requested
    const html = await (await landing()).text();

    // #then the hero links to it
    expect(html).toContain(`<a class="hero-proof" href="/app/settlements/${SETTLEMENT_ID}">`);
  });

  it('answers 200 when a read of the featured settlement fails after the counts were read', async () => {
    // #given a database that answers the counts and then loses the messages
    database({ ...SETTLED, messages: new Error('connection terminated') });

    // #when the landing is requested
    const response = await landing();

    // #then the page is still served
    expect(response.status).toBe(200);
  });

  it('shows no figure when a read of the featured settlement fails after the counts were read', async () => {
    // #given a database that answers the counts and then loses the messages
    database({ ...SETTLED, messages: new Error('connection terminated') });

    // #when the landing is requested
    const html = await (await landing()).text();

    // #then the counts it did read are not shown either, so no half of the facts passes for all
    expect(statLabels(html)).toEqual([]);
  });

  it('shows no featured settlement when a read fails', async () => {
    // #given a database that answers the counts and then loses the messages
    database({ ...SETTLED, messages: new Error('connection terminated') });

    // #when the landing is requested
    const html = await (await landing()).text();

    // #then the hero has no settlement to link
    expect(html).not.toContain('class="hero-proof"');
  });
});
