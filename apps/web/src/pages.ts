/**
 * Pages. Layout and information architecture only — every visual decision is
 * already made in `theme.ts`, `ui.ts` and `components.ts`.
 *
 * No page here writes a colour, a radius or a font size. If something looks
 * wrong, it is wrong in the system and gets fixed there.
 */

import {
  complianceTimeline,
  conservationBreakdown,
  crossChainDiagram,
  dispositionCase,
  evidenceTimeline,
  heroArtwork,
  heroPreload,
  messageRoute,
  settlementLegCard,
  settlementTimeline,
  sidebar,
  stateExplainer,
  topBar,
  verifierChecklist,
  wordmark,
} from './components.js';
import {
  CLASS_MEANING,
  STATE_MEANING,
  chainName,
  describeOutcome,
  type DeploymentView,
  type SettlementView,
} from './domain.js';
import type { DispositionRow, Totals, VerificationResult } from './data.js';
import {
  address,
  badge,
  breadcrumb,
  button,
  card,
  cardWithHeader,
  chainIdentity,
  emptyState,
  errorState,
  esc,
  external,
  icon,
  input,
  pageHeader,
  sectionHeader,
  settlementLink,
  deploymentLink,
  stateBadge,
  statBlock,
  truncate,
  txHash,
} from './ui.js';
import {
  DISPOSITION_HISTORY,
  MANIFESTS,
  PROOF_PACKAGES,
  VERIFICATIONS,
  type ProofArtifact,
  type ProofPackage,
} from './evidence.js';
import { CLIENT_PATH } from './client-manifest.js';
import { headTags, type PageMeta } from './head.js';
import { RESERVE_RELEASE, STYLESHEET } from './theme.js';
import { RESERVE_CLASS } from './welcome.js';

interface DocumentOptions {
  readonly head?: string;
}

/** The document. One stylesheet, inline, because the CSP forbids external origins. */
function document_(page: PageMeta, body: string, options: DocumentOptions = {}): string {
  const script = `<script type="module" src="${esc(CLIENT_PATH)}" defer></script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
${headTags(page)}${options.head ?? ''}<style>${STYLESHEET}</style></head>
<body${CONDUIT === undefined ? '' : ` data-conduit="${esc(JSON.stringify(CONDUIT))}"`}><a class="skip-link" href="#content">Skip to content</a>${body}${script}</body></html>`;
}

const DESCRIPTION_LIMIT = 200;

/**
 * A description built from data, cut on a word boundary to at most 200 characters.
 *
 * The tag is shown out of context, in search results and link cards, so a cut that
 * lands mid-word or mid-number reads as a mistake. The limit includes the
 * ellipsis, which makes 200 the longest the tag can be. A dash between clauses
 * becomes a comma, because the sentences it is built from were written for a page
 * and a link card carries them with no page around them.
 */
function clipDescription(text: string): string {
  const flat = text.replace(/\s+/g, ' ').replace(/ ?— ?/g, ', ').trim();
  if (flat.length <= DESCRIPTION_LIMIT) return flat;

  const fits = flat.slice(0, DESCRIPTION_LIMIT - 1);
  const endsOnWord = flat[DESCRIPTION_LIMIT - 1] === ' ';
  const lastSpace = fits.lastIndexOf(' ');
  const end = endsOnWord || lastSpace === -1 ? fits.length : lastSpace;
  return `${fits.slice(0, end)}…`;
}

/**
 * The deployment, rendered into every page once.
 *
 * The session needs contract addresses to read balances, and it needs them on
 * routes that have no composer and no workspace. Putting it on the body means
 * one place rather than a per-page payload each script has to find.
 */
let CONDUIT: Record<string, string> | undefined;

export function setDeployment(deployment: Record<string, string> | undefined): void {
  CONDUIT = deployment;
}

/**
 * The application shell: sidebar, top bar, content column.
 *
 * The sidebar footer and the top bar's participant slot hold space for what the browser
 * script adds, on every page, so the release for a visitor without scripting ships here too.
 */
function shell(options: {
  readonly title: string;
  readonly description?: string;
  readonly path?: string;
  readonly current: string;
  readonly generation: string;
  readonly body: string;
  readonly topRight?: string;
}): string {
  return document_(
    {
      title: options.title,
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.path === undefined ? {} : { path: options.path }),
    },
    `<div class="shell">${sidebar(options.current)}
<div class="main">${topBar(options.topRight ?? '')}<main class="content" id="content" tabindex="-1">${options.body}</main></div></div>`,
    { head: `<noscript><style>${RESERVE_RELEASE}</style></noscript>` },
  );
}

// ── Landing ─────────────────────────────────────────────────────────────────

/**
 * The hero relies on the 48px display size and short copy. `design.md` caps the
 * scale there, so there is no 64–96px headline and no decorative artwork — the
 * product composition underneath is the visual content.
 */
export function renderLanding(
  totals: Totals | undefined,
  recent: readonly SettlementView[],
): string {
  const sample = recent[0];
  const proofs = PROOF_PACKAGES.filter((proof) => proof.generation === 3);
  const watchHref =
    sample === undefined ? '/app/settlements' : `/app/settlements/${sample.settlementId}`;
  const verifyHref = sample === undefined ? '/app/verifier' : `/verify/${sample.settlementId}`;

  return document_(
    {
      title: 'Conduit',
      documentTitle: 'Conduit: cross-chain delivery versus payment',
      description:
        'Settle a restricted asset on one chain against verified cash on another under one signed intent. Nothing is bridged, and anyone can verify it from the chains.',
      path: '/',
    },
    `<div class="landing">
${landingNav()}

<main id="content" tabindex="-1"><header class="hero" id="top">
  <div class="hero-copy">
    <h1 class="t-display">Trade a restricted asset on one chain against cash on another.</h1>
    <p>Conduit settles both legs under one signed intent. Nothing is bridged or wrapped, and the trade only becomes irreversible after both chains agree and Cleanverse confirms both parties are still eligible.</p>
    <p class="audience">For brokers, issuers and treasuries that settle verified cash against transfer-restricted assets.</p>
    <div class="actions">${button({ label: 'Watch a real settlement', href: watchHref, iconName: 'arrowRight' })}${button({ label: 'Verify it yourself', href: verifyHref, variant: 'outline' })}</div>
  </div>
  <div class="hero-mech">
    ${heroArtwork()}
    <div class="hero-mech-labels">
      <div><div class="rail-label">Monad Testnet</div><div class="mono t-caption">Verified cash</div></div>
      <div class="hero-mech-centre"><span class="mech-state">COMMIT</span></div>
      <div style="text-align:right"><div class="rail-label">Base Sepolia</div><div class="mono t-caption">Restricted asset</div></div>
    </div>
    <p class="t-caption muted" style="margin-top:var(--spacing-12)">Assets stay put. Settlement state crosses.</p>
    ${heroProof(sample)}
  </div>
</header>

${problemSection()}

${mechanismSection(sample)}

${hardCaseSection()}

${proofSection(totals, proofs)}

${cleanverseSection()}

${wormholeSection()}

${useCaseSection()}

${closingSection()}</main>

${landingFooter()}
</div>`,
    { head: heroPreload() },
  );
}

/** Wordmark, the three places worth jumping to, and the two things to do. */
function landingNav(): string {
  const links = [
    ['#mechanism', 'How it works'],
    ['#proof', 'Live proof'],
    ['#cleanverse', 'Compliance'],
  ]
    .map(([href, label]) => `<a href="${esc(href ?? '')}">${esc(label ?? '')}</a>`)
    .join('');

  return `<nav class="landing-nav">${wordmark()}
<div class="navlinks">${links}</div>
<div class="row">${button({ label: 'Open the console', href: '/app', small: true })}</div>
</nav>`;
}

/**
 * A real settlement, stated as a fact under the artwork.
 *
 * The numbers come from the indexed settlement and its verifier run, never from
 * copy. With no settlement indexed there is nothing true to say, so it says
 * nothing rather than an example.
 */
function heroProof(sample: SettlementView | undefined): string {
  if (sample?.termsKnown !== true) return '';
  const run = PROOF_PACKAGES.find((proof) => proof.settlementId === sample.settlementId);
  const checks =
    run?.verification === undefined
      ? ''
      : `, ${String(run.verification.passed)} of ${String(run.verification.total)} independent checks passed`;
  return `<a class="hero-proof" href="/app/settlements/${esc(sample.settlementId)}">
  <div>
    <div class="hero-proof-trade">${esc(sample.cash.amount)} ${esc(sample.cash.assetSymbol)} on ${esc(chainName(sample.cash.chainId))} for ${esc(sample.asset.amount)} ${esc(sample.asset.assetSymbol)} on ${esc(chainName(sample.asset.chainId))}</div>
    <div class="hero-proof-meta">A real settlement on the deployed contracts: ${esc(sample.verifierClass ?? sample.canonicalState)}${esc(checks)}.</div>
  </div>
  ${stateBadge(sample.canonicalState)}
</a>`;
}

/**
 * The tension, as one picture rather than two paragraphs in boxes.
 *
 * The rail widths are the real observed Base range and the caption names both
 * ends of it. Averaging 999 and 1485 would produce a number nobody measured and
 * would hide the slow end, which is the end a commit window has to survive.
 */
