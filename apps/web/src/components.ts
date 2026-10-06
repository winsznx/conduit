/**
 * Conduit-specific components.
 *
 * These are the protocol's own vocabulary — legs, messages, finality,
 * conservation, disposition cases, verifier checks — expressed in the design
 * system rather than decorated on top of it. `design.md` says the UI components
 * are the visual content, so the diagrams here are built from cards, hairlines
 * and connectors instead of illustration.
 */

import { LOCKUP_INLINE } from './brand-manifest.js';
import {
  CLASS_MEANING,
  LIFECYCLE,
  STATE_MEANING,
  type ComplianceView,
  type DispositionView,
  type LegView,
  type MessageView,
  type SettlementView,
} from './domain.js';
import { evmChainFor } from './explorers.js';
import { HERO_INTRINSIC, IMAGES } from './image-manifest.js';
import {
  address,
  assetIdentity,
  badge,
  card,
  cardWithHeader,
  chainIdentity,
  cx,
  esc,
  icon,
  stateBadge,
  truncate,
  txHash,
  vaaLink,
} from './ui.js';

// ── Shell ───────────────────────────────────────────────────────────────────

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly iconName: string;
}

const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/app', label: 'Overview', iconName: 'overview' },
  { href: '/app/settlements', label: 'Settlements', iconName: 'settlements' },
  { href: '/app/settlements/new', label: 'New Settlement', iconName: 'plus' },
  { href: '/app/dispositions', label: 'Dispositions', iconName: 'disposition' },
  { href: '/app/verifier', label: 'Verifier', iconName: 'verify' },
  { href: '/app/evidence', label: 'Evidence', iconName: 'evidence' },
];

const SYSTEM_NAV: readonly NavItem[] = [
  { href: '/app/deployments', label: 'Deployments', iconName: 'deployments' },
  { href: '/app/system', label: 'System', iconName: 'system' },
];

function navList(items: readonly NavItem[], current: string): string {
  return items
    .map(
      (item) =>
        `<a href="${esc(item.href)}"${item.href === current ? ' aria-current="page"' : ''}>${icon(item.iconName, 15)}<span>${esc(item.label)}</span></a>`,
    )
    .join('');
}

/**
 * The wordmark, which is also the way home.
 *
 * `linked` is false only where it would point at the page you are already on,
 * the landing's own header and footer. Everywhere else the mark is what a
 * reader reaches for to get out of the console, and it was inert.
 *
 * The lockup is drawn inline, so it arrives with the document: no extra
 * request, nothing that can fail to load, and no intrinsic size, which leaves
 * each surface to set its own height in CSS. The accessible name sits on the
 * wrapper and the SVG is `aria-hidden`, so a screen reader announces "Conduit"
 * once, as a link or an image, and never reads the artwork as well.
 */
export function wordmark(linked = false): string {
  return linked
    ? `<a class="identity" href="/" aria-label="Conduit, back to the home page">${LOCKUP_INLINE}</a>`
    : `<span class="identity" role="img" aria-label="Conduit">${LOCKUP_INLINE}</span>`;
}

export function sidebar(current: string): string {
  return `<aside class="sidebar">
<div class="brand">${wordmark(true)}</div>
<nav class="nav" aria-label="Primary">${navList(PRIMARY_NAV, current)}</nav>
<nav class="nav" aria-label="System"><div class="nav-section">System</div>${navList(SYSTEM_NAV, current)}</nav>
<div class="sidebar-foot" data-identity-strip>
  <noscript><span class="t-caption muted">Wallet actions need JavaScript. Everything else on this page does not.</span></noscript>
</div>
</aside>`;
}

/**
 * The persistent top chrome.
 *
 * The participant control lives here, at the top right, on every application
 * route. It used to be primarily in the sidebar footer, which is where a
 * product puts something it does not expect anyone to need — and connecting a
 * wallet is the first thing a participant does.
 */
export function topBar(right = ''): string {
  return `<div class="topbar">
<form class="row" action="/verify" method="get" style="flex:1;max-width:420px;gap:var(--spacing-8)">
  <input class="field field-mono" name="id" placeholder="Verify a settlement id" pattern="0x[0-9a-fA-F]{64}" required aria-label="Settlement id">
  <button class="btn btn-secondary btn-sm" type="submit">Verify</button>
</form>
<div class="row">${right}<span data-participant></span></div>
</div>`;
}

// ── Cross-chain settlement diagram ──────────────────────────────────────────

/**
 * The two legs and the authenticated state between them.
 *
 * Deliberately not an infographic: white cards, hairline borders, black type,
 * grey metadata, a thin connector. The only thing that varies between legs is
 * the content.
 */
