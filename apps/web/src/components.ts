/**
 * Conduit-specific components.
 *
 * These are the protocol's own vocabulary — legs, messages, finality,
 * conservation, disposition cases, verifier checks — expressed in the design
 * system rather than decorated on top of it. `design.md` says the UI components
 * are the visual content, so the diagrams here are built from cards, hairlines
 * and connectors instead of illustration.
 */

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

export function wordmark(): string {
  // The one Ember mark in the chrome: a supporting graphic detail, which is the
  // role `design.md` gives it. It is not a status and not a brand fill.
  return `<span class="identity"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="0.5" y="0.5" width="15" height="15" rx="4.5" stroke="var(--color-ink)"/><circle cx="8" cy="8" r="2" fill="var(--color-ember)"/></svg><span style="font-weight:var(--font-weight-semibold)">Conduit</span></span>`;
}

export function sidebar(current: string, deployment: { generation: string }): string {
  return `<aside class="sidebar">
<div class="brand">${wordmark()}</div>
<nav class="nav" aria-label="Primary">${navList(PRIMARY_NAV, current)}</nav>
<nav class="nav" aria-label="System"><div class="nav-section">System</div>${navList(SYSTEM_NAV, current)}</nav>
<div class="sidebar-foot"><div class="t-caption muted">Deployment</div><div class="t-caption mono">${esc(deployment.generation)}</div></div>
</aside>`;
}

export function topBar(right = ''): string {
  return `<div class="topbar">
<form class="row" action="/verify" method="get" style="flex:1;max-width:420px;gap:var(--spacing-8)">
  <input class="field field-mono" name="id" placeholder="Verify a settlement id" pattern="0x[0-9a-fA-F]{64}" required aria-label="Settlement id">
  <button class="btn btn-secondary btn-sm" type="submit">Verify</button>
</form>
<div class="row">${right}</div>
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
    return `<div class="t-caption muted">not observed</div>`;
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

// ── Messages ────────────────────────────────────────────────────────────────

export function messageRoute(messages: readonly MessageView[]): string {
  if (messages.length === 0) {
    return `<div class="empty"><p>No messages found in the searched range.</p></div>`;
  }
  const rows = messages
    .map(
      (message) => `<tr>
<td class="mono">${esc(message.messageType)}</td>
<td class="mono muted">${esc(message.sequence)}</td>
<td>${chainIdentity(message.wormholeChainId === 10004 ? 84532 : 10143, { compact: true })} <span class="mono" style="font-size:13px">${esc(truncate(message.emitter, 8, 6))}</span></td>
<td>${stateBadge(message.finality)}</td>
<td style="min-width:140px">${finalityProgress(message.finalitySeconds)}</td>
<td>${message.consumed ? badge('consumed', 'outline') : '<span class="muted t-caption">no consumer</span>'}</td>
</tr>`,
    )
    .join('');

  return `<div class="table-scroll"><table class="table table-hover">
<thead><tr><th>Type</th><th>Seq</th><th>Emitter</th><th>Finality</th><th>Observed</th><th>Destination</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<div class="note">Finality is classified, never compared as a number. Wormhole encodes 200 as instant and 201 as safe; everything else is finalized. Ranking the raw byte would place instant above finalized, which is the substitution a settlement layer cannot afford.</div>`;
}

// ── Compliance ──────────────────────────────────────────────────────────────

export function complianceTimeline(entries: readonly ComplianceView[]): string {
  if (entries.length === 0) {
    return `<div class="empty"><p>No compliance answers recorded.</p></div>`;
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
    return `<div class="empty"><p>No conservation snapshot recorded.</p></div>`;
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