function problemSection(): string {
  return `<section class="landing-section section-lg reveal" id="problem">
  <div class="eyebrow">The problem</div>
  <h2 class="t-heading-lg statement-wide">Settlement does not become difficult because there are two ledgers. It becomes difficult because they do not become final at the same time.</h2>

  <div class="rails">
    <div class="rail">
      <div class="rail-label">Base Sepolia</div>
      <div class="rail-track">
        <span class="rail-span" style="left:4%;width:62%"></span>
        <span class="rail-mark" style="left:4%"><span class="rail-dot solid"></span></span>
        <span class="rail-tag start" style="left:4%">asset prepared</span>
        <span class="rail-mark" style="left:66%"><span class="rail-dot solid"></span></span>
        <span class="rail-tag end" style="left:66%">finalized</span>
        <span class="rail-gap" style="left:4%;width:62%"><span class="rail-gap-label">999–1485 seconds observed</span></span>
      </div>
    </div>
    <div class="rail">
      <div class="rail-label">Monad Testnet</div>
      <div class="rail-track">
        <span class="rail-span" style="left:14%;width:52%"></span>
        <span class="rail-mark" style="left:14%"><span class="rail-dot solid"></span></span>
        <span class="rail-tag start" style="left:14%">cash escrowed</span>
        <span class="rail-mark" style="left:66%"><span class="rail-dot solid"></span></span>
        <span class="rail-tag end" style="left:66%">COMMIT</span>
      </div>
    </div>
  </div>

  <div class="split rule-top" style="margin-top:var(--spacing-48)">
    <h3 class="t-heading-sm">And eligibility can change inside that gap.</h3>
    <div>
      <div class="rail">
        <div class="rail-label">The receiver</div>
        <div class="rail-track">
          <span class="rail-span" style="left:6%;width:82%"></span>
          <span class="rail-mark" style="left:6%"><span class="rail-dot solid"></span></span>
          <span class="rail-tag above start mono" style="left:6%">ELIGIBLE</span>
          <span class="rail-tag start" style="left:6%">prepare</span>
          <span class="rail-mark" style="left:47%"><span class="rail-dot solid"></span></span>
          <span class="rail-tag above mono" style="left:47%">ELIGIBLE</span>
          <span class="rail-tag" style="left:47%">COMMIT</span>
          <span class="rail-mark" style="left:88%"><span class="rail-dot"></span></span>
          <span class="rail-tag above end mono" style="left:88%">TIER_TOO_LOW</span>
          <span class="rail-tag end" style="left:88%">delivery</span>
        </div>
      </div>
      <p class="lede" style="margin-top:var(--spacing-48)">Whoever moves first is exposed to a rule that has not been applied yet. Bridging solves neither half: it replaces a settlement problem with a custody problem and a wrapped supply to attack. Conduit bridges nothing.</p>
    </div>
  </div>
</section>`;
}

/**
 * The mechanism, told by holding the two chains still.
 *
 * The modules are sticky and the stages scroll past them, because the claim
 * being made is that nothing moves between the chains — a section where the
 * chain columns stayed on screen and only the middle changed is that claim,
 * drawn. With no JavaScript every stage simply reads as current, which is a
 * complete and honest fallback rather than a blank column.
 */
function mechanismSection(sample: SettlementView | undefined): string {
  const stages: readonly {
    index: string;
    title: string;
    detail: string;
    state: string;
    cash: string;
    asset: string;
  }[] = [
    {
      index: '01',
      title: 'Prepare',
      detail:
        'Base reserves the restricted RWA against this settlement id. Monad moves the settlement value into escrow. Both are sent by the participants’ own wallets.',
      state: 'PREPARED',
      cash: 'ESCROWED',
      asset: 'RESERVED',
    },
    {
      index: '02',
      title: 'Finalize',
      detail:
        'Each preparation publishes an authenticated message. Conduit waits for the guardian set to sign it at the finality this deployment requires, which on Base has run 999–1485 seconds.',
      state: 'FINALIZED',
      cash: 'ESCROWED',
      asset: 'RESERVED',
    },
    {
      index: '03',
      title: 'Recheck',
      detail:
        'Cleanverse is asked again, after the wait, with no application cache in the path. The answer at prepare time is too old to authorise anything by the time finality arrives.',
      state: 'ELIGIBLE',
      cash: 'ESCROWED',
      asset: 'RESERVED',
    },
    {
      index: '04',
      title: 'Commit',
      detail:
        'One irreversible decision, taken on the coordinator and carried to the other chain as an authenticated message. After this point there is no refund.',
      state: 'COMMIT',
      cash: 'COMMITTED',
      asset: 'COMMITTED',
    },
    {
      index: '05',
      title: 'Deliver',
      detail:
        'Each leg moves locally, on the chain that issued it, to the party the signed intent named. Anyone may relay the message that authorises it.',
      state: 'RELEASED',
      cash: 'RELEASED',
      asset: 'RELEASED',
    },
  ];

  const cash = sample?.cash;
  const asset = sample?.asset;

  return `<section class="landing-section section-lg" id="mechanism">
  <div class="eyebrow">How Conduit settles</div>
  <h2 class="t-heading-lg statement">One intent, two chains, five states.</h2>

  <div class="mech" data-mech>
    <div class="mech-visual">
      <div class="mech-stage">
        <div class="mech-side">
          <div class="t-caption-upper">Monad Testnet</div>
          <div class="mech-amount">${esc(cash?.amount ?? '25.000000')}</div>
          <div class="muted t-caption mono">${esc(cash?.assetSymbol ?? 'cSETTLE')}</div>
          <div class="mech-legstate" data-mech-cash>ESCROWED</div>
        </div>
        <div class="mech-centre">
          <span class="mech-wire"></span>
          <span class="mech-state" data-mech-state>PREPARED</span>
          <span class="mech-wire"></span>
        </div>
        <div class="mech-side" style="text-align:right">
          <div class="t-caption-upper">Base Sepolia</div>
          <div class="mech-amount">${esc(asset?.amount ?? '0.500000')}</div>
          <div class="muted t-caption mono">${esc(asset?.assetSymbol ?? 'cBOND')}</div>
          <div class="mech-legstate" data-mech-asset>RESERVED</div>
        </div>
      </div>
      <p class="t-caption muted" style="margin-top:var(--spacing-12)">Neither module moves. Only the state between them does.</p>
    </div>

    <div class="mech-steps">
      ${stages
        .map(
          (
            stage,
          ) => `<div class="mech-step" data-mech-step data-state="${esc(stage.state)}" data-cash="${esc(stage.cash)}" data-asset="${esc(stage.asset)}"${stage.index === '01' ? ' data-current' : ''}>
  <div class="index">${esc(stage.index)}</div>
  <h3>${esc(stage.title)}</h3>
  <p>${esc(stage.detail)}</p>
</div>`,
        )
        .join('')}
    </div>
  </div>
</section>`;
}

/**
 * The part that is hard, given the weight it earns.
 *
 * Every state below is one a live settlement actually reached; the sequence is
 * `docs/evidence/phase-07-compliance-change-0xdcb9db12.json` in order.
 */
function hardCaseSection(): string {
  const rows: readonly { state: string; detail: string; boundary?: boolean }[] = [
    {
      state: 'ELIGIBLE',
      detail:
        'Cleanverse is asked again after finality and clears both participants. Nothing about the settlement is irreversible yet.',
    },
    {
      state: 'COMMIT',
      detail:
        'The coordinator records the decision and publishes it. From here the settlement can only complete or hold — there is no path back.',
      boundary: true,
    },
    {
      state: 'RULEV2 CHANGED',
      detail:
        'The issuer raises the minimum tier on the asset’s transfer rule while the settlement is in flight. This is a real transaction on Base, not a simulation.',
    },
    {
      state: 'TIER_TOO_LOW',
      detail:
        'The asset consults its own policy at the moment of transfer and refuses the receiver. The token enforces this, not Conduit.',
    },
    {
      state: 'HELD',
      detail:
        'The cash leg has already released and is not refundable. The asset leg is held rather than reverted: the commitment stands and the value stays accounted for.',
    },
    {
      state: 'AUTHORIZED DISPOSITION',
      detail:
        'A registered authority files an order under a policy that permits its class. It rests for the contest window before anything can execute.',
    },
    {
      state: 'SETTLED_FINAL',
      detail:
        'Terminal, and derived by a verifier that reads both chains and the guardian set with no help from this server.',
    },
  ];

  return `<section class="landing-section section-lg" id="hard-case">
  <div class="eyebrow">The hard case</div>
  <h2 class="t-heading-lg statement">What happens when compliance changes after COMMIT?</h2>
  <p class="lede" style="margin-top:var(--spacing-16)">Most systems have no answer, because they assume eligibility is a property rather than an answer with a timestamp. This is the sequence a live settlement on the deployed protocol actually walked.</p>

  <div class="staterail">
    ${rows
      .map((row) => {
        const boundary =
          row.boundary === true
            ? `<div class="boundary"><span>Irreversible from here</span></div>`
            : '';
        return `<div class="staterail-row reveal" data-rail-row>
  <div class="staterail-state"><span class="staterail-node"></span><span class="staterail-name">${esc(row.state)}</span></div>
  <p>${esc(row.detail)}</p>
</div>${boundary}`;
      })
      .join('')}
  </div>

  <div class="ledger">
    <div><div class="k">Cash leg</div><div class="v">RELEASED</div></div>
    <div><div class="k">Asset leg</div><div class="v">HELD</div></div>
    <div><div class="k">Refund</div><div class="v">NOT PERMITTED</div></div>
  </div>

  <div class="row" style="margin-top:var(--spacing-24);flex-wrap:wrap">${button({ label: 'Inspect the settlement', href: '/app/settlements/0xc113ad335d202d985d527b0a193498ef2ecceb9a129a58c5002943c88601a3b0', iconName: 'arrowRight', small: true })}${button({ label: 'The disposition case', href: '/app/dispositions', variant: 'outline', small: true })}</div>
</section>`;
}

/**
 * Proof, early, and shaped like a record rather than a card of adjectives.
 *
 * The counts are the only part that comes from the database. The records below them are
 * the run artifacts compiled into this build, so they render the same with no counts.
 * When the counts could not be read the section says so in one sentence and shows no
 * figure: a zero is a number, and a reader will believe it.
 */