export function crossChainDiagram(view: SettlementView): string {
  const leg = (title: string, value: LegView) => `<div class="xchain-leg">
<div class="leg-chain">${chainIdentity(value.chainId)}</div>
<div class="t-caption-upper">${esc(title)}</div>
<div class="leg-amount">${esc(value.amount)}</div>
<div class="leg-asset">${esc(value.assetSymbol)}</div>
<div class="leg-state">${stateBadge(value.outcome)}</div>
</div>`;

  return `<div class="xchain">
${leg('Cash leg', view.cash)}
<div class="xchain-mid">
  <div class="connector"></div>
  <div class="label">authenticated state</div>
  ${badge(view.decision, 'outline')}
  <div class="connector"></div>
</div>
${leg('Asset leg', view.asset)}
</div>
<div class="note">Neither asset crosses a chain. What crosses is authenticated settlement state, and the two contracts that carry it share the same twenty bytes on different chains — which is why every address on this page is chain-qualified.</div>`;
}

// ── Settlement timeline ─────────────────────────────────────────────────────

function reachedStages(view: SettlementView): number {
  if (view.canonicalState === 'SETTLED' || view.canonicalState === 'HELD') return 5;
  if (view.canonicalState === 'COMMIT_ISSUED') return 4;
  if (view.canonicalState === 'READY') return 2;
  if (view.canonicalState === 'NONE') return 0;
  return 1;
}

export function settlementTimeline(view: SettlementView): string {
  const reached = reachedStages(view);
  return `<div class="timeline">${LIFECYCLE.map((stage, index) => {
    const done = index < reached;
    return `<div class="tl-item">
<div class="tl-rail"><span class="${cx('tl-node', done ? 'done' : 'pending')}"></span><span class="tl-line"></span></div>
<div class="tl-body">
  <div class="${cx('tl-title', !done && 'muted')}">${esc(stage.title)}</div>
  <div class="tl-meta">${esc(stage.detail)}</div>
</div></div>`;
  }).join('')}</div>`;
}

// ── Finality progress ───────────────────────────────────────────────────────

/**
 * Finality is classified, never ranked by its raw byte. The meter shows how far
 * an observed wait ran against the slowest wait this deployment has recorded,
 * and says so — it is not a prediction.
 */
export function finalityProgress(seconds: number | undefined, worstObserved = 1485): string {
  if (seconds === undefined) {
    return `<div class="t-caption muted">no signature timing stored</div>`;
  }
  const pct = Math.max(4, Math.min(100, Math.round((seconds / worstObserved) * 100)));
  return `<div><div class="row-between"><span class="mono t-caption">${esc(seconds)}s</span><span class="t-caption muted">of ${esc(worstObserved)}s slowest observed</span></div><div class="meter"><span style="width:${String(pct)}%"></span></div></div>`;
}

// ── Legs ────────────────────────────────────────────────────────────────────

export function settlementLegCard(title: string, value: LegView): string {
  return cardWithHeader(
    title,
    `<table class="kv">
<tr><td>Chain</td><td>${chainIdentity(value.chainId)}</td></tr>
<tr><td>Asset</td><td>${assetIdentity(value.assetSymbol, value.asset, value.chainId)}</td></tr>
<tr><td>Amount</td><td class="mono">${esc(value.amount)}</td></tr>
<tr><td>Counterparty</td><td>${address(value.counterparty, value.chainId)}</td></tr>
<tr><td>Outcome</td><td>${stateBadge(value.outcome)}</td></tr>
</table>`,
    stateBadge(value.outcome),
  );
}

/**
 * The hero artwork: two settlement legs and the authenticated link between them.
 *
 * Decorative, so `alt` is empty. It restates the sentence beside it and carries
 * nothing a reader would miss, and an alt text that narrated it would make a
 * screen reader read the headline twice.
 *
 * ## Why `<picture>` and not one file
 *
 * The artwork is a smooth gradient against transparency at 1440×448. As a PNG
 * that is 137kb at the fallback width alone; as AVIF it is 24kb at full width.
 * Every browser that matters reads at least WebP, so the PNG exists as the last
 * resort and is never the one a modern browser downloads.
 *
 * `sizes` describes the layout rather than the file: 45% of the content column
 * on desktop, 38% on tablet, and the full column below the CTA on a phone. The
 * intrinsic `width` and `height` are the crop's, so the browser reserves the
 * right box before a byte of image arrives and the hero does not shift.
 */
