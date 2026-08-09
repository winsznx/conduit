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
  icon,
  input,
  pageHeader,
  sectionHeader,
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
import { STYLESHEET } from './theme.js';

/** The document. One stylesheet, inline, because the CSP forbids external origins. */
function document_(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)} — Conduit</title><style>${STYLESHEET}</style></head>
<body>${body}<script type="module" src="${esc(CLIENT_PATH)}" defer></script></body></html>`;
}

/** The application shell: sidebar, top bar, content column. */
function shell(options: {
  readonly title: string;
  readonly current: string;
  readonly generation: string;
  readonly body: string;
  readonly topRight?: string;
}): string {
  return document_(
    options.title,
    `<div class="shell">${sidebar(options.current)}
<div class="main">${topBar(options.topRight ?? '')}<div class="content">${options.body}</div></div></div>`,
  );
}

// ── Landing ─────────────────────────────────────────────────────────────────

/**
 * The hero relies on the 48px display size and short copy. `design.md` caps the
 * scale there, so there is no 64–96px headline and no decorative artwork — the
 * product composition underneath is the visual content.
 */
export function renderLanding(totals: Totals, recent: readonly SettlementView[]): string {
  const sample = recent[0];

  return document_(
    'Cross-chain delivery-versus-payment',
    `<div class="landing">
<nav class="landing-nav">${wordmark()}<div class="row">${button({ label: 'Verify a settlement', href: '/app/verifier', variant: 'outline', small: true })}${button({ label: 'Open console', href: '/app', small: true })}</div></nav>

<header class="hero">
  <h1 class="t-display">Delivery versus payment, across two chains, without bridging either asset.</h1>
  <p>A restricted RWA on Base and a Cleanverse settlement unit on Monad move under one signed intent. What crosses is authenticated settlement state — and commitment becomes irreversible only after economic finality and a fresh compliance answer.</p>
  <div class="actions">${button({ label: 'Open the console', href: '/app', iconName: 'arrowRight' })}${button({ label: 'Verify independently', href: '/app/verifier', variant: 'secondary' })}</div>
</header>

<section class="landing-section">
  <div class="grid-4">
    ${statBlock({ label: 'Settlements', value: String(totals.settlements), note: 'indexed and verified' })}
    ${statBlock({ label: 'Messages', value: String(totals.messages), note: 'authenticated, consumed once' })}
    ${statBlock({ label: 'Verifications', value: String(totals.verifications), note: 'derived from chains alone' })}
    ${statBlock({ label: 'Generations', value: String(totals.generations), note: 'deployed, each verifiable' })}
  </div>
</section>

<section class="landing-section">
  ${sectionHeader('One intent, two chains')}
  ${
    sample === undefined
      ? card(
          emptyState(
            'Nothing indexed yet',
            'Once a settlement is indexed its two legs appear here.',
          ),
        )
      : card(crossChainDiagram(sample))
  }
</section>

<section class="landing-section">
  ${sectionHeader('Who settles this way')}
  <div class="grid-4">
    ${[
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
    ]
      .map(
        ([title, detail]) =>
          `<div class="stack-8"><div style="font-weight:var(--font-weight-medium)">${esc(title ?? '')}</div><p class="muted t-caption">${esc(detail ?? '')}</p></div>`,
      )
      .join('')}
  </div>
  <div class="note">The problem is not that two ledgers exist. It is that they do not finalize at the same moment, and regulatory eligibility can change while a settlement is in flight — so whoever moves first is exposed to a rule that has not been applied yet.</div>
</section>