function proofSection(totals: Totals | undefined, proofs: readonly ProofPackage[]): string {
  const counts =
    totals === undefined
      ? '<p class="t-caption muted" style="margin-top:var(--spacing-48)">Live counts are unavailable right now, and the recorded proof below does not depend on them.</p>'
      : `<div class="grid-4" style="margin-top:var(--spacing-48)">
    ${statBlock({ label: 'Settlements', value: String(totals.settlements), note: 'indexed and verified', small: true })}
    ${statBlock({ label: 'Messages', value: String(totals.messages), note: 'authenticated, consumed once', small: true })}
    ${statBlock({ label: 'Verifications', value: String(totals.verifications), note: 'derived from chains alone', small: true })}
    ${statBlock({ label: 'Generations', value: String(totals.generations), note: 'deployed, each verifiable', small: true })}
  </div>`;

  return `<section class="landing-section section-lg reveal" id="proof">
  <div class="eyebrow">Proven live</div>
  <h2 class="t-heading-lg statement">This is not an architecture diagram.</h2>

  ${counts}

  <div class="records">
    ${proofs
      .map((proof) => {
        const facts: readonly [string, string][] = [
          ['Settlement', settlementLink(proof.settlementId)],
          ['Generation', deploymentLink(String(proof.generation))],
          ['Canonical state', esc(proof.verification?.canonicalState ?? 'not verified')],
          ['Verifier', esc(proof.verification?.classification ?? 'no run')],
          [
            'Checks',
            proof.verification === undefined
              ? '—'
              : `${String(proof.verification.passed)} / ${String(proof.verification.total)}`,
          ],
          ['Networks', 'Monad ↔ Base'],
        ];
        return `<div class="record">
  <div>
    <h3>${esc(proof.title)}</h3>
    <p>${esc(proof.summary)}</p>
    <div class="row" style="margin-top:var(--spacing-16);flex-wrap:wrap">${button({ label: 'View settlement', href: `/app/settlements/${proof.settlementId}`, variant: 'outline', small: true })}${button({ label: 'Evidence', href: `/evidence/${proof.settlementId}`, variant: 'outline', small: true })}${button({ label: 'Verify independently', href: `/verify/${proof.settlementId}`, small: true })}</div>
  </div>
  <div class="record-facts">
    ${facts
      .map(
        ([key, value]) =>
          `<div class="record-fact"><span class="k">${esc(key)}</span><span class="v">${value}</span></div>`,
      )
      .join('')}
  </div>
</div>`;
      })
      .join('')}
  </div>
</section>`;
}

/** Cleanverse as a causal chain, because that is what it is in the code. */
function cleanverseSection(): string {
  const steps: readonly [string, string, string][] = [
    [
      'Who may participate',
      'CVI',
      'Cleanverse identity. Whether a participant holds a pass at all, and whether it currently permits transfer on this chain.',
    ],
    [
      'What may move',
      'CVA',
      'A compliant asset. The token consults its policy on every transfer, so eligibility is enforced by the asset rather than by an application in front of it.',
    ],
    [
      'Under which rules',
      'RuleV2',
      'The transfer rule the issuer controls, on chain. It can change after a settlement commits, and on this deployment it did.',
    ],
    [
      'When settlement may become irreversible',
      'Fresh compliance',
      'Conduit asks again after finality and mints an attestation with a lifetime shorter than the wait that produced it. A stale answer cannot authorise a COMMIT.',
    ],
  ];

  return `<section class="landing-section section-lg reveal" id="cleanverse">
  <div class="eyebrow">Compliance</div>
  <h2 class="t-heading-lg statement">Cleanverse is not metadata attached to Conduit. It decides whether settlement may advance.</h2>

  <div class="chain-steps">
    ${steps
      .map(
        ([question, answer, detail]) => `<div class="chain-step">
  <div><div class="chain-q">${esc(question)}</div><div class="chain-a">${esc(answer)}</div></div>
  <p>${esc(detail)}</p>
</div>`,
      )
      .join('')}
  </div>

  <p class="lede" style="margin-top:var(--spacing-24)">An HTTP 200 is not a business success, a <span class="mono">valid:false</span> is a refusal rather than an outage, and an outage is the absence of a decision — never a no. The console reports the answer it received, verbatim.</p>
</section>`;
}

/** The message rail. Two anchored columns, and nothing crossing between them. */
function wormholeSection(): string {
  const messages: readonly [string, string][] = [
    ['ASSET_PREPARED', 'Base → Monad'],
    ['CASH_PREPARED', 'Monad → Base'],
    ['COMMIT', 'Monad → Base'],
    ['CASH_RELEASED', 'Monad → Base'],
    ['ASSET_RELEASED', 'Base → Monad'],
    ['DISPOSITION_RESOLVED', 'Base → Monad'],
  ];

  const anatomy: readonly [string, string][] = [
    ['Source chain', 'wormhole id'],
    ['Emitter', '32 bytes'],
    ['Deployment', 'generation'],
    ['Protocol version', 'pinned'],
    ['Message type', 'enumerated'],
    ['Finality', 'classified'],
    ['Settlement id', 'bound'],
    ['Consumed', 'exactly once'],
  ];

  return `<section class="landing-section section-lg" id="wormhole">
  <div class="eyebrow">Transport</div>
  <h2 class="t-heading-lg statement">Wormhole moves settlement facts, not assets.</h2>

  <div class="msgrail">
    <div class="msgrail-chain">
      <div class="t-caption-upper">Monad</div>
      <div class="asset">cSETTLE</div>
      <div class="anchored">stays here</div>
    </div>
    <div class="msgrail-list">
      ${messages
        .map(
          ([type, direction]) => `<div class="msg" data-msg>
  <span class="dir">${esc(direction.split(' ')[0] ?? '')}</span>
  <span class="type">${esc(type)}</span>
  <span class="dir">${esc(direction.split(' ')[2] ?? '')}</span>
</div>`,
        )
        .join('')}
    </div>
    <div class="msgrail-chain">
      <div class="t-caption-upper">Base</div>
      <div class="asset">cBOND</div>
      <div class="anchored">stays here</div>
    </div>
  </div>

  <div class="rule-top" style="margin-top:var(--spacing-48)">
    <div class="t-caption-upper">What is checked before a message is believed</div>
    <div class="anatomy">
      ${anatomy
        .map(
          ([key, value]) =>
            `<div><div class="k">${esc(key)}</div><div class="v">${esc(value)}</div></div>`,
        )
        .join('')}
    </div>
    <p class="lede" style="margin-top:var(--spacing-24)">Every field is verified against the guardian set before the message is consumed, and consumption is recorded before any token moves. Anyone may relay a valid message; nobody can replay one.</p>
  </div>
</section>`;
}

/** Who this is for, after the reader knows what it is. */
function useCaseSection(): string {
  const cases: readonly [string, string][] = [
    ['Tokenized bonds', 'A restricted instrument whose holder register is the transfer rule.'],
    [
      'Restricted fund units',
      'Subscription and redemption between accounts an administrator must clear.',
    ],
    [
      'Private-market securities',
      'Transfer permitted only between verified holders, checked at delivery.',
    ],
    [
      'Institutional treasury',
      'Cash on one venue, the asset on another, one obligation across both.',
    ],
  ];

  return `<section class="landing-section section-lg reveal" id="use-cases">
  <div class="eyebrow">Where it applies</div>
  <h2 class="t-heading-lg statement">Built for assets that cannot simply be sent.</h2>
  <div class="editorial">
    ${cases
      .map(([title, detail]) => `<div><h3>${esc(title)}</h3><p>${esc(detail)}</p></div>`)
      .join('')}
  </div>
</section>`;
}

/** The conclusion of the narrative, and the two honest ways in. */
function closingSection(): string {
  return `<section class="landing-section section-lg reveal" id="start">
  <h2 class="t-heading-lg statement">Settle across chains without moving the assets across them.</h2>

  <div class="paths">
    <div>
      <h3>Participate</h3>
      <p>Connect your wallet and create or join a settlement. Conduit never sees your key.</p>
      <div class="row" style="flex-wrap:wrap">${button({ label: 'Open the console', href: '/app', iconName: 'arrowRight' })}</div>
    </div>
    <div>
      <h3>Verify</h3>
      <p>Inspect a settlement from two chain RPCs and the guardian set, without trusting this application’s database.</p>
      <div class="row" style="flex-wrap:wrap">${button({ label: 'Verify a settlement', href: '/app/verifier', variant: 'outline' })}</div>
    </div>
  </div>

  <p class="t-caption muted" style="margin-top:var(--spacing-24);max-width:60ch">New wallet not eligible in the Cleanverse sandbox? That is the product working — some unknown wallets are cleared and others refused, and you will see the answer verbatim. <a class="ext" href="/app/settlements">Explore a proven settlement instead.</a></p>
</section>`;
}