export function heroArtwork(): string {
  const set = (extension: 'avif' | 'webp'): string =>
    HERO_WIDTHS.map((width) => {
      const asset = IMAGES[`hero-${String(width)}.${extension}`];
      return asset === undefined ? '' : `${asset.path} ${String(width)}w`;
    })
      .filter((entry) => entry !== '')
      .join(', ');

  const fallback = IMAGES['hero-840.png'];

  return `<div class="hero-art">
<picture>
<source type="image/avif" srcset="${esc(set('avif'))}" sizes="${esc(HERO_SIZES)}">
<source type="image/webp" srcset="${esc(set('webp'))}" sizes="${esc(HERO_SIZES)}">
<img src="${esc(fallback?.path ?? '')}" alt="" width="${String(HERO_INTRINSIC.width)}" height="${String(HERO_INTRINSIC.height)}" decoding="async" fetchpriority="high">
</picture>
</div>`;
}

const HERO_WIDTHS = [560, 840, 1120, 1440] as const;

/**
 * What the layout will actually ask for, in the order the browser tests it.
 *
 * A 390px phone at 3x wants 1026 device pixels and gets the 1120; a 1440 desktop
 * at 2x wants 1108 and gets the same file. Nothing downloads the 1440 unless the
 * display genuinely resolves it.
 */
const HERO_SIZES =
  '(max-width: 768px) calc(100vw - 48px), (max-width: 1024px) 52vw, min(53vw, 652px)';

/** The `<link rel=preload>` for the hero, which is the landing page's LCP element. */
export function heroPreload(): string {
  const set = HERO_WIDTHS.map((width) => {
    const asset = IMAGES[`hero-${String(width)}.avif`];
    return asset === undefined ? '' : `${asset.path} ${String(width)}w`;
  })
    .filter((entry) => entry !== '')
    .join(', ');
  return `<link rel="preload" as="image" type="image/avif" imagesrcset="${esc(set)}" imagesizes="${esc(HERO_SIZES)}" fetchpriority="high">`;
}

// ── Messages ────────────────────────────────────────────────────────────────

export function messageRoute(messages: readonly MessageView[]): string {
  if (messages.length === 0) {
    return `<div class="empty"><p>No messages found in the searched range.</p></div>`;
  }
  const rows = messages
    .map((message) => {
      const evmChain = evmChainFor(message.wormholeChainId);
      // The emitter is an address on its own chain, so it links there. The
      // message itself links to the signed VAA, which is the artefact the
      // coordinator actually consumed.
      const emitter =
        evmChain === undefined
          ? `<span class="mono" style="font-size:13px">${esc(truncate(message.emitter, 8, 6))}</span>`
          : address(message.emitter, evmChain);
      return `<tr>
<td class="mono">${vaaLink(message.wormholeChainId, message.emitter, message.sequence, esc(message.messageType))}</td>
<td class="mono muted">${esc(message.sequence)}</td>
<td><span class="row">${evmChain === undefined ? '' : chainIdentity(evmChain, { compact: true })}${emitter}</span></td>
<td>${stateBadge(message.finality)}</td>
<td style="min-width:140px">${finalityProgress(message.finalitySeconds)}</td>
<td>${message.consumed ? badge('consumed once', 'outline') : '<span class="muted t-caption">not yet verified</span>'}</td>
<td class="mono">${
        message.publishedTxHash === ''
          ? '<span class="muted t-caption">not captured by the loader</span>'
          : txHash(message.publishedTxHash, message.publishedChainId)
      }</td>
</tr>`;
    })
    .join('');

  return `<div class="table-scroll"><table class="table table-hover">
<thead><tr><th>Type</th><th>Seq</th><th>Emitter</th><th>Finality</th><th>Guardians signed after</th><th>Consumption</th><th>Published in</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<div class="note">Finality is classified, never compared as a number. Wormhole encodes 200 as instant and 201 as safe; everything else is finalized. Ranking the raw byte would place instant above finalized, which is the substitution a settlement layer cannot afford.</div>`;
}

// ── Compliance ──────────────────────────────────────────────────────────────

export function complianceTimeline(entries: readonly ComplianceView[]): string {
  if (entries.length === 0) {
    return `<div class="empty"><p>The projection stores no Cleanverse answers for this settlement. That does not mean none were asked: the coordinator refuses a COMMIT without a valid compliance attestation, and the verifier checks the outcome from chain state.</p></div>`;
  }
  return `<div class="timeline">${entries
    .map(
      (entry) => `<div class="tl-item">
<div class="tl-rail"><span class="${cx('tl-node', entry.eligible && 'done')}"></span><span class="tl-line"></span></div>
<div class="tl-body">
  <div class="row-between">
    <span class="tl-title">${esc(entry.source)}</span>
    ${entry.eligible ? badge('eligible', 'outline') : badge('refused', 'soft', true)}
  </div>
  <div class="tl-meta">${esc(entry.at)} · ${esc(truncate(entry.evidenceHash, 10, 6))}</div>
</div></div>`,
    )
    .join('')}</div>
<div class="note">Attestations expire after 900 seconds, fixed in the deployed bytecode. Observed Base finality on this deployment has run 999 to 1485 seconds — so a prepare-time answer cannot reach a commit, and the answer that authorises it is minted after the wait.</div>`;
}