<section class="landing-section">
  ${sectionHeader('Compliance is part of the state machine')}
  <div class="grid-3">
    ${[
      [
        'CVI',
        'Cleanverse identity. Whether a participant holds a pass at all, and whether it currently permits transfer.',
      ],
      [
        'CVA',
        'A compliant asset. The token consults its policy on every transfer, so eligibility is enforced by the asset itself.',
      ],
      [
        'RuleV2',
        'The transfer rule the issuer controls. It can change after a settlement commits, and it does.',
      ],
    ]
      .map(([title, detail]) =>
        card(
          `<div class="stack-8"><div class="mono" style="font-weight:var(--font-weight-medium)">${esc(title ?? '')}</div><p class="muted t-caption">${esc(detail ?? '')}</p></div>`,
        ),
      )
      .join('')}
  </div>
  ${card(
    `<div class="flow">${[
      ['ELIGIBLE', 'Every participant checked live, with no application cache'],
      ['COMMIT', 'The irreversible decision, taken on a fresh answer minted after finality'],
      ['RULEV2 CHANGED', 'The issuer raises the minimum tier while the settlement is in flight'],
      ['TIER TOO LOW', 'The asset refuses the receiver at the moment of transfer'],
      ['HELD', 'The delivered leg is not refunded; the undeliverable leg is held, not reverted'],
      ['DISPOSITION', 'An authorised order, rested for its contest window'],
      ['SETTLED FINAL', 'Terminal, and independently verified from two chains'],
    ]
      .map(
        ([title, detail]) => `<div class="flow-stage">
<div class="flow-rail"><span class="flow-node done"></span><span class="flow-line"></span></div>
<div class="flow-body"><div class="flow-title mono">${esc(title ?? '')}</div><div class="flow-meta">${esc(detail ?? '')}</div></div>
</div>`,
      )
      .join('')}</div>
<div class="note">This is not a diagram of an intended design. It is the sequence two live testnet settlements actually walked, and every step has a transaction hash on the evidence page.</div>`,
  )}
</section>

<section class="landing-section">
  ${sectionHeader('Wormhole moves settlement facts, not assets')}
  ${card(
    `<div class="grid-3">${[
      'ASSET_PREPARED',
      'CASH_PREPARED',
      'COMMIT',
      'RELEASED',
      'DISPOSITION_RESOLVED',
    ]
      .map((type) => `<div class="nested mono t-caption">${esc(type)}</div>`)
      .join('')}</div>
<div class="note">The bond never leaves Base and the settlement unit never leaves Monad. What crosses is an authenticated statement about protocol state, and each one is verified against the guardian set, the emitter, the deployment and the message type before it is consumed — once, and never again.</div>`,
  )}
</section>

<section class="landing-section">
  ${sectionHeader('What the states mean')}
  <div class="grid-3">
    ${(['SETTLED', 'HELD', 'CONTESTED'] as const)
      .map((state) =>
        card(
          `<div class="stack-8">${stateBadge(state)}<p class="muted">${esc(STATE_MEANING[state]?.says ?? '')}</p></div>`,
        ),
      )
      .join('')}
  </div>
  <div class="note">HELD is not a failure and not a refund. The commitment stands, the value is accounted for, and it moves only through an authorised disposition.</div>
</section>

<section class="landing-section">
  ${sectionHeader('Proven live')}
  <div class="grid-2">${PROOF_PACKAGES.filter((proof) => proof.generation === 3)
    .map(
      (proof) => `<div class="card">
<div class="stack-12">
  <div class="row">${badge(`generation ${String(proof.generation)}`, 'outline')}${proof.verification === undefined ? '' : stateBadge(proof.verification.classification)}</div>
  <div class="t-subheading">${esc(proof.title)}</div>
  <p class="muted">${esc(proof.summary)}</p>
  <div class="row" style="flex-wrap:wrap">${button({ label: 'Evidence', href: `/evidence/${proof.settlementId}`, variant: 'outline', small: true })}${button({ label: 'Verify independently', href: `/verify/${proof.settlementId}`, small: true })}</div>
</div></div>`,
    )
    .join('')}</div>
</section>

<section class="landing-section">
  ${sectionHeader('Try Conduit')}
  ${card(
    `<div class="grid-2" style="align-items:start">
<div class="stack-12">
  <div style="font-weight:var(--font-weight-medium)">Connect your own wallet</div>
  <p class="muted">Compose an intent, have every participant checked against Cleanverse, and sign it in your own browser. Conduit never sees your key.</p>
  <div class="row"><span data-wallet-control></span>${button({ label: 'Compose a settlement', href: '/app/settlements/new', variant: 'outline', small: true })}</div>
  <p class="t-caption muted">A wallet the Cleanverse hackathon sandbox has never issued an A-Pass to will be refused, and the console will say so precisely rather than failing vaguely. That refusal is the product working.</p>
</div>
<div class="stack-12">
  <div style="font-weight:var(--font-weight-medium)">Or explore a settlement that already happened</div>
  <p class="muted">Four settlements across three deployment generations, each verifiable from two chain RPCs and the guardian set with no help from this server.</p>
  <div class="row" style="flex-wrap:wrap">${button({ label: 'Explore a proven settlement', href: '/app/settlements', variant: 'outline', small: true })}${button({ label: 'HELD → disposition proof', href: '/app/dispositions', variant: 'outline', small: true })}${button({ label: 'Verify independently', href: '/app/verifier', small: true })}</div>
</div>
</div>`,
  )}