/** A compact footer, plus the three words the narrative used in passing. */
function landingFooter(): string {
  const column = (title: string, links: readonly [string, string][]): string =>
    `<div><h4>${esc(title)}</h4><ul>${links
      .map(([href, label]) => `<li><a href="${esc(href)}">${esc(label)}</a></li>`)
      .join('')}</ul></div>`;

  const glossary: readonly [string, string][] = [
    ['CVA', 'A compliant token. It checks its own transfer rule every time it moves.'],
    ['CVI', 'Cleanverse identity: the pass a wallet needs to take part.'],
    ['RuleV2', 'The transfer rule an issuer sets on chain. It can change after a trade commits.'],
    ['SETTLED', STATE_MEANING['SETTLED']?.says ?? ''],
    ['SETTLED_FINAL', CLASS_MEANING['SETTLED_FINAL'] ?? ''],
    ['HELD', STATE_MEANING['HELD']?.says ?? ''],
    ['CONTESTED', STATE_MEANING['CONTESTED']?.says ?? ''],
  ];

  return `<section class="landing-section section-tight rule-top">
  <div class="t-caption-upper">Terms used on this page</div>
  <dl class="glossary">
    ${glossary
      .map(([term, says]) => `<div><dt>${esc(term)}</dt><dd>${esc(says)}</dd></div>`)
      .join('')}
  </dl>
</section>

<footer class="landing-foot">
  <div class="footer-grid">
    <div>${wordmark()}<p class="t-caption muted" style="margin-top:var(--spacing-12);max-width:34ch">Conduit holds no key that can move your value. Signatures come from your wallet; authority comes from the chains.</p></div>
    ${column('Protocol', [
      ['#mechanism', 'How it works'],
      ['/app/deployments', 'Live deployments'],
      ['/app/verifier', 'Verifier'],
      ['/app/dispositions', 'Dispositions'],
    ])}
    ${column('Developers', [
      ['https://github.com/winsznx/conduit', 'GitHub'],
      ['/app/evidence', 'Evidence'],
      ['/app/system', 'System'],
    ])}
    ${column('Networks', [
      ['https://testnet.monadexplorer.com', 'Monad Testnet'],
      ['https://sepolia.basescan.org', 'Base Sepolia'],
    ])}
  </div>
</footer>`;
}

// ── Overview ────────────────────────────────────────────────────────────────

/**
 * Two hosts here are filled by the browser script, so each holds space for what it will
 * receive and the page does not jump when the script arrives.
 *
 * The first host's space is for a welcome card a returning visitor will never see, and it
 * would be painted blank and then taken away. The script cannot prevent that: it runs after
 * the first paint, even when it is cached. Holding the paint until it has run would fix it for
 * returning visitors and make a first visit wait for the whole bundle before anything shows, and a
 * script request that hangs would leave the page blank. The server can decide before the first
 * byte, from the cookie the browser sets once a visitor has been welcomed (see `welcome.ts`),
 * because it cannot read the `localStorage` flag that records the same fact. `welcomed` omits
 * the reserve class from that host. The second host always keeps its reserve, since whether a
 * wallet will connect is unknowable before the script discovers one.
 */
export function renderOverview(
  generation: string,
  totals: Totals,
  recent: readonly SettlementView[],
  welcomed = false,
): string {
  return shell({
    title: 'Overview',
    description:
      'Settlements across Monad Testnet and Base Sepolia, read from the two chains and the guardian set. Nothing on this page moves value.',
    path: '/app',
    current: '/app',
    generation,
    topRight: button({
      label: 'New settlement',
      href: '/app/settlements/new',
      small: true,
      iconName: 'plus',
    }),
    body: `${pageHeader({
      title: 'Overview',
      caption:
        'Settlements across Monad Testnet and Base Sepolia, read from the two chains and the guardian set. Nothing on this page moves value.',
    })}
<div${welcomed ? '' : ` class="${RESERVE_CLASS}"`} data-onboarding${recent[0] === undefined ? '' : ` data-featured="${esc(recent[0].settlementId)}"`}></div>
<div class="${RESERVE_CLASS}" data-overview></div>

<section class="section">
  ${sectionHeader('Across this deployment')}
<div class="grid-4">
  ${statBlock({ label: 'Settlements', value: String(totals.settlements), small: true })}
  ${statBlock({ label: 'Held', value: String(totals.held), note: 'awaiting disposition', small: true })}
  ${statBlock({ label: 'Messages', value: String(totals.messages), small: true })}
  ${statBlock({ label: 'Verifications', value: String(totals.verifications), small: true })}
</div>
</section>

<section class="section">
  ${sectionHeader('Recent settlements', button({ label: 'All settlements', href: '/app/settlements', variant: 'outline', small: true }))}
  ${settlementTable(recent)}
</section>`,
  });
}

// ── Settlements ─────────────────────────────────────────────────────────────

/**
 * A settlement by name where the evidence index names it, by id where it does not.
 *
 * Six rows of `0x…` that all read SETTLED, SETTLED_FINAL, gen 3 give a reader no
 * way to choose between them. The landing page already knows which one is the
 * compliance-change case, and this is the same fact.
 */
function settlementName(settlementId: string): string {
  const proof = PROOF_PACKAGES.find((entry) => entry.settlementId === settlementId);
  const id = `<a class="mono" href="/app/settlements/${esc(settlementId)}">${esc(truncate(settlementId))}</a>`;
  return proof === undefined
    ? id
    : `<div style="font-weight:var(--font-weight-medium)">${esc(proof.title)}</div><div class="t-caption">${id}</div>`;
}

function settlementTable(rows: readonly SettlementView[]): string {
  if (rows.length === 0) {
    return card(
      emptyState(
        'No settlements indexed yet',
        'The indexer writes here as it reads both chains. An empty table is not proof that no settlement exists — verify an id directly against the chains.',
        button({
          label: 'Open the verifier',
          href: '/app/verifier',
          variant: 'outline',
          small: true,
        }),
      ),
    );
  }
  return card(
    `<div class="table-scroll"><table class="table table-hover">
<thead><tr><th>Settlement</th><th>Canonical state</th><th>Verifier</th><th>Generation</th><th><span class="visually-hidden">Open</span></th></tr></thead>
<tbody>${rows
      .map(
        (row) => `<tr>
<td>${settlementName(row.settlementId)}</td>
<td>${stateBadge(row.canonicalState)}</td>
<td>${row.verifierClass === undefined ? '<span class="muted t-caption">not verified</span>' : stateBadge(row.verifierClass)}</td>
<td class="muted mono">gen ${esc(row.generation)}</td>
<td style="text-align:right">${button({ label: 'Open', href: `/app/settlements/${row.settlementId}`, variant: 'outline', small: true })}</td>
</tr>`,
      )
      .join('')}</tbody></table></div>`,
    { flush: true },
  );
}

export function renderSettlements(generation: string, rows: readonly SettlementView[]): string {
  return shell({
    title: 'Settlements',
    description:
      "Every settlement the console has seen, with the coordinator's state and the verifier's classification kept separate.",
    path: '/app/settlements',
    current: '/app/settlements',
    generation,
    topRight: button({
      label: 'New settlement',
      href: '/app/settlements/new',
      small: true,
      iconName: 'plus',
    }),
    body: `${pageHeader({
      title: 'Settlements',
      trail: [{ label: 'Conduit', href: '/app' }, { label: 'Settlements' }],
      caption:
        'Every settlement the projection has seen, with the coordinator’s own state and the verifier’s independent classification kept separate.',
    })}${settlementTable(rows)}`,
  });
}

// ── Settlement composer ─────────────────────────────────────────────────────

/**
 * Composes an intent. It cannot submit one.
 *
 * This Worker holds no key and has no write path, which is a deliberate
 * property and not a gap — a read surface that could move value would be a
 * different threat model. The form produces the terms; signing and submission
 * happen where the key is.
 */
export function renderComposer(
  generation: string,
  deployment:
    | {
        deploymentId: string;
        coordinator: string;
        cashEscrow: string;
        cashAsset: string;
        rwaToken: string;
        rwaAdapter: string;
      }
    | undefined,
): string {
  const page = {
    title: 'New settlement',
    description:
      'Compose a settlement, check every participant against Cleanverse, and sign it with your own wallet. Conduit never holds your key.',
    path: '/app/settlements/new',
  } as const;

  if (deployment === undefined) {
    return shell({
      ...page,
      current: '/app/settlements/new',
      generation,
      body: `${pageHeader({ title: 'New settlement' })}${card(
        errorState(
          'This deployment is not configured to compose settlements',
          'The contract addresses are missing from the environment, so no intent could be bound to a real coordinator. Nothing is wrong with the protocol; this build cannot reach it.',
        ),
      )}`,
    });
  }

  // Three steps here, and then the settlement has an id and a workspace. The
  // stepper used to carry all seven and hide four empty sections behind them,
  // which promised a flow this page does not run: preparation, finality, commit
  // and delivery are decided from chain state, and chain state is what the
  // workspace reads. The last chip says where they happen rather than pretending
  // they happen here.
  const STEPS = ['Terms', 'Compliance', 'Signatures', 'Then: the settlement workspace'];

  return shell({
    ...page,
    current: '/app/settlements/new',
    generation,
    body: `${pageHeader({
      title: 'New settlement',
      trail: [
        { label: 'Conduit', href: '/app' },
        { label: 'Settlements', href: '/app/settlements' },
        { label: 'New' },
      ],
      caption:
        'Compose an intent, check every participant against Cleanverse, and sign it with your own wallet. Conduit never holds your key.',
    })}

<div data-composer="${esc(JSON.stringify(deployment))}">
  <div class="stepper" data-stepper>
    ${STEPS.map(
      (step, index) =>
        `<span class="step" data-step-label data-state="${index === 0 ? 'current' : 'todo'}"><span class="step-n">${String(index + 1)}</span>${esc(step)}</span>`,
    ).join('')}
  </div>

  <!-- 1. Terms -->
  <section data-step class="section" style="margin-top:var(--spacing-24)">
    ${card(`<div class="row-between" style="margin-bottom:var(--spacing-16)">
      <div>
        <label class="label t-caption-upper" for="f-role">Your role</label>
        <select class="field" id="f-role" style="max-width:280px">
          <option value="none">I am constructing terms</option>
          <option value="payer">I am the payer</option>
          <option value="seller">I am the seller</option>
          <option value="both">I am both</option>
        </select>
      </div>
      <div class="row" data-balances></div>
    </div>
    <div class="grid-2">
      <div class="stack-16">
        <div class="t-caption-upper">Cash leg — Monad Testnet</div>
        ${input({ name: 'cashAmount', label: 'Amount (cSETTLE)', placeholder: '25.000000', mono: true })}
        ${input({ name: 'cashPayer', label: 'Payer', placeholder: '0x…', mono: true })}
      </div>
      <div class="stack-16">
        <div class="t-caption-upper">Asset leg — Base Sepolia</div>
        ${input({ name: 'assetAmount', label: 'Amount (cBOND)', placeholder: '0.500000', mono: true })}
        ${input({ name: 'assetSeller', label: 'Seller', placeholder: '0x…', mono: true })}
      </div>
    </div>
    <details class="disclosure" style="margin-top:var(--spacing-16)">
      <summary class="disclosure-summary">Pay out to a different address</summary>
      <p class="muted t-caption" style="margin-bottom:var(--spacing-12)">By default the seller receives the cash and the payer receives the asset. Fill these in only when either should go to another wallet.</p>
      <div class="grid-2">
        ${input({ name: 'cashReceiver', label: 'Cash receiver', placeholder: 'Defaults to the seller', mono: true })}
        ${input({ name: 'assetReceiver', label: 'Asset receiver', placeholder: 'Defaults to the payer', mono: true })}
      </div>
    </details>
    <div class="note">Deadlines are set from the observed finality of this deployment: one hour to prepare, three to commit, four to release. A commit window shorter than Base finality would produce a settlement that cannot legally commit.</div>
    <div class="t-caption" style="color:var(--color-ember)" data-terms-error></div>
    <div class="row" style="margin-top:var(--spacing-16)">
      <button class="btn btn-primary" type="button" data-to-compliance>Check compliance</button>
    </div>`)}
  </section>

  <!-- 2. Compliance -->
  <section data-step hidden class="section" style="margin-top:var(--spacing-24)">
    ${cardWithHeader(
      'Compliance preflight',
      `<div data-matrix></div>
      <div class="note">This is a preflight. Conduit checks eligibility again after economic finality and immediately before COMMIT, because the answer is allowed to change in between — and when it does, the protocol holds the value rather than delivering it.</div>
      <div class="row" style="margin-top:var(--spacing-16)">
        <button class="btn btn-secondary" type="button" data-back-terms>Back</button>
        <button class="btn btn-primary" type="button" data-to-sign disabled>Review and sign</button>
      </div>`,
    )}
  </section>

  <!-- 3. Signature -->
  <section data-step hidden class="section" style="margin-top:var(--spacing-24)">
    ${cardWithHeader(
      'Sign the intent',
      `<div data-summary></div>
      <div class="note">This digest is the settlement id. The coordinator verifies it against the same EIP-712 domain the deployed contract computed at construction, so a signature that does not match is rejected on chain rather than accepted here.</div>
      <div class="t-caption muted" data-sign-status></div>
      <div class="row" style="margin-top:var(--spacing-16)">
        <button class="btn btn-secondary" type="button" data-back-compliance>Back</button>
        <button class="btn btn-primary" type="button" data-sign>Sign with my wallet</button>
      </div>
      <div class="stack-12" style="margin-top:var(--spacing-16)" data-sign-result></div>`,
    )}
  </section>

</div>`,
  });
}

