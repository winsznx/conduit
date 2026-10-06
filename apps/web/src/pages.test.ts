import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Totals, VerificationResult } from './data.js';
import {
  CLASS_MEANING,
  describeOutcome,
  type DeploymentView,
  type LegView,
  type SettlementView,
} from './domain.js';
import type { ProofPackage } from './evidence.js';
import { DESCRIPTOR, setSite } from './head.js';
import {
  renderComposer,
  renderDeployments,
  renderDispositions,
  renderError,
  renderEvidence,
  renderEvidenceHome,
  renderLanding,
  renderNotFound,
  renderOverview,
  renderSettlement,
  renderSettlements,
  renderSignRequest,
  renderSystem,
  renderVerification,
  renderVerifierHome,
  setDeployment,
} from './pages.js';
import { truncate } from './ui.js';

const SITE = 'https://tryconduit.xyz';
const ABSOLUTE_ON_SITE = /^https:\/\/tryconduit\.xyz\/./;
const GENERATION = 'Generation 3';
const SETTLEMENT_ID = `0x${'ab'.repeat(32)}`;
const SHORT_ID = truncate(SETTLEMENT_ID);
const ADDRESS = `0x${'11'.repeat(20)}`;
const OTHER_ADDRESS = `0x${'22'.repeat(20)}`;

const INDEXED_ARTIFACT = {
  label: 'MESSAGE',
  detail: `0x${'cd'.repeat(32)}`,
  at: '2026-01-01T00:00:00Z',
};

const TOTALS: Totals = { settlements: 0, messages: 0, verifications: 0, generations: 1, held: 0 };

const DEPLOYMENT = {
  deploymentId: 'gen3',
  coordinator: ADDRESS,
  cashEscrow: ADDRESS,
  cashAsset: ADDRESS,
  rwaToken: OTHER_ADDRESS,
  rwaAdapter: OTHER_ADDRESS,
};

const SIGN_REQUEST = {
  deployment: DEPLOYMENT,
  cashAmount: '25.000000',
  assetAmount: '0.500000',
  cashPayer: ADDRESS,
  cashReceiver: OTHER_ADDRESS,
  assetSeller: OTHER_ADDRESS,
  assetReceiver: ADDRESS,
  prepareDeadline: '2026-01-01T01:00:00Z',
  commitDeadline: '2026-01-01T03:00:00Z',
  releaseDeadline: '2026-01-01T04:00:00Z',
  payerSigned: true,
  sellerSigned: false,
  intent: {},
};

const leg = (over: Partial<LegView> = {}): LegView => ({
  chain: '',
  chainId: 10143,
  asset: ADDRESS,
  assetSymbol: 'cSETTLE',
  amount: '25',
  outcome: 'RELEASED',
  counterparty: OTHER_ADDRESS,
  ...over,
});

function view(over: Partial<SettlementView> = {}): SettlementView {
  return {
    settlementId: SETTLEMENT_ID,
    deploymentId: 'gen3',
    generation: 3,
    canonicalState: 'SETTLED',
    decision: 'COMMIT',
    verifierClass: 'SETTLED_FINAL',
    cash: leg(),
    asset: leg({ chainId: 84532, assetSymbol: 'cBOND', amount: '0.5' }),
    messages: [],
    compliance: [],
    disposition: undefined,
    conservation: [],
    termsKnown: true,
    ...over,
  };
}

const heldView = (): SettlementView =>
  view({
    canonicalState: 'HELD',
    verifierClass: 'HELD_PENDING_DISPOSITION',
    asset: leg({ chainId: 84532, assetSymbol: 'cBOND', amount: '0.5', outcome: 'HELD' }),
  });

const CLASSIFICATION = 'SETTLED_PENDING_VERIFICATION';