// ── Conservation ────────────────────────────────────────────────────────────

export function conservationBreakdown(rows: readonly [string, string][]): string {
  if (rows.length === 0) {
    return `<div class="empty"><p>The projection stores no conservation snapshot for this settlement. The verifier recomputes it from chain state: the escrow must account for exactly what it holds, and no reservation may stay open.</p></div>`;
  }
  return `<table class="kv">${rows
    .map(([key, value]) => `<tr><td>${esc(key)}</td><td class="mono">${esc(value)}</td></tr>`)
    .join('')}</table>`;
}

// ── Disposition ─────────────────────────────────────────────────────────────

export function dispositionCase(disposition: DispositionView): string {
  return `<table class="kv">
<tr><td>Case</td><td class="mono">${esc(truncate(disposition.caseId))}</td></tr>
<tr><td>Leg</td><td class="mono">${esc(disposition.leg)}</td></tr>
<tr><td>Case state</td><td>${stateBadge(disposition.state)} <span class="muted t-caption">on-chain enum</span></td></tr>
${disposition.dispositionType === undefined ? '' : `<tr><td>Order type</td><td class="mono">${esc(disposition.dispositionType)}</td></tr>`}
${disposition.destination === undefined ? '' : `<tr><td>Destination</td><td>${address(disposition.destination)}</td></tr>`}
<tr><td>Authorities</td><td>${
    disposition.authorities.length === 0
      ? '—'
      : disposition.authorities
          .map(
            (a) =>
              `<div class="row">${address(a.address)} ${badge(a.authorityType, 'outline')}</div>`,
          )
          .join('')
  }</td></tr>
<tr><td>Policy</td><td class="mono">${esc(truncate(disposition.policyHash))}</td></tr>
</table>
<div class="note">A filed order rests for the policy's contest window before it can execute. Without that wait, whichever relayer submitted first would decide the outcome, and two authorities who genuinely disagree would be adjudicated by gas price.</div>`;
}

// ── Verifier ────────────────────────────────────────────────────────────────

/**
 * A failed check is a real error, so it is the one place a check mark takes
 * Ember. A passing check is ink; the list is otherwise achromatic.
 */
export function verifierChecklist(
  findings: readonly { check: string; ok: boolean; detail: string }[],
): string {
  return `<ul class="stack-12">${findings
    .map(
      (finding) => `<li class="row" style="align-items:flex-start;gap:var(--spacing-12)">
<span style="flex:none;margin-top:2px;color:${finding.ok ? 'var(--color-ink)' : 'var(--color-ember)'}">${icon(finding.ok ? 'check' : 'cross', 15)}</span>
<span style="min-width:0"><span style="font-weight:var(--font-weight-medium)">${esc(finding.check)}</span>
<div class="t-caption muted mono" style="margin-top:2px;word-break:break-word">${esc(finding.detail)}</div></span>
</li>`,
    )
    .join('')}</ul>`;
}

// ── Evidence ────────────────────────────────────────────────────────────────

export function evidenceTimeline(
  items: readonly { label: string; detail: string; at: string }[],
): string {
  if (items.length === 0) {
    return `<div class="empty"><p>No evidence artifacts recorded for this settlement.</p></div>`;
  }
  return `<div class="timeline">${items
    .map(
      (item) => `<div class="tl-item">
<div class="tl-rail"><span class="tl-node done"></span><span class="tl-line"></span></div>
<div class="tl-body">
  <div class="tl-title">${esc(item.label)}</div>
  <div class="tl-meta mono">${esc(item.detail)}</div>
  <div class="tl-meta">${esc(item.at)}</div>
</div></div>`,
    )
    .join('')}</div>`;
}

// ── State explainer ─────────────────────────────────────────────────────────

export function stateExplainer(state: string, verifierClass: string | undefined): string {
  const says = STATE_MEANING[state]?.says ?? '';
  return card(`<div class="stack-12">
<div>
  <div class="row" style="gap:var(--spacing-12)">${stateBadge(state)}<span class="t-caption muted">canonical, read from the coordinator</span></div>
  ${says === '' ? '' : `<p class="muted" style="margin-top:var(--spacing-8);max-width:70ch">${esc(says)}</p>`}
</div>
${
  verifierClass === undefined
    ? ''
    : `<hr class="rule" style="margin:var(--spacing-4) 0">
<div>
  <div class="row" style="gap:var(--spacing-12)">${stateBadge(verifierClass)}<span class="t-caption muted">derived by the verifier, not an on-chain value</span></div>
  <p class="muted" style="margin-top:var(--spacing-8);max-width:70ch">${esc(CLASS_MEANING[verifierClass] ?? '')}</p>
</div>`
}
</div>`);
}