// ── Settlement detail ───────────────────────────────────────────────────────

/** Everything the browser needs to act, serialised into the page once. */
export interface WorkspacePayload {
  readonly settlementId: string;
  readonly deployment: {
    deploymentId: string;
    coordinator: string;
    cashEscrow: string;
    cashAsset: string;
    rwaToken: string;
    rwaAdapter: string;
  };
  readonly disposition?: {
    controller: string;
    registry: string;
    policyId: string;
    contestWindowSeconds: number;
    chainId: number;
  };
  readonly terms: Record<string, string>;
  readonly signatures: {
    payer: boolean;
    seller: boolean;
    payerSignature?: string;
    sellerSignature?: string;
  };
  readonly termsSource: string;
  readonly verifierClass?: string;
  readonly canonicalState: string;
  readonly attestationsAvailable: boolean;
}

/**
 * The mount point, with an honest server-rendered placeholder inside it.
 *
 * The placeholder is not a spinner pretending to be content. It names what the
 * panel is about to do and where the authority comes from, so a reader with no
 * JavaScript learns the true thing — that this part reads chains directly and
 * the page below does not — rather than staring at an empty box.
 */
function workspaceMount(payload: WorkspacePayload): string {
  return `<div data-workspace="${esc(JSON.stringify(payload))}">
<div data-action-host>
  ${card(
    `<div class="stack-8">
<div class="t-caption-upper">Next action</div>
<p class="muted" style="max-width:70ch">This panel reads the coordinator on Monad and the token and adapter on Base directly from your browser, and decides what this settlement needs next. The projection below is a convenience and is never the authority.</p>
<noscript><span class="t-caption muted">It needs JavaScript. Everything below this panel is server-rendered and does not.</span></noscript>
</div>`,
  )}
</div>
<div data-finality-host></div>
<div data-compliance-host></div>
<div data-disposition-host></div>
</div>`;
}

/** What happened to this trade, in one sentence, before any of the evidence. */
function outcomeCard(view: SettlementView): string {
  const outcome = describeOutcome(view);
  return `<section class="section">${card(
    `<div class="outcome"><div class="t-caption-upper">Outcome</div><div class="outcome-headline">${esc(outcome.headline)}</div><p class="outcome-detail">${esc(outcome.detail)}</p></div>`,
  )}</section>`;
}

/**
 * Lifecycle, compliance, conservation and messages: the proof behind the outcome.
 *
 * A settlement that is finished and independently verified has already said what
 * it has to say, so this arrives closed and the verifier is one click away. Any
 * other state leaves it open, because an unfinished settlement is exactly when a
 * reader needs to see which message or answer is missing.
 */
function proofDetail(view: SettlementView): string {
  const finished = view.canonicalState === 'SETTLED' && view.verifierClass === 'SETTLED_FINAL';
  return `<section class="section">
  <details class="card disclosure"${finished ? '' : ' open'}>
    <summary class="disclosure-summary">Proof behind this outcome</summary>
    <div class="stack-16">
      <div>${sectionHeader('Lifecycle')}${settlementTimeline(view)}</div>
      <div class="grid-2" style="align-items:start">
        <div>${sectionHeader('Compliance')}${complianceTimeline(view.compliance)}</div>
        <div>${sectionHeader('Conservation')}${conservationBreakdown(view.conservation)}</div>
      </div>
      <div>${sectionHeader('Cross-chain messages')}${messageRoute(view.messages)}</div>
    </div>
  </details>
</section>`;
}

/**
 * The settlement workspace.
 *
 * Action first, inspection second. Somebody looking at their own settlement
 * needs one question answered before any other — what happens next and whether
 * it is theirs to do — and everything below the fold is the evidence for the
 * answer rather than a substitute for it.
 *
 * The action panel is the only part that needs a browser: it reads both chains
 * live, because the projection is a convenience and never an authority. The rest
 * of the page is server-rendered and readable with JavaScript switched off, so a
 * proof stays a proof.
 */
export function renderSettlement(
  generation: string,
  view: SettlementView,
  workspace?: WorkspacePayload,
): string {
  const outcome = describeOutcome(view);
  // The detail's meaning sentence often opens with the headline ("Cash is locked."), which
  // reads twice in a link card where the two are run together.
  const detail = outcome.detail.replace(outcome.headline, '');

  return shell({
    title: `Settlement ${truncate(view.settlementId)}`,
    description: clipDescription(`${outcome.headline} ${detail}`),
    path: `/app/settlements/${view.settlementId}`,
    current: '/app/settlements',
    generation,
    topRight: button({
      label: 'Verify independently',
      href: `/verify/${view.settlementId}`,
      variant: 'outline',
      small: true,
    }),
    body: `${pageHeader({
      title: 'Settlement',
      trail: [
        { label: 'Conduit', href: '/app' },
        { label: 'Settlements', href: '/app/settlements' },
        { label: truncate(view.settlementId, 8, 6) },
      ],
      meta: `<div class="row" style="margin-top:var(--spacing-8);flex-wrap:wrap">${stateBadge(view.canonicalState)}${view.verifierClass === undefined ? '' : stateBadge(view.verifierClass)}${badge(`gen ${String(view.generation)}`, 'outline')}<span class="t-caption muted" data-role-chip>role unknown until a wallet connects</span></div>
<div class="muted" style="margin-top:var(--spacing-8);font-size:13px">${settlementLink(view.settlementId, 'verify')}</div>`,
      actions: `${button({ label: 'Evidence', href: `/evidence/${view.settlementId}`, variant: 'outline', small: true })}${button({ label: 'Verify', href: `/verify/${view.settlementId}`, small: true })}`,
    })}

${outcomeCard(view)}

${workspace === undefined ? '' : `<div class="section">${workspaceMount(workspace)}</div>`}

${
  view.termsKnown
    ? ''
    : `<div class="section" style="margin-top:var(--spacing-16)">${card(
        `<div class="row" style="align-items:flex-start;gap:var(--spacing-12)"><span style="flex:none;color:var(--color-ember);margin-top:2px">${icon('alert', 16)}</span><div><div style="font-weight:var(--font-weight-medium)">Terms were not recovered</div><p class="muted" style="margin-top:var(--spacing-4);max-width:64ch">No artifact carries this settlement’s intent, so amounts and parties are unknown rather than zero. The outcomes below are still read from chain state and are accurate.</p></div></div>`,
      )}</div>`
}

<section class="section">
  ${sectionHeader('The trade')}
  ${card(crossChainDiagram(view))}
</section>

<section class="section">
  ${sectionHeader('Legs')}
  <div class="grid-2">${settlementLegCard('Cash leg', view.cash)}${settlementLegCard('Asset leg', view.asset)}</div>
</section>

<section class="section">
  ${sectionHeader('What the state means')}
  ${stateExplainer(view.canonicalState, view.verifierClass)}
</section>

${proofDetail(view)}

${
  view.disposition === undefined
    ? ''
    : `<section class="section">${sectionHeader('Disposition')}${card(dispositionCase(view.disposition))}</section>`
}`,
  });
}