</section>

<footer class="landing-foot"><div class="row-between">${wordmark()}<span class="t-caption">Conduit holds no key that can move your value. Signatures come from your wallet; authority comes from the chains.</span></div></footer>
</div>`,
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

export function renderOverview(
  generation: string,
  totals: Totals,
  recent: readonly SettlementView[],
): string {
  return shell({
    title: 'Overview',
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
        'Everything on this page is a projection of what two chains and the guardian set say. No value moves from here.',
    })}
<div class="grid-4">
  ${statBlock({ label: 'Settlements', value: String(totals.settlements), small: true })}
  ${statBlock({ label: 'Held', value: String(totals.held), note: 'awaiting disposition', small: true })}
  ${statBlock({ label: 'Messages', value: String(totals.messages), small: true })}
  ${statBlock({ label: 'Verifications', value: String(totals.verifications), small: true })}
</div>

<section class="section">
  ${sectionHeader('Recent settlements', button({ label: 'All settlements', href: '/app/settlements', variant: 'outline', small: true }))}
  ${settlementTable(recent)}
</section>`,
  });
}

// ── Settlements ─────────────────────────────────────────────────────────────

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
<thead><tr><th>Settlement</th><th>Canonical state</th><th>Verifier</th><th>Generation</th><th></th></tr></thead>
<tbody>${rows
      .map(
        (row) => `<tr>
<td class="mono"><a href="/app/settlements/${esc(row.settlementId)}">${esc(truncate(row.settlementId))}</a></td>
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
  if (deployment === undefined) {
    return shell({
      title: 'New settlement',
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

  const STEPS = ['Terms', 'Compliance', 'Signatures', 'Prepare', 'Finality', 'Commit', 'Execute'];

  return shell({
    title: 'New settlement',
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
        ${input({ name: 'cashReceiver', label: 'Cash receiver', placeholder: '0x…', mono: true })}
      </div>
      <div class="stack-16">
        <div class="t-caption-upper">Asset leg — Base Sepolia</div>
        ${input({ name: 'assetAmount', label: 'Amount (cBOND)', placeholder: '0.500000', mono: true })}
        ${input({ name: 'assetSeller', label: 'Seller', placeholder: '0x…', mono: true })}
        ${input({ name: 'assetReceiver', label: 'Asset receiver', placeholder: '0x…', mono: true })}
      </div>
    </div>
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

  <!-- 4-7 are the settlement workspace, which takes over once signatures exist -->
  <section data-step hidden class="section"></section>
  <section data-step hidden class="section"></section>
  <section data-step hidden class="section"></section>
  <section data-step hidden class="section"></section>
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
  return shell({
    title: `Settlement ${truncate(view.settlementId)}`,
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
<div class="mono muted" style="margin-top:var(--spacing-8);word-break:break-all;font-size:13px">${esc(view.settlementId)}</div>`,
      actions: `${button({ label: 'Evidence', href: `/evidence/${view.settlementId}`, variant: 'outline', small: true })}${button({ label: 'Verify', href: `/verify/${view.settlementId}`, small: true })}`,
    })}

${workspace === undefined ? '' : workspaceMount(workspace)}

<section class="section">
  ${sectionHeader('What the state means')}
  ${stateExplainer(view.canonicalState, view.verifierClass)}
</section>

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
  ${sectionHeader('Lifecycle')}
  ${card(settlementTimeline(view))}
</section>

<div class="section grid-2" style="align-items:start">
  ${cardWithHeader('Compliance', complianceTimeline(view.compliance))}
  ${cardWithHeader('Conservation', conservationBreakdown(view.conservation))}
</div>

<section class="section">
  ${sectionHeader('Cross-chain messages')}
  ${card(messageRoute(view.messages), { flush: false })}