function verification(over: Partial<VerificationResult> = {}): VerificationResult {
  return {
    classification: CLASSIFICATION,
    findings: [
      { check: 'cash leg delivered', ok: true, detail: 'read from the chain' },
      { check: 'asset leg delivered', ok: true, detail: 'read from the chain' },
      { check: 'message consumed once', ok: false, detail: 'no consumption event found' },
    ],
    hadScanGap: false,
    searchedRanges: {},
    trustRoot: 'two chain RPCs and the guardian set',
    ranAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function proof(summary = 'Both legs delivered on the deployed contracts.'): ProofPackage {
  return {
    settlementId: SETTLEMENT_ID,
    title: 'A settled trade',
    summary,
    generation: 3,
    outcome: 'SETTLED',
    source: 'docs/evidence/fixture.json',
    startedAt: undefined,
    finishedAt: undefined,
    note: undefined,
    artifacts: [],
    verification: undefined,
  };
}

const decode = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** Every `<meta>` or `<link>` as an attribute map, so tests read tags rather than strings. */
function tags(html: string): readonly Record<string, string>[] {
  return [...html.matchAll(/<(meta|link)\s+([^>]*)>/g)].map((match) => {
    const attributes: Record<string, string> = { tag: match[1] ?? '' };
    for (const pair of (match[2] ?? '').matchAll(/([a-z:-]+)="([^"]*)"/g)) {
      attributes[pair[1] ?? ''] = decode(pair[2] ?? '');
    }
    return attributes;
  });
}

const content = (html: string, key: string): string | undefined =>
  tags(html).find((tag) => tag['property'] === key || tag['name'] === key)?.['content'];

const links = (html: string, rel: string): readonly Record<string, string>[] =>
  tags(html).filter((tag) => tag['tag'] === 'link' && tag['rel'] === rel);

function titleOf(html: string): string | undefined {
  const text = /<title>(.*?)<\/title>/s.exec(html)?.[1];
  return text === undefined ? undefined : decode(text);
}

/** The stylesheet follows every tag under test, so cutting there keeps the CSS out of the parse. */
const headOf = (html: string): string => html.slice(0, html.indexOf('<style>'));

const bodyOf = (html: string): string => html.slice(html.indexOf('<body'));

const SKIP_LINK = '<a class="skip-link" href="#content">Skip to content</a>';

const firstAnchor = (html: string): string | undefined =>
  /<a\b[^>]*>.*?<\/a>/s.exec(bodyOf(html))?.[0];

const mainTags = (html: string): readonly string[] => bodyOf(html).match(/<main\b[^>]*>/g) ?? [];

const headingsOfLevelOne = (html: string): readonly string[] =>
  bodyOf(html).match(/<h1\b[^>]*>/g) ?? [];

/**
 * The sentence cut to 200 characters, worked out a word at a time. The page slices and backs
 * up to a space, and a second route to the same answer keeps this from restating it.
 */
function cutForm(sentence: string): string {
  if (sentence.length <= 200) return sentence;
  let kept = '';
  for (const word of sentence.split(' ')) {
    const next = kept === '' ? word : `${kept} ${word}`;
    if (next.length > 199) break;
    kept = next;
  }
  return `${kept}…`;
}

const outcomeSentence = (settlement: SettlementView): string => {
  const outcome = describeOutcome(settlement);
  return `${outcome.headline} ${outcome.detail}`;
};

beforeEach(() => {
  setSite(SITE);
});

afterEach(() => {
  setSite(undefined);
  setDeployment(undefined);
});

interface PageCase {
  readonly name: string;
  readonly render: () => string;
  readonly title: string;
  readonly path: string;
}

const PAGES: readonly PageCase[] = [
  {
    name: 'renderLanding',
    render: () => renderLanding(TOTALS, []),
    title: 'Conduit: cross-chain delivery versus payment',
    path: '/',
  },
  {
    name: 'renderLanding, without live counts',
    render: () => renderLanding(undefined, []),
    title: 'Conduit: cross-chain delivery versus payment',
    path: '/',
  },
  {
    name: 'renderOverview',
    render: () => renderOverview(GENERATION, TOTALS, []),
    title: 'Overview | Conduit',
    path: '/app',
  },
  {
    name: 'renderSettlements',
    render: () => renderSettlements(GENERATION, []),
    title: 'Settlements | Conduit',
    path: '/app/settlements',
  },
  {
    name: 'renderComposer, configured',
    render: () => renderComposer(GENERATION, DEPLOYMENT),
    title: 'New settlement | Conduit',
    path: '/app/settlements/new',
  },
  {
    name: 'renderComposer, unconfigured',
    render: () => renderComposer(GENERATION, undefined),
    title: 'New settlement | Conduit',
    path: '/app/settlements/new',
  },
  {
    name: 'renderSettlement',
    render: () => renderSettlement(GENERATION, view()),
    title: `Settlement ${SHORT_ID} | Conduit`,
    path: `/app/settlements/${SETTLEMENT_ID}`,
  },
  {
    name: 'renderSignRequest',
    render: () => renderSignRequest(GENERATION, SETTLEMENT_ID, SIGN_REQUEST),
    title: `Sign ${SHORT_ID} | Conduit`,
    path: `/app/settlements/${SETTLEMENT_ID}/sign`,
  },
  {
    name: 'renderDispositions',
    render: () => renderDispositions(GENERATION, []),
    title: 'Dispositions | Conduit',
    path: '/app/dispositions',
  },
  {
    name: 'renderVerifierHome',
    render: () => renderVerifierHome(GENERATION),
    title: 'Verifier | Conduit',
    path: '/app/verifier',
  },
  {
    name: 'renderVerification',
    render: () => renderVerification(GENERATION, SETTLEMENT_ID, verification()),
    title: `Verification ${SHORT_ID} | Conduit`,
    path: `/verify/${SETTLEMENT_ID}`,
  },
  {
    name: 'renderEvidenceHome',
    render: () => renderEvidenceHome(GENERATION),
    title: 'Evidence | Conduit',
    path: '/app/evidence',
  },
  {
    name: 'renderEvidence, with a proof package',
    render: () => renderEvidence(GENERATION, SETTLEMENT_ID, [], proof()),
    title: `Evidence ${SHORT_ID} | Conduit`,
    path: `/evidence/${SETTLEMENT_ID}`,
  },
  {
    name: 'renderEvidence, with indexed artifacts and no proof package',
    render: () => renderEvidence(GENERATION, SETTLEMENT_ID, [INDEXED_ARTIFACT]),
    title: `Evidence ${SHORT_ID} | Conduit`,
    path: `/evidence/${SETTLEMENT_ID}`,
  },
  {
    name: 'renderDeployments',
    render: () => renderDeployments(GENERATION, []),
    title: 'Deployments | Conduit',
    path: '/app/deployments',
  },
  {
    name: 'renderSystem',
    render: () => renderSystem(GENERATION, { deploymentId: 'gen3', commit: 'abc1234' }),
    title: 'System | Conduit',
    path: '/app/system',
  },
];

describe.each(PAGES)('$name', ({ render, title, path }) => {
  it('titles the document with the page name and the product', () => {
    // #given a page rendered on the configured site
    // #when its head is read
    const head = headOf(render());

    // #then the title has the expected form
    expect(titleOf(head)).toBe(title);
  });

  it('writes exactly one title element', () => {
    // #given a page rendered on the configured site
    // #when its head is read
    const head = headOf(render());

    // #then the head builder's title is the only one
    expect(head.match(/<title>/g)).toHaveLength(1);
  });

  it('writes one canonical link at the absolute address of the page', () => {
    // #given a page rendered on the configured site
    // #when its head is read
    const head = headOf(render());

    // #then the canonical link is the site plus the page's own path
    expect(links(head, 'canonical').map((tag) => tag['href'])).toEqual([`${SITE}${path}`]);
  });

  it('describes the page in words of its own, not the product descriptor', () => {
    // #given a page rendered on the configured site
    // #when its head is read
    const head = headOf(render());

    // #then the description is not the fallback
    expect(content(head, 'description')).not.toBe(DESCRIPTOR);
  });

  it('keeps the description within 200 characters', () => {
    // #given a page rendered on the configured site
    // #when its head is read
    const head = headOf(render());

    // #then the description fits
    expect(content(head, 'description')?.length).toBeLessThanOrEqual(200);
  });

  it('points og:image at an absolute address on the site', () => {
    // #given a page rendered on the configured site
    // #when its head is read
    const head = headOf(render());

    // #then the image is not a relative path
    expect(content(head, 'og:image')).toMatch(ABSOLUTE_ON_SITE);
  });

  it('writes exactly one main landmark', () => {
    // #given a page
    // #when its main tags are counted
    const found = mainTags(render());

    // #then there is one
    expect(found).toHaveLength(1);
  });

  it('gives the main landmark the id the skip link points at', () => {
    // #given a page
    // #when its main tag is read
    const [main] = mainTags(render());

    // #then it carries id="content"
    expect(main).toMatch(/\sid="content"/);
  });

  it('makes the main landmark focusable by script so the skip link can move focus into it', () => {
    // #given a page
    // #when its main tag is read
    const [main] = mainTags(render());

    // #then it takes programmatic focus without joining the tab order
    expect(main).toMatch(/\stabindex="-1"/);
  });

  it('makes the skip link the first anchor in the body', () => {
    // #given a page
    // #when its first anchor is read
    const anchor = firstAnchor(render());

    // #then it is the skip link
    expect(anchor).toBe(SKIP_LINK);
  });
});

describe.each([
  {
    name: 'renderNotFound',
    render: () => renderNotFound('No such page', 'Nothing is served here.'),
    title: 'Not found | Conduit',
  },
  {
    name: 'renderError',
    render: () => renderError('The request failed.'),
    title: 'Error | Conduit',
  },
])('$name', ({ render, title }) => {
  it('titles the document with the page name and the product', () => {
    // #given an error page rendered on the configured site
    // #when its head is read
    const head = headOf(render());

    // #then the title has the expected form
    expect(titleOf(head)).toBe(title);
  });

  it('asks search engines to leave it out of the index', () => {
    // #given an error page rendered on the configured site
    // #when its head is read
    const head = headOf(render());

    // #then it is marked noindex
    expect(content(head, 'robots')).toBe('noindex');
  });

  it('declares no address of its own', () => {
    // #given an error page rendered on the configured site
    // #when its head is read
    const head = headOf(render());

    // #then there is no canonical link and no og:url
    expect([links(head, 'canonical').length, content(head, 'og:url')]).toEqual([0, undefined]);
  });

  it('links the wordmark home, because a stuck reader reaches for it', () => {
    // #given an error page
    // #when the markup is read
    const html = render();

    // #then the wordmark is the link to the home page
    expect(html).toContain(
      '<a class="identity" href="/" aria-label="Conduit, back to the home page">',
    );
  });

  it('falls back to the product descriptor, because a failure has nothing to describe', () => {
    // #given an error page rendered on the configured site
    // #when its head is read
    const head = headOf(render());

    // #then the description is the descriptor
    expect(content(head, 'description')).toBe(DESCRIPTOR);
  });

  it('writes exactly one main landmark with the id the skip link points at', () => {
    // #given an error page
    // #when its main tags are read
    const found = mainTags(render());

    // #then there is one and it is the skip link's target
    expect(found.map((tag) => /\sid="content"/.test(tag))).toEqual([true]);
  });

  it('makes the skip link the first anchor in the body', () => {
    // #given an error page
    // #when its first anchor is read
    const anchor = firstAnchor(render());

    // #then it is the skip link
    expect(anchor).toBe(SKIP_LINK);
  });

  it('writes exactly one h1, because the page is nothing but its message', () => {
    // #given an error page
    // #when its h1 elements are counted
    const found = headingsOfLevelOne(render());

    // #then there is one
    expect(found).toHaveLength(1);
  });
});

describe.each([
  ['renderSettlements', () => renderSettlements(GENERATION, [view()])],
  ['renderOverview', () => renderOverview(GENERATION, TOTALS, [view()])],
])('the settlements table on %s', (_name, render) => {
  it('has no empty column header', () => {
    // #given a page that lists one settlement
    // #when its table headers are read
    const html = render();

    // #then none is empty
    expect(html).not.toMatch(/<th>\s*<\/th>/);
  });

  it('names the action column for assistive technology without showing the name', () => {
    // #given a page that lists one settlement
    // #when its table headers are read
    const html = render();

    // #then the last header holds visually hidden text
    expect(html).toContain('<th><span class="visually-hidden">Open</span></th></tr></thead>');
  });
});

describe('the description of a settlement', () => {
  it('states a short outcome sentence whole', () => {
    // #given a verified settlement whose outcome sentence fits
    const settled = view();

    // #when its head is read
    const head = headOf(renderSettlement(GENERATION, settled));

    // #then the description is the headline and the detail, joined by a space
    expect(content(head, 'description')).toBe(outcomeSentence(settled));
  });

  it('says a state once when its meaning opens with the same words', () => {
    // #given a settlement whose headline is also the first words of its meaning
    const locked = view({ canonicalState: 'CASH_PREPARED', verifierClass: undefined });

    // #when its head is read
    const description = content(headOf(renderSettlement(GENERATION, locked)), 'description') ?? '';

    // #then the sentence appears once
    expect(description.split('Cash is locked.')).toHaveLength(2);
  });

  it('carries no dash from the state meaning into the description', () => {
    // #given a committed settlement, whose meaning has a dash in the page copy
    const committed = view({ canonicalState: 'COMMIT_ISSUED', verifierClass: undefined });

    // #when its head is read
    const description = content(headOf(renderSettlement(GENERATION, committed)), 'description');

    // #then the dash became a comma
    expect(description).toContain('there is no refund, both legs execute');
  });

  it('cuts a long outcome sentence to the words that fit', () => {
    // #given a held settlement whose outcome sentence is longer than the limit
    const held = heldView();

    // #when its head is read
    const head = headOf(renderSettlement(GENERATION, held));

    // #then the description is the sentence cut at a word
    expect(content(head, 'description')).toBe(cutForm(outcomeSentence(held)));
  });

  it('marks a cut with a single ellipsis', () => {
    // #given a held settlement whose outcome sentence is longer than the limit
    // #when its head is read
    const head = headOf(renderSettlement(GENERATION, heldView()));

    // #then the description ends in one ellipsis character
    expect(content(head, 'description')).toMatch(/[^…]…$/);
  });

  it('keeps a cut description within 200 characters, the ellipsis included', () => {
    // #given a held settlement whose outcome sentence is longer than the limit
    // #when its head is read
    const head = headOf(renderSettlement(GENERATION, heldView()));

    // #then the description fits
    expect(content(head, 'description')?.length).toBeLessThanOrEqual(200);
  });
});

describe('the description of a verification', () => {
  it('leads with the classification', () => {
    // #given a verification with a classification
    // #when its head is read
    const head = headOf(renderVerification(GENERATION, SETTLEMENT_ID, verification()));

    // #then the description begins with it
    expect(content(head, 'description')).toMatch(new RegExp(`^${CLASSIFICATION}`));
  });

  it('follows the classification with its meaning', () => {
    // #given a classification the product has a sentence for
    const meaning = CLASS_MEANING[CLASSIFICATION] ?? '';

    // #when the head is read
    const head = headOf(renderVerification(GENERATION, SETTLEMENT_ID, verification()));

    // #then the sentence follows a colon and a space
    expect(content(head, 'description')).toContain(`${CLASSIFICATION}: ${meaning}`);
  });

  it('says how many of the checks passed', () => {
    // #given a verification with three findings, two of which passed
    // #when its head is read
    const head = headOf(renderVerification(GENERATION, SETTLEMENT_ID, verification()));

    // #then the count closes the description
    expect(content(head, 'description')).toMatch(/ 2 of 3 checks passed\.$/);
  });

  it('leaves the count out when there were no findings', () => {
    // #given a verification with no findings
    // #when its head is read
    const head = headOf(
      renderVerification(GENERATION, SETTLEMENT_ID, verification({ findings: [] })),
    );

    // #then the description stops after the meaning
    expect(content(head, 'description')).toBe(
      `${CLASSIFICATION}: ${CLASS_MEANING[CLASSIFICATION] ?? ''}`,
    );
  });

  it('is the bare classification when the product has no sentence for it', () => {
    // #given a classification with no entry in the meanings
    const unknown = verification({ classification: 'UNSEEN_CLASSIFICATION', findings: [] });

    // #when the head is read
    const head = headOf(renderVerification(GENERATION, SETTLEMENT_ID, unknown));

    // #then only the classification is written
    expect(content(head, 'description')).toBe('UNSEEN_CLASSIFICATION');
  });

  it('gives no verdict when part of the history could not be read', () => {
    // #given a run with a scan gap, which the page itself refuses to classify
    const incomplete = verification({ hadScanGap: true });

    // #when the head is read
    const head = headOf(renderVerification(GENERATION, SETTLEMENT_ID, incomplete));

    // #then the classification is withheld
    expect(content(head, 'description')).not.toContain(CLASSIFICATION);
  });

  it('says the run is incomplete when part of the history could not be read', () => {
    // #given a run with a scan gap
    const incomplete = verification({ hadScanGap: true });

    // #when the head is read
    const head = headOf(renderVerification(GENERATION, SETTLEMENT_ID, incomplete));

    // #then the description states that
    expect(content(head, 'description')).toMatch(/^Incomplete: /);
  });
});

describe('an evidence page with nothing recorded', () => {
  const head = (): string => headOf(renderEvidence(GENERATION, SETTLEMENT_ID, []));

  it('asks search engines to leave it out of the index', () => {
    // #given an id that reaches the route but has no proof package and no indexed artifact
    // #when the head is read
    const robots = content(head(), 'robots');

    // #then it is marked noindex
    expect(robots).toBe('noindex');
  });

  it('declares no canonical address, so the id does not become one', () => {
    // #given the same page
    // #when the head is read
    const canonical = links(head(), 'canonical');

    // #then there is no canonical link
    expect(canonical).toEqual([]);
  });

  it('says that nothing is recorded, rather than that records exist', () => {
    // #given the same page
    // #when the head is read
    const description = content(head(), 'description');

    // #then the description does not claim records
    expect(description).toBe(
      'Nothing is recorded for this settlement in this build. That is not a statement about the chains.',
    );
  });
});

describe('the description of an evidence page', () => {
  const describedBy = (summary: string): string | undefined =>
    content(headOf(renderEvidence(GENERATION, SETTLEMENT_ID, [], proof(summary))), 'description');

  it('is the summary of the proof package', () => {
    // #given a proof package with a short summary
    const summary = 'Both legs delivered on the deployed contracts.';

    // #when the head is read
    const description = describedBy(summary);

    // #then the summary is the description
    expect(description).toBe(summary);
  });

  it('says what the page records when only indexed artifacts exist', () => {
    // #given a settlement with an indexed artifact and no proof package
    // #when its head is read
    const head = headOf(renderEvidence(GENERATION, SETTLEMENT_ID, [INDEXED_ARTIFACT]));

    // #then the description is the generic sentence
    expect(content(head, 'description')).toBe(
      'Transactions, messages and verifier runs recorded for this settlement.',
    );
  });

  it('turns a dash between clauses into a comma', () => {
    // #given a summary with a spaced dash
    const summary = 'Cash moved first \u2014 then the asset moved.';

    // #when the head is read
    const description = describedBy(summary);

    // #then the clauses are joined by a comma
    expect(description).toBe('Cash moved first, then the asset moved.');
  });

  it('collapses runs of whitespace to single spaces', () => {
    // #given a summary with a newline, a tab and doubled spaces
    const summary = 'Cash  moved first.\n\tThen the asset moved.';

    // #when the head is read
    const description = describedBy(summary);

    // #then the description reads on one line
    expect(description).toBe('Cash moved first. Then the asset moved.');
  });

  it('leaves a summary of exactly 200 characters alone', () => {
    // #given a summary at the limit
    const summary = `${'ab '.repeat(66)}ab`;

    // #when the head is read
    const description = describedBy(summary);

    // #then nothing is cut
    expect(description).toBe(summary);
  });

  it('backs up to the last whole word when the limit falls inside one', () => {
    // #given forty words of six letters, where the 200th character is mid-word
    const summary = Array.from({ length: 40 }, () => 'abcdef').join(' ');

    // #when the head is read
    const description = describedBy(summary);

    // #then the cut keeps the 28 words that fit, and the ellipsis
    expect(description).toBe(`${Array.from({ length: 28 }, () => 'abcdef').join(' ')}…`);
  });

  it('keeps the last word when it ends exactly where the ellipsis fits', () => {
    // #given words whose 199th character is the last letter of a word
    const summary = 'word '.repeat(60).trim();

    // #when the head is read
    const description = describedBy(summary);

    // #then that word is kept and the description is exactly 200 characters
    expect(description).toBe(`${'word '.repeat(39)}word…`);
  });

  it('cuts a summary with no spaces at the limit', () => {
    // #given one unbroken token longer than the limit
    const summary = 'x'.repeat(300);

    // #when the head is read
    const description = describedBy(summary);

    // #then it is cut hard, leaving room for the ellipsis
    expect(description).toBe(`${'x'.repeat(199)}…`);
  });
});

describe('a settlement id that tries to break out of the head', () => {
  const HOSTILE_ID = '0xab"><script>alert(1)</script>';

  const PAGES_WITH_AN_ID: readonly [string, () => string, string][] = [
    [
      'renderSettlement',
      () => renderSettlement(GENERATION, view({ settlementId: HOSTILE_ID })),
      `/app/settlements/${HOSTILE_ID}`,
    ],
    [
      'renderSignRequest',
      () => renderSignRequest(GENERATION, HOSTILE_ID, SIGN_REQUEST),
      `/app/settlements/${HOSTILE_ID}/sign`,
    ],
    [
      'renderVerification',
      () => renderVerification(GENERATION, HOSTILE_ID, verification()),
      `/verify/${HOSTILE_ID}`,
    ],
    [
      'renderEvidence',
      () => renderEvidence(GENERATION, HOSTILE_ID, [], proof()),
      `/evidence/${HOSTILE_ID}`,
    ],
  ];

  it.each(PAGES_WITH_AN_ID)('stays inside the attributes of %s', (_name, render, path) => {
    // #given an id with a double quote and an angle bracket in it
    // #when the page is rendered and its head read
    const head = headOf(render());

    // #then the canonical address holds the whole id as one value, and no script was opened
    expect({
      canonical: links(head, 'canonical').map((tag) => tag['href']),
      scripts: head.match(/<script/gi)?.length ?? 0,
    }).toEqual({ canonical: [`${SITE}${path}`], scripts: 0 });
  });
});

describe('the document around the head', () => {
  const system = (): string =>
    renderSystem(GENERATION, { deploymentId: 'gen3', commit: 'abc1234' });

  it('keeps the character set, viewport and colour scheme declarations', () => {
    // #given any page
    // #when its head is read
    const head = headOf(system());

    // #then the three declarations are still there
    expect([
      tags(head).find((tag) => tag['charset'] !== undefined)?.['charset'],
      content(head, 'viewport'),
      content(head, 'color-scheme'),
    ]).toEqual(['utf-8', 'width=device-width,initial-scale=1', 'light']);
  });

  it('keeps the stylesheet inline in the head', () => {
    // #given any page
    // #when the document is split at the end of the head
    const [beforeBody] = system().split('</head>');

    // #then the stylesheet is on the head's side of the split
    expect(beforeBody).toContain('<style>');
  });

  it('ends the body with the client script', () => {
    // #given any page
    // #when the document is rendered
    const html = system();

    // #then the module script closes the body
    expect(html).toMatch(/<script type="module" src="[^"]+" defer><\/script><\/body><\/html>$/);
  });

  it('carries the deployment on the body when one is set', () => {
    // #given a deployment
    setDeployment({ coordinator: ADDRESS });

    // #when a page is rendered
    const html = system();

    // #then the body holds it as an escaped attribute
    expect(html).toContain(
      `<body data-conduit="{&quot;coordinator&quot;:&quot;${ADDRESS}&quot;}">`,
    );
  });

  it('keeps the hero preload in the landing head', () => {
    // #given the landing page
    // #when its head is read
    const head = headOf(renderLanding(TOTALS, []));

    // #then the preload link survives beside the head builder's tags
    expect(links(head, 'preload').map((tag) => tag['as'])).toEqual(['image']);
  });
});

describe('the deployments page layout', () => {
  const ROW: DeploymentView = {
    deploymentId: `0x${'cd'.repeat(32)}`,
    generation: 1,
    gitCommit: 'a2caa43a016f9c1f01a1b2194a4ae2b0f752c797',
    solcVersion: '0.8.36',
    supersededBy: undefined,
    contracts: [{ role: 'CashEscrow', address: ADDRESS, chainId: 10143 }],
  };

  it('keeps the intro card and the generation cards in one stack, so they are spaced alike', () => {
    // #given the page with one generation
    const html = renderDeployments(GENERATION, [ROW]);

    // #when the positions of the stack, the intro and the first generation are found
    const stack = html.indexOf('<div class="stack-16">');
    const intro = html.indexOf('Checking these yourself');
    const generation = html.indexOf('Generation 1');

    // #then the stack opens before the intro, and the intro comes before the generation
    expect(stack !== -1 && stack < intro && intro < generation).toBe(true);
  });

  it('groups the label, the paragraph and the links in the intro card so they are not run together', () => {
    // #given the page
    const html = renderDeployments(GENERATION, [ROW]);

    // #when the start of the intro card's content is read
    const start = html.indexOf('Checking these yourself');

    // #then its label is the first child of a stack
    expect(html.slice(start - 60, start)).toContain('<div class="stack-12">');
  });
});

describe('the landing page when the live counts could not be read', () => {
  const SENTENCE =
    'Live counts are unavailable right now, and the recorded proof below does not depend on them.';

  const bodyOf = (html: string): string => html.slice(html.indexOf('</head>'));

  const statLabels = (html: string): readonly string[] =>
    [...bodyOf(html).matchAll(/<div class="stat-label">([^<]*)<\/div>/g)].map(
      (match) => match[1] ?? '',
    );

  /** Everything the figures do not own: the page before the proof heading, and the records on. */
  const aroundTheFigures = (html: string): readonly [string, string] => [
    html.slice(0, html.indexOf('This is not an architecture diagram.</h2>')),
    html.slice(html.indexOf('<div class="records">')),
  ];

  it('shows the four figures when the counts were read', () => {
    // #given the landing rendered with counts
    // #when the labels of its statistics are read
    const labels = statLabels(renderLanding(TOTALS, []));

    // #then all four are there, so the test below cannot pass by finding nothing
    expect(labels).toEqual(['Settlements', 'Messages', 'Verifications', 'Generations']);
  });

  it('shows no statistic label when the counts could not be read', () => {
    // #given the landing rendered without counts
    // #when the labels of its statistics are read
    const labels = statLabels(renderLanding(undefined, []));

    // #then there are none
    expect(labels).toEqual([]);
  });

  it('prints no value in a statistic, so no zero can pass for a count', () => {
    // #given the landing rendered without counts
    // #when the page after the head is searched for a statistic value
    const values = bodyOf(renderLanding(undefined, [])).match(/class="stat-value"/g);

    // #then there is not one
    expect(values).toBeNull();
  });

  it('says the live counts are unavailable and that the recorded proof does not depend on them', () => {
    // #given the landing rendered without counts
    // #when the page after the head is read
    const body = bodyOf(renderLanding(undefined, []));

    // #then the one sentence is there
    expect(body).toContain(SENTENCE);
  });

  it('says it once', () => {
    // #given the landing rendered without counts
    // #when the occurrences of the sentence are counted
    const occurrences = bodyOf(renderLanding(undefined, [])).split(SENTENCE).length - 1;

    // #then it appears a single time
    expect(occurrences).toBe(1);
  });

  it('does not say it when the counts were read', () => {
    // #given the landing rendered with counts
    // #when the page after the head is read
    const body = bodyOf(renderLanding(TOTALS, []));

    // #then there is nothing to apologise for
    expect(body).not.toContain('Live counts are unavailable');
  });

  it('changes nothing on the page except the figures', () => {
    // #given the same settlement featured, with and without counts
    const withCounts = renderLanding(TOTALS, [view()]);
    const withoutCounts = renderLanding(undefined, [view()]);

    // #when the page is read on either side of the figures
    const degraded = aroundTheFigures(withoutCounts);
    const healthy = aroundTheFigures(withCounts);

    // #then it is the same
    expect(degraded).toEqual(healthy);
  });
});

describe('the words on the overview page', () => {
  it('calls the networks testnets where a visitor reads them, not only in the head', () => {
    // #given the overview rendered with no settlements
    const html = renderOverview(GENERATION, TOTALS, []);

    // #when the page after the head is read
    const body = html.slice(html.indexOf('</head>'));

    // #then the caption says which networks these are
    expect(body).toContain('Monad Testnet and Base Sepolia');
  });
});

describe('the onboarding host of the overview', () => {
  it('still names the featured settlement when the visitor has been welcomed', () => {
    // #given a welcomed visitor and a settlement to feature
    const html = renderOverview(GENERATION, TOTALS, [view()], true);

    // #then the host carries it without the reserve class, for the card a later disconnect may show
    expect(html).toContain(`<div data-onboarding data-featured="${SETTLEMENT_ID}">`);
  });

  it('names the featured settlement on the reserved host too', () => {
    // #given a visitor not yet welcomed and a settlement to feature
    const html = renderOverview(GENERATION, TOTALS, [view()], false);

    // #then the reserved host carries it
    expect(html).toContain(
      `<div class="reserve" data-onboarding data-featured="${SETTLEMENT_ID}">`,
    );
  });
});