/**
 * The counterparty's view of a settlement request.
 *
 * A bilateral settlement has two signers and they are rarely at the same
 * machine. This page is what the second one opens: the terms in full, who has
 * already signed, and a control that will only accept a signature from the
 * address the terms actually name.
 */
export function renderSignRequest(
  generation: string,
  settlementId: string,
  request: {
    deployment: {
      deploymentId: string;
      coordinator: string;
      cashEscrow: string;
      cashAsset: string;
      rwaToken: string;
      rwaAdapter: string;
    };
    cashAmount: string;
    assetAmount: string;
    cashPayer: string;
    cashReceiver: string;
    assetSeller: string;
    assetReceiver: string;
    prepareDeadline: string;
    commitDeadline: string;
    releaseDeadline: string;
    payerSigned: boolean;
    sellerSigned: boolean;
    intent: Record<string, string>;
  },
): string {
  const signed = (yes: boolean): string =>
    yes ? badge('SIGNED', 'solid') : badge('AWAITING', 'soft', true);

  return shell({
    title: `Sign ${truncate(settlementId)}`,
    description: 'Review the terms of a settlement request, then sign it with the wallet it names.',
    path: `/app/settlements/${settlementId}/sign`,
    current: '/app/settlements',
    generation,
    body: `${pageHeader({
      title: 'Settlement request',
      trail: [
        { label: 'Conduit', href: '/app' },
        { label: 'Settlements', href: '/app/settlements' },
        { label: 'Sign' },
      ],
      meta: `<div class="muted" style="margin-top:var(--spacing-4);font-size:13px">${settlementLink(settlementId)}</div>`,
    })}

<div data-sign-request="${esc(JSON.stringify({ deployment: request.deployment, intent: request.intent }))}">
${card(`<div class="xchain">
  <div class="xchain-leg">
    <div class="leg-chain">${chainIdentity(10143)}</div>
    <div class="t-caption-upper">You would receive</div>
    <div class="leg-amount">${esc(request.cashAmount)}</div>
    <div class="leg-asset">cSETTLE</div>
  </div>
  <div class="xchain-mid"><div class="connector"></div><div class="label">for</div><div class="connector"></div></div>
  <div class="xchain-leg">
    <div class="leg-chain">${chainIdentity(84532)}</div>
    <div class="t-caption-upper">You would deliver</div>
    <div class="leg-amount">${esc(request.assetAmount)}</div>
    <div class="leg-asset">cBOND</div>
  </div>
</div>`)}

<div class="section grid-2" style="align-items:start">
  ${cardWithHeader(
    'Parties',
    `<table class="kv">
<tr><td>Cash payer</td><td>${address(request.cashPayer, 10143)}</td></tr>
<tr><td>Cash receiver</td><td>${address(request.cashReceiver, 10143)}</td></tr>
<tr><td>Asset seller</td><td>${address(request.assetSeller, 84532)}</td></tr>
<tr><td>Asset receiver</td><td>${address(request.assetReceiver, 84532)}</td></tr>
</table>`,
  )}
  ${cardWithHeader(
    'Signatures',
    `<table class="kv">
<tr><td>Payer</td><td>${signed(request.payerSigned)}</td></tr>
<tr><td>Seller</td><td>${signed(request.sellerSigned)}</td></tr>
</table>
<div class="note">Both signatures commit to the same digest, and that digest is the settlement id. Neither party signs anything the other cannot verify.</div>`,
  )}
</div>

<section class="section">
  ${cardWithHeader(
    'Review and sign',
    `<div class="t-caption muted" data-sign-request-status>Connect the wallet named in these terms to sign.</div>
    <div class="row" style="margin-top:var(--spacing-16)">
      <button class="btn btn-primary" type="button" data-sign-request-button disabled>Sign with my wallet</button>
      <span data-participant></span>
    </div>
    <div class="stack-12" style="margin-top:var(--spacing-16)" data-sign-request-result></div>`,
  )}
</section>
</div>`,
  });
}

// ── Dispositions ────────────────────────────────────────────────────────────

/**
 * The disposition center.
 *
 * An empty case list is the normal, healthy state of this page: a case exists
 * only while committed value is undeliverable. Saying nothing else would make a
 * finished product look unfinished, so the page carries the paths that actually
 * ran — with their real transaction hashes — under a heading that does not
 * pretend they are open.
 */
export function renderDispositions(generation: string, rows: readonly DispositionRow[]): string {
  return shell({
    title: 'Dispositions',
    description:
      'Cases where committed value could not be delivered, and the authorised orders that resolve them.',
    path: '/app/dispositions',
    current: '/app/dispositions',
    generation,
    body: `${pageHeader({
      title: 'Disposition center',
      trail: [{ label: 'Conduit', href: '/app' }, { label: 'Dispositions' }],
      caption:
        'Cases opened when committed value cannot be delivered. A case rests for its contest window before any order can execute, so two authorities who genuinely disagree are not adjudicated by gas price.',
    })}

<section class="section" style="margin-top:0">
  ${sectionHeader('Active cases', badge(String(rows.length), rows.length === 0 ? 'outline' : 'solid'))}
  ${
    rows.length === 0
      ? card(
          emptyState(
            'No open cases',
            'Nothing is currently held. A case is opened only when committed value cannot be delivered under the compliance rules in force at delivery time.',
            button({
              label: 'View settlements',
              href: '/app/settlements',
              variant: 'outline',
              small: true,
            }),
          ),
        )
      : card(
          `<div class="table-scroll"><table class="table table-hover">
<thead><tr><th>Case</th><th>Settlement</th><th>Leg</th><th>State</th></tr></thead>
<tbody>${rows
            .map(
              (row) => `<tr>
<td class="mono"><a href="/app/dispositions/${esc(row.caseId)}">${esc(truncate(row.caseId))}</a></td>
<td class="mono"><a href="/app/settlements/${esc(row.settlementId)}">${esc(truncate(row.settlementId))}</a></td>
<td class="mono">${esc(row.leg)}</td>
<td>${stateBadge(row.caseState)}</td></tr>`,
            )
            .join('')}</tbody></table></div>`,
          { flush: true },
        )
  }
</section>

<section class="section">
  ${sectionHeader('Protocol history', badge(`${String(DISPOSITION_HISTORY.length)} resolved`, 'outline'))}
  <div class="stack-16">${DISPOSITION_HISTORY.map((history) =>
    cardWithHeader(
      `${history.dispositionType} — generation ${String(history.generation)}`,
      `<div class="timeline">${history.steps
        .map(
          (step) => `<div class="tl-item">
<div class="tl-rail"><span class="tl-node done"></span><span class="tl-line"></span></div>
<div class="tl-body"><div class="tl-title">${esc(step.label)}</div><div class="tl-meta mono" style="word-break:break-all">${esc(step.detail)}</div></div>
</div>`,
        )
        .join('')}</div>
<div class="row" style="margin-top:var(--spacing-16);flex-wrap:wrap">${button({ label: 'Settlement', href: `/app/settlements/${history.settlementId}`, variant: 'outline', small: true })}${button({ label: 'Evidence', href: `/evidence/${history.settlementId}`, variant: 'outline', small: true })}${button({ label: 'Verify', href: `/verify/${history.settlementId}`, small: true })}</div>`,
      stateBadge('EXECUTED'),
    ),
  ).join('')}</div>
  <div class="note">These are live testnet settlements, not fixtures. Each one committed while every participant was eligible, was refused at delivery time by a RuleV2 the issuer moved in between, held the undeliverable leg without refunding the leg that had already released, and reached a terminal state through an authorised order.</div>
</section>

<section class="section">
  ${sectionHeader('The six order types')}
  <div class="grid-3">${DISPOSITION_TYPES.map(
    (type) => `<div class="dtype">
<div class="dtype-name">${esc(type.name)}</div>
<p class="muted t-caption">${esc(type.purpose)}</p>
<div class="t-caption muted"><strong>Authority</strong> ${esc(type.authority)}</div>
<div class="t-caption muted"><strong>Destination</strong> ${esc(type.destination)}</div>
</div>`,
  ).join('')}</div>
  <div class="note">REVERIFY_AND_RESUME needs the weakest authority because it has no destination parameter at all: it can only retry the delivery the settlement already agreed to. Every other type is an authorisation to send value somewhere the intent never named, and the registry decides who may sign one.</div>
</section>`,
  });
}

/**
 * The six types, their purpose, and what the registry demands of each.
 *
 * Mirrors `DESTINATION_RULE` in `@conduit-protocol/domain` and the policy the
 * kernel was wired with. Kept as copy rather than derived because the sentences
 * are product language, and the machine-readable rule they describe is asserted
 * against the contract in `packages/domain`.
 */
const DISPOSITION_TYPES: readonly {
  name: string;
  purpose: string;
  authority: string;
  destination: string;
}[] = [
  {
    name: 'REVERIFY_AND_RESUME',
    purpose: 'Ask compliance again and retry the delivery the settlement already agreed to.',
    authority: 'one signature, weakest class',
    destination: 'must equal the current intended receiver',
  },
  {
    name: 'REBIND_RECEIVER',
    purpose: 'Deliver to a different account belonging to the same registered identity.',
    authority: 'two signatures',
    destination: 'must carry the same registered identity commitment',
  },
  {
    name: 'RETURN_TO_ELIGIBLE_SENDER',
    purpose: 'Send the held value back to the party it came from.',
    authority: 'one signature',
    destination: 'must equal the original sender, and only after a COMMIT',
  },
  {
    name: 'AUTHORIZED_SUBSTITUTION',
    purpose: 'Deliver to an approved substitute for the refused receiver.',
    authority: 'one signature',
    destination: 'must be an approved substitute for the current receiver',
  },
  {
    name: 'OPERATOR_ASSISTED_OFFRAMP',
    purpose: 'Move the value to a registered gateway for an off-chain resolution.',
    authority: 'one signature, gateway operator class',
    destination: 'must be a registered gateway account',
  },
  {
    name: 'RESTRICTED_HOLD',
    purpose:
      'Move the value into registered restricted custody. No party to the trade receives it.',
    authority: 'one signature',
    destination: 'must be a registered restricted custodian',
  },
];