</section>

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
    current: '/app/settlements',
    generation,
    body: `${pageHeader({
      title: 'Settlement request',
      trail: [
        { label: 'Conduit', href: '/app' },
        { label: 'Settlements', href: '/app/settlements' },
        { label: 'Sign' },
      ],
      meta: `<div class="mono muted" style="margin-top:var(--spacing-4);word-break:break-all;font-size:13px">${esc(settlementId)}</div>`,
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
      <span data-wallet-control></span>
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
<div class="note">A verification is a claim about a settlement under one deployment generation. A generation-1 settlement stays verifiable against generation-1 contracts forever, and the current generation cannot answer for it.</div>`)}`,
  });
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
    current: '/app/verifier',
    generation,
    body: `${pageHeader({
      title: 'Verification',
      trail: [
        { label: 'Conduit', href: '/app' },
        { label: 'Verifier', href: '/app/verifier' },
        { label: truncate(settlementId, 8, 6) },
      ],
      meta: `<div class="mono muted" style="margin-top:var(--spacing-4);word-break:break-all;font-size:13px">${esc(settlementId)}</div>`,
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
<td class="mono muted" style="font-size:13px">${esc(truncate(run.deploymentId, 10, 4))}</td>
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
<td class="mono" style="font-size:13px">${esc(truncate(manifest.deploymentId, 10, 6))}</td>
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

  return shell({
    title: `Evidence ${truncate(settlementId)}`,
    current: '/app/evidence',
    generation,
    body: `${pageHeader({
      title: 'Evidence',
      trail: [
        { label: 'Conduit', href: '/app' },
        { label: 'Evidence', href: '/app/evidence' },
        { label: truncate(settlementId, 8, 6) },
      ],
      meta: `<div class="mono muted" style="margin-top:var(--spacing-4);word-break:break-all;font-size:13px">${esc(settlementId)}</div>`,
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
    current: '/app/deployments',
    generation,
    body: `${pageHeader({
      title: 'Deployments',
      trail: [{ label: 'Conduit', href: '/app' }, { label: 'Deployments' }],
      caption:
        'Core contracts are non-upgradeable, so a new version is a new generation. Each one stays verifiable for the settlements it knows.',
    })}
<div class="stack-16">${rows
      .map((row) =>
        cardWithHeader(
          `Generation ${String(row.generation)}`,
          `<table class="kv">
<tr><td>Deployment</td><td class="mono" style="word-break:break-all">${esc(row.deploymentId)}</td></tr>
<tr><td>Commit</td><td class="mono">${esc(row.gitCommit)}</td></tr>
<tr><td>solc</td><td class="mono">${esc(row.solcVersion)}</td></tr>
<tr><td>Superseded by</td><td class="mono">${row.supersededBy === undefined ? '—' : esc(truncate(row.supersededBy))}</td></tr>
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
<tr><td>Deployment</td><td class="mono" style="word-break:break-all">${esc(env.deploymentId)}</td></tr>
<tr><td>Build</td><td class="mono">${esc(env.commit)}</td></tr>
<tr><td>Surface</td><td>read-only</td></tr>
</table>`,
)}
${cardWithHeader(
  'Trust boundary',
  `<p class="muted">This console holds no key, exposes no write path, and cannot authorise anything. Its database is a projection: convenient, and never evidence. A reader who wants proof should run the verifier against the chains.</p>
<div class="note">Application database state never authorizes value movement.</div>`,
)}
</div>`,
  });
}

// ── Errors ──────────────────────────────────────────────────────────────────

export function renderNotFound(what: string, detail: string): string {
  return document_(
    'Not found',
    `<div class="landing"><nav class="landing-nav">${wordmark()}${button({ label: 'Console', href: '/app', variant: 'outline', small: true })}</nav>
<div style="padding:80px 0">${card(emptyState(what, detail, button({ label: 'Back to settlements', href: '/app/settlements', variant: 'outline', small: true })))}</div></div>`,
  );
}

export function renderError(detail: string): string {
  return document_(
    'Error',
    `<div class="landing"><nav class="landing-nav">${wordmark()}</nav>
<div style="padding:80px 0">${card(errorState('Something failed on this request', detail))}</div></div>`,
  );
}

export { breadcrumb };