// ── Verifier ────────────────────────────────────────────────────────────────

export function renderVerifierHome(generation: string): string {
  return shell({
    title: 'Verifier',
    description:
      "Verify a settlement from two chain RPCs and the Wormhole guardian set, without trusting this application's database.",
    path: '/app/verifier',
    current: '/app/verifier',
    generation,
    body: `${pageHeader({
      title: 'Verifier',
      trail: [{ label: 'Conduit', href: '/app' }, { label: 'Verifier' }],
      caption:
        'Reconstructs a settlement from two chain RPCs, the committed manifests and the guardian set. The application database is not an input.',
    })}
${card(`<form action="/verify" method="get" class="stack-16">
${input({ name: 'id', label: 'Settlement id', placeholder: '0x…', mono: true, pattern: '0x[0-9a-fA-F]{64}', required: true })}
<div class="row">${button({ label: 'Verify', type: 'submit' })}${button({ label: 'Browse settlements', href: '/app/settlements', variant: 'secondary' })}</div>
</form>
<div class="note">A verification is a claim about a settlement under one deployment generation. A generation-1 settlement stays verifiable against generation-1 contracts forever, and the current generation cannot answer for it.</div>
<div class="note">It proves what the chains and the guardian set say. It does not prove that the compliance attestation behind a COMMIT was honestly obtained: the contract checks that an authorised signer asserted eligibility and bound it to this settlement, and nothing on chain can check that the signer asked Cleanverse. With this deployment’s quorum of one, that is a trust assumption in the signer’s operator, recorded as T-08 in the threat register.</div>`)}`,
  });
}

/**
 * What a verification says about itself, for somebody who has not opened it.
 *
 * A run that could not read part of the history reaches no verdict, and the page
 * withholds the classification for that reason. The description withholds it too,
 * because a link card reading "Independently verified" over an incomplete run
 * would say what the page itself refuses to.
 */
function verificationDescription(result: VerificationResult, passed: number): string {
  if (result.hadScanGap) {
    return 'Incomplete: part of the history could not be read. An RPC scan gap is not a verdict.';
  }

  const meaning = CLASS_MEANING[result.classification];
  const verdict =
    meaning === undefined ? result.classification : `${result.classification}: ${meaning}`;
  const total = result.findings.length;
  return clipDescription(
    total === 0 ? verdict : `${verdict} ${String(passed)} of ${String(total)} checks passed.`,
  );
}

export function renderVerification(
  generation: string,
  settlementId: string,
  result: VerificationResult,
): string {
  const failed = result.findings.filter((finding) => !finding.ok);
  const passed = result.findings.length - failed.length;

  return shell({
    title: `Verification ${truncate(settlementId)}`,
    description: verificationDescription(result, passed),
    path: `/verify/${settlementId}`,
    current: '/app/verifier',
    generation,
    body: `${pageHeader({
      title: 'Verification',
      trail: [
        { label: 'Conduit', href: '/app' },
        { label: 'Verifier', href: '/app/verifier' },
        { label: truncate(settlementId, 8, 6) },
      ],
      meta: `<div class="muted" style="margin-top:var(--spacing-4);font-size:13px">${settlementLink(settlementId)}</div>`,
      actions: button({
        label: 'Open settlement',
        href: `/app/settlements/${settlementId}`,
        variant: 'outline',
        small: true,
      }),
    })}

${
  result.hadScanGap
    ? card(
        errorState(
          'Incomplete — part of the history could not be read',
          'An RPC scan gap is not a verdict. "No messages found" and "no messages exist" are different answers, and only one of them is a finding. Widen the search window before drawing a conclusion.',
        ),
      )
    : card(
        `<div class="stack-8"><div class="row" style="gap:var(--spacing-12)">${stateBadge(result.classification)}<span class="t-caption muted">derived, not an on-chain value</span></div><p class="muted" style="max-width:70ch">${esc(CLASS_MEANING[result.classification] ?? '')}</p></div>`,
      )
}

<section class="section">
  ${sectionHeader(`Checks`, badge(`${String(passed)} of ${String(result.findings.length)} passed`, failed.length === 0 ? 'solid' : 'ember'))}
  ${card(verifierChecklist(result.findings))}
</section>

<section class="section">
  ${sectionHeader('What was searched')}
  ${card(
    `<table class="kv">${Object.entries(result.searchedRanges)
      .map(
        ([chainId, range]) =>
          `<tr><td>${chainIdentity(Number(chainId))}</td><td class="mono">${esc(range.from)} – ${esc(range.to)}</td></tr>`,
      )
      .join('')}</table><div class="note">${esc(result.trustRoot)}</div>`,
  )}
</section>`,
  });
}

// ── Evidence ────────────────────────────────────────────────────────────────

/** One artifact row, with its value linked wherever the value is checkable. */
function artifactRow(artifact: ProofArtifact): string {
  const value =
    artifact.kind === 'transaction' && artifact.chainId !== undefined
      ? txHash(artifact.value, artifact.chainId)
      : `<span class="mono" style="font-size:13px;word-break:break-all">${esc(artifact.value)}</span>`;
  return `<tr>
<td><span class="badge badge-outline">${esc(artifact.kind)}</span></td>
<td>${esc(artifact.label)}${artifact.note === undefined ? '' : `<div class="t-caption muted">${esc(artifact.note)}</div>`}</td>
<td>${value}</td>
</tr>`;
}

function proofCard(proof: ProofPackage): string {
  const kinds = new Map<string, number>();
  for (const artifact of proof.artifacts) {
    kinds.set(artifact.kind, (kinds.get(artifact.kind) ?? 0) + 1);
  }
  return cardWithHeader(
    proof.title,
    `<p class="muted" style="max-width:74ch">${esc(proof.summary)}</p>
<table class="kv" style="margin-top:var(--spacing-12)">
<tr><td>Settlement</td><td class="mono"><a href="/app/settlements/${esc(proof.settlementId)}">${esc(truncate(proof.settlementId))}</a></td></tr>
<tr><td>Verifier</td><td>${proof.verification === undefined ? '<span class="muted t-caption">no run</span>' : `${stateBadge(proof.verification.classification)} <span class="t-caption muted">${String(proof.verification.passed)} of ${String(proof.verification.total)} checks</span>`}</td></tr>
<tr><td>Artifacts</td><td class="mono">${[...kinds.entries()].map(([kind, count]) => `${String(count)} ${kind}`).join(', ')}</td></tr>
<tr><td>Source</td><td class="mono" style="font-size:13px">${esc(proof.source)}</td></tr>
</table>
${proof.note === undefined ? '' : `<div class="note">${esc(proof.note)}</div>`}
<div class="row" style="margin-top:var(--spacing-16)">${button({ label: 'Open evidence', href: `/evidence/${proof.settlementId}`, variant: 'outline', small: true })}${button({ label: 'Verify', href: `/verify/${proof.settlementId}`, small: true })}</div>`,
    badge(`gen ${String(proof.generation)}`, 'outline'),
  );
}

/**
 * The evidence explorer.
 *
 * It used to say "no artifacts published yet" while four verified settlements
 * sat in `docs/evidence`, two of which reached a terminal state through a
 * disposition. That sentence was true about object storage and false about
 * evidence, and the distinction is now made where it belongs: every package
 * names the repository path it came from, and every value on the page is one the
 * protocol produced and anybody can check against two chains.
 */
export function renderEvidenceHome(generation: string): string {
  return shell({
    title: 'Evidence',
    description:
      "Proof packages for the settlements that ran on the deployed contracts: transactions, messages, attestations and the verifier's run.",
    path: '/app/evidence',
    current: '/app/evidence',
    generation,
    body: `${pageHeader({
      title: 'Evidence explorer',
      trail: [{ label: 'Conduit', href: '/app' }, { label: 'Evidence' }],
      caption:
        'Every artifact a live run produced: transactions, Wormhole messages and their measured finality, Cleanverse answer hashes, policy changes, refusals, and balances before and after.',
    })}
<div class="stack-16">${PROOF_PACKAGES.map((proof) => proofCard(proof)).join('')}</div>

<section class="section">
  ${sectionHeader('Independent verifications')}
  ${card(
    `<div class="table-scroll"><table class="table table-hover">
<thead><tr><th>Settlement</th><th>Canonical</th><th>Verifier</th><th>Checks</th><th>Generation</th></tr></thead>
<tbody>${VERIFICATIONS.map(
      (run) => `<tr>
<td class="mono"><a href="/verify/${esc(run.settlementId)}">${esc(truncate(run.settlementId))}</a></td>
<td>${stateBadge(run.canonicalState)}</td>
<td>${stateBadge(run.classification)}</td>
<td class="mono">${String(run.passed)}/${String(run.total)}</td>
<td style="font-size:13px">${deploymentLink(run.deploymentId)}</td>
</tr>`,
    ).join('')}</tbody></table></div>`,
    { flush: true },
  )}
  <div class="note">A verification is a claim about a settlement under one deployment generation, derived from two chain RPCs, the committed manifests and the guardian set. The application database is not an input.</div>
</section>

<section class="section">
  ${sectionHeader('Deployment manifests')}
  ${card(
    `<div class="table-scroll"><table class="table">
<thead><tr><th>Manifest</th><th>Deployment</th><th>solc</th><th>Contracts</th></tr></thead>
<tbody>${MANIFESTS.map(
      (manifest) => `<tr>
<td class="mono" style="font-size:13px">${esc(manifest.file)}</td>
<td style="font-size:13px">${deploymentLink(manifest.deploymentId)}</td>
<td class="mono">${esc(manifest.solcVersion)}</td>
<td class="mono" style="font-size:13px">${manifest.contracts.map((contract) => esc(contract.role)).join(', ')}</td>
</tr>`,
    ).join('')}</tbody></table></div>`,
    { flush: true },
  )}
  <div class="note">Served from the repository this Worker was built from, not from object storage. Nothing on this page claims a content-addressed publication that does not exist: ASM-039 stays open, and replacing the storage later changes where these bytes live and nothing about what they mean.</div>
</section>`,
  });
}

export function renderEvidence(
  generation: string,
  settlementId: string,
  items: readonly { label: string; detail: string; at: string }[],
  proof?: ProofPackage,
): string {
  const groups = new Map<string, ProofArtifact[]>();
  for (const artifact of proof?.artifacts ?? []) {
    const bucket = groups.get(artifact.kind) ?? [];
    bucket.push(artifact);
    groups.set(artifact.kind, bucket);
  }

  // Any 64 hex digits reach this route and it answers 200 with an empty state, so a page with
  // nothing to show leaves out its path. That makes it noindex with no canonical, where
  // otherwise anyone could mint indexable addresses on this domain whose preview claims
  // records exist.
  const recorded = proof !== undefined || items.length > 0;

  return shell({
    title: `Evidence ${truncate(settlementId)}`,
    description: clipDescription(
      proof?.summary ??
        (recorded
          ? 'Transactions, messages and verifier runs recorded for this settlement.'
          : 'Nothing is recorded for this settlement in this build. That is not a statement about the chains.'),
    ),
    ...(recorded ? { path: `/evidence/${settlementId}` } : {}),
    current: '/app/evidence',
    generation,
    body: `${pageHeader({
      title: 'Evidence',
      trail: [
        { label: 'Conduit', href: '/app' },
        { label: 'Evidence', href: '/app/evidence' },
        { label: truncate(settlementId, 8, 6) },
      ],
      meta: `<div class="muted" style="margin-top:var(--spacing-4);font-size:13px">${settlementLink(settlementId)}</div>`,
      actions: button({
        label: 'Open settlement',
        href: `/app/settlements/${settlementId}`,
        variant: 'outline',
        small: true,
      }),
    })}
${
  proof === undefined
    ? card(
        emptyState(
          'No run artifact carries this settlement',
          'The projection may still hold indexed artifacts for it, listed below. A settlement with neither is one this build has no evidence package for — which is not a statement about the chains.',
        ),
      )
    : `${card(
        `<div class="stack-12">
<p class="muted" style="max-width:74ch">${esc(proof.summary)}</p>
<table class="kv">
<tr><td>Outcome recorded by the run</td><td class="mono">${esc(proof.outcome)}</td></tr>
<tr><td>Ran</td><td class="mono" style="font-size:13px">${esc(proof.startedAt ?? 'unknown')} → ${esc(proof.finishedAt ?? 'unknown')}</td></tr>
<tr><td>Source</td><td class="mono" style="font-size:13px">${esc(proof.source)}</td></tr>
${proof.verification === undefined ? '' : `<tr><td>Independent verification</td><td>${stateBadge(proof.verification.classification)} <span class="t-caption muted">${String(proof.verification.passed)} of ${String(proof.verification.total)} checks · ${esc(proof.verification.source)}</span></td></tr>`}
</table>
${proof.note === undefined ? '' : `<div class="note">${esc(proof.note)}</div>`}
</div>`,
      )}
${[...groups.entries()]
  .map(
    ([kind, artifacts]) =>
      `<section class="section">${sectionHeader(kind, badge(String(artifacts.length), 'outline'))}${card(
        `<div class="table-scroll"><table class="table"><tbody>${artifacts.map((artifact) => artifactRow(artifact)).join('')}</tbody></table></div>`,
        { flush: true },
      )}</section>`,
  )
  .join('')}`
}

<section class="section">
  ${sectionHeader('Indexed artifacts')}
  ${card(evidenceTimeline(items))}
</section>`,
  });
}

// ── Deployments and system ──────────────────────────────────────────────────

export function renderDeployments(generation: string, rows: readonly DeploymentView[]): string {
  return shell({
    title: 'Deployments',
    description:
      'Every deployed generation of the Conduit contracts, with addresses, code hashes and manifests.',
    path: '/app/deployments',
    current: '/app/deployments',
    generation,
    body: `${pageHeader({
      title: 'Deployments',
      trail: [{ label: 'Conduit', href: '/app' }, { label: 'Deployments' }],
      caption:
        'Core contracts are non-upgradeable, so a new version is a new generation. Each one stays verifiable for the settlements it knows.',
    })}
<div class="stack-16">${card(
      `<div class="stack-12"><div class="t-caption-upper">Checking these yourself</div>
<p class="muted">Every address below links to its chain’s explorer. Source verification, code hashes and the full generation history are re-checked against Sourcify on every gate run and recorded in the repository, alongside a resolved index of every transaction these deployments have processed.</p>
<div class="row" style="flex-wrap:wrap">
${external('https://github.com/winsznx/conduit/blob/main/docs/deployments.md', 'Deployment generations', 'docs/deployments.md — addresses, code hashes and verified source')}
${external('https://github.com/winsznx/conduit/blob/main/docs/onchain.md', 'On-chain transaction index', 'docs/onchain.md — every transaction, resolved against the chain that mined it')}
${external('https://github.com/winsznx/conduit/blob/main/docs/evidence/onchain-verification.json', 'Verification evidence', 'docs/evidence/onchain-verification.json — the machine-checked record')}
</div></div>`,
    )}${rows
      .map((row) =>
        cardWithHeader(
          `Generation ${String(row.generation)}`,
          `<table class="kv">
<tr><td>Deployment</td><td>${deploymentLink(row.deploymentId, true)}</td></tr>
<tr><td>Commit</td><td class="mono">${esc(row.gitCommit)}</td></tr>
<tr><td>solc</td><td class="mono">${esc(row.solcVersion)}</td></tr>
<tr><td>Superseded by</td><td>${row.supersededBy === undefined ? '<span class="muted">—</span>' : deploymentLink(row.supersededBy)}</td></tr>
</table>
<hr class="rule">
<div class="t-caption-upper" style="margin-bottom:var(--spacing-8)">Contracts</div>
<div class="table-scroll"><table class="table">
<thead><tr><th>Role</th><th>Chain</th><th>Address</th></tr></thead>
<tbody>${row.contracts
            .map(
              (contract) =>
                `<tr><td>${esc(contract.role)}</td><td>${chainIdentity(contract.chainId)}</td><td>${address(contract.address, contract.chainId)}</td></tr>`,
            )
            .join('')}</tbody></table></div>`,
          row.supersededBy === undefined
            ? badge('current', 'solid')
            : badge('superseded', 'outline'),
        ),
      )
      .join('')}</div>`,
  });
}

export function renderSystem(
  generation: string,
  env: { deploymentId: string; commit: string },
): string {
  return shell({
    title: 'System',
    description:
      'What this console can and cannot do: one key, no custody, and a projection that authorises nothing.',
    path: '/app/system',
    current: '/app/system',
    generation,
    body: `${pageHeader({
      title: 'System',
      trail: [{ label: 'Conduit', href: '/app' }, { label: 'System' }],
      caption: 'What this surface is, and what it deliberately cannot do.',
    })}
<div class="grid-2" style="align-items:start">
${cardWithHeader(
  'This deployment',
  `<table class="kv">
<tr><td>Deployment</td><td>${deploymentLink(env.deploymentId, true)}</td></tr>
<tr><td>Build</td><td class="mono">${esc(env.commit)}</td></tr>
<tr><td>Surface</td><td>read-only</td></tr>
</table>`,
)}
${cardWithHeader(
  'Trust boundary',
  `<p class="muted">This console holds no settlement key. Signatures come from your own wallet, and its database is a projection: convenient, and never evidence. A reader who wants proof runs the verifier against the chains.</p>
<div class="note">Application database state never authorizes value movement.</div>
<hr class="rule">
<div class="t-caption-upper" style="margin-bottom:var(--spacing-8)">One key, and what it cannot do</div>
<p class="muted">Every value-moving call demands a quorum of compliance attestations signed by an address the contract’s registered signer set contains. A browser cannot produce one, so this deployment’s Worker holds that signer. It signs eligibility answers Cleanverse gave and nothing else: it cannot move a token, sign a settlement intent, create a settlement, decide one without both parties’ signatures and a canonical READY state, or release a leg without a COMMIT already on chain.</p>
<div class="note">The contract proves an authorised signer asserted eligibility. It cannot prove the signer asked Cleanverse. At this deployment’s quorum of one, that is a trust assumption in the signer’s operator — threat register T-08 and T-09, accepted with a written waiver, and not described anywhere as trustless.</div>`,
)}
</div>`,
  });
}

// ── Errors ──────────────────────────────────────────────────────────────────

export function renderNotFound(what: string, detail: string): string {
  return document_(
    { title: 'Not found' },
    `<div class="landing"><nav class="landing-nav">${wordmark(true)}${button({ label: 'Console', href: '/app', variant: 'outline', small: true })}</nav>
<main id="content" tabindex="-1"><div style="padding:80px 0">${card(emptyState(what, detail, button({ label: 'Back to settlements', href: '/app/settlements', variant: 'outline', small: true }), 1))}</div></main></div>`,
  );
}

export function renderError(detail: string): string {
  return document_(
    { title: 'Error' },
    `<div class="landing"><nav class="landing-nav">${wordmark(true)}</nav>
<main id="content" tabindex="-1"><div style="padding:80px 0">${card(errorState('Something failed on this request', detail, 1))}</div></main></div>`,
  );
}

export { breadcrumb };
