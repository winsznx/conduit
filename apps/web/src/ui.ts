/**
 * Primitives. Every one derives from `theme.ts`, which derives from `design.md`.
 *
 * These functions return HTML strings and take no styling arguments on purpose.
 * A caller cannot pass a colour or a radius, so a route physically cannot drift
 * from the system — the only way to change how a button looks is to change the
 * button.
 */

/** HTML-escape. Every interpolated value in this app goes through it. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Drops falsy branches so callers can write `cx('a', cond && 'b')`. */
export function cx(...parts: readonly (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ── Icons ───────────────────────────────────────────────────────────────────
//
// Thin-stroke geometric marks at 1.5px, inline so the CSP never has to allow an
// external origin. `currentColor` keeps them achromatic by inheritance.

const ICONS: Readonly<Record<string, string>> = Object.freeze({
  overview: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/>',
  settlements: '<path d="M3 6h18M3 12h18M3 18h12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  disposition: '<path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/>',
  verify: '<path d="M20 6L9 17l-5-5"/>',
  evidence:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  deployments: '<path d="M21 16V8l-9-5-9 5v8l9 5z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
  system:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  cross: '<path d="M18 6L6 18M6 6l12 12"/>',
  alert:
    '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
});

export function icon(name: string, size = 16): string {
  const path = ICONS[name];
  if (path === undefined) return '';
  return `<svg width="${String(size)}" height="${String(size)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

// ── Button ──────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'destructive';

export function button(options: {
  readonly label: string;
  readonly href?: string;
  readonly variant?: ButtonVariant;
  readonly small?: boolean;
  readonly type?: 'submit' | 'button';
  readonly iconName?: string;
}): string {
  const cls = cx('btn', `btn-${options.variant ?? 'primary'}`, options.small === true && 'btn-sm');
  const inner = `${options.iconName === undefined ? '' : icon(options.iconName, options.small === true ? 13 : 15)}<span>${esc(options.label)}</span>`;
  if (options.href !== undefined) {
    return `<a class="${cls}" href="${esc(options.href)}">${inner}</a>`;
  }
  return `<button class="${cls}" type="${options.type ?? 'button'}">${inner}</button>`;
}

// ── Input ───────────────────────────────────────────────────────────────────

export function input(options: {
  readonly name: string;
  readonly placeholder?: string;
  readonly label?: string;
  readonly mono?: boolean;
  readonly pattern?: string;
  readonly required?: boolean;
  readonly value?: string;
  readonly hint?: string;
}): string {
  const id = `f-${options.name}`;
  const field = `<input class="${cx('field', options.mono === true && 'field-mono')}" id="${esc(id)}" name="${esc(options.name)}"${options.placeholder === undefined ? '' : ` placeholder="${esc(options.placeholder)}"`}${options.pattern === undefined ? '' : ` pattern="${esc(options.pattern)}"`}${options.required === true ? ' required' : ''}${options.value === undefined ? '' : ` value="${esc(options.value)}"`}>`;
  if (options.label === undefined) return field;
  return `<div><label class="label t-caption-upper" for="${esc(id)}">${esc(options.label)}</label>${field}${options.hint === undefined ? '' : `<div class="t-caption muted" style="margin-top:var(--spacing-4)">${esc(options.hint)}</div>`}</div>`;
}

// ── Badge ───────────────────────────────────────────────────────────────────

export type BadgeVariant = 'solid' | 'soft' | 'outline' | 'ember';

export function badge(label: string, variant: BadgeVariant = 'soft', withDot = false): string {
  return `<span class="${cx('badge', `badge-${variant}`)}">${withDot ? '<span class="dot"></span>' : ''}${esc(label)}</span>`;
}

/**
 * State to badge variant.
 *
 * The whole point of this map is what it refuses to do. `HELD` is committed
 * value awaiting a lawful resolution, `CONTESTED` is two authorities
 * disagreeing, and waiting on finality is the protocol working correctly. None
 * of them is an error, so none of them gets Ember. Terminal states are solid,
 * states that need someone to act are soft with a dot, and everything in flight
 * is outline. Colour carries no meaning here; weight and fill do.
 */
export function stateVariant(state: string): BadgeVariant {
  switch (state) {
    case 'SETTLED':
    case 'SETTLED_FINAL':
    case 'DISPOSITION_FINAL':
    case 'RESTRICTED_HOLD_FINAL':
    case 'RELEASED':
    case 'EXECUTED':
    case 'FINALIZED':
      return 'solid';
    case 'HELD':
    case 'CONTESTED':
    case 'HELD_PENDING_DISPOSITION':
    case 'SETTLED_PENDING_VERIFICATION':
      return 'soft';
    default:
      return 'outline';
  }
}

/** Soft states carry a dot: something is open and someone has to act. */
export function stateBadge(state: string): string {
  const variant = stateVariant(state);
  return badge(state, variant, variant === 'soft');
}

// ── Card ────────────────────────────────────────────────────────────────────

export function card(body: string, options?: { readonly flush?: boolean }): string {
  return `<div class="${cx('card', options?.flush === true && 'card-flush')}">${body}</div>`;
}

export function cardWithHeader(title: string, body: string, action = ''): string {
  return card(
    `<div class="card-header"><div class="t-subheading">${esc(title)}</div>${action}</div><div class="card-body">${body}</div>`,
    { flush: true },
  );
}

// ── Headers ─────────────────────────────────────────────────────────────────

export function breadcrumb(trail: readonly { label: string; href?: string }[]): string {
  return `<nav class="crumb" aria-label="Breadcrumb">${trail
    .map((step, index) => {
      const last = index === trail.length - 1;
      const node =
        step.href === undefined || last
          ? `<span class="${last ? 'here' : ''}">${esc(step.label)}</span>`
          : `<a href="${esc(step.href)}">${esc(step.label)}</a>`;
      return index === 0 ? node : `<span class="sep">${icon('chevron', 13)}</span>${node}`;
    })
    .join('')}</nav>`;
}

export function pageHeader(options: {
  readonly title: string;
  readonly caption?: string;
  readonly trail?: readonly { label: string; href?: string }[];
  readonly actions?: string;
  readonly meta?: string;
}): string {
  return `<div class="page-head"><div style="min-width:0">
${options.trail === undefined ? '' : breadcrumb(options.trail)}
<h1 class="t-heading">${esc(options.title)}</h1>
${options.meta ?? ''}
${options.caption === undefined ? '' : `<p class="muted" style="margin-top:var(--spacing-8);max-width:68ch">${esc(options.caption)}</p>`}
</div>${options.actions === undefined ? '' : `<div class="actions">${options.actions}</div>`}</div>`;
}

export function sectionHeader(title: string, aside = ''): string {
  return `<div class="section-head"><h2 class="t-subheading">${esc(title)}</h2>${aside}</div>`;
}

// ── Stat block ──────────────────────────────────────────────────────────────

export function statBlock(options: {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly small?: boolean;
}): string {
  return `<div class="${cx('stat', options.small === true && 'stat-sm')}">
<div class="stat-label">${esc(options.label)}</div>
<div class="stat-value">${esc(options.value)}</div>
${options.note === undefined ? '' : `<div class="stat-note">${esc(options.note)}</div>`}
</div>`;
}

// ── Identity ────────────────────────────────────────────────────────────────

const CHAINS: Readonly<Record<number, { name: string; mark: string }>> = Object.freeze({
  10143: { name: 'Monad Testnet', mark: 'M' },
  84532: { name: 'Base Sepolia', mark: 'B' },
});

export function chainName(chainId: number): string {
  return CHAINS[chainId]?.name ?? `chain ${String(chainId)}`;
}

/**
 * A chain mark, because two different contracts in this deployment share the
 * same twenty bytes on different chains. Any address shown without its chain is
 * ambiguous, and the verifier treats that ambiguity as a finding.
 */
export function chainIdentity(chainId: number, options?: { readonly compact?: boolean }): string {
  const chain = CHAINS[chainId];
  const mark = `<span class="chain-mark">${esc(chain?.mark ?? '?')}</span>`;
  if (options?.compact === true) return mark;
  return `<span class="identity">${mark}<span>${esc(chain?.name ?? `chain ${String(chainId)}`)}</span></span>`;
}

export function assetIdentity(symbol: string, address: string, chainId: number): string {
  return `<span class="identity">${chainIdentity(chainId, { compact: true })}<span><span style="font-weight:var(--font-weight-medium)">${esc(symbol)}</span> <span class="mono muted" style="font-size:13px">${esc(truncate(address))}</span></span></span>`;
}

export function truncate(value: string, head = 10, tail = 6): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/**
 * An address is always chain-qualified and always carries its full value in
 * `title`, so the truncation is presentational and never destroys information.
 */
export function address(value: string, chainId?: number): string {
  const qualified = chainId === undefined ? value : `eip155:${String(chainId)}:${value}`;
  return `<span class="addr" title="${esc(qualified)}">${
    chainId === undefined ? '' : `<span class="chain">${esc(chainId)}</span>`
  }<span class="val">${esc(truncate(value))}</span></span>`;
}

// ── Empty, error, loading ───────────────────────────────────────────────────

export function emptyState(title: string, detail: string, action = ''): string {
  return `<div class="empty"><div class="empty-title">${esc(title)}</div><p style="max-width:52ch">${esc(detail)}</p>${action}</div>`;
}

/**
 * The one place Ember is allowed to carry meaning: something is actually wrong.
 */
export function errorState(title: string, detail: string): string {
  return `<div class="empty"><div style="color:var(--color-ember)">${icon('alert', 20)}</div><div class="empty-title">${esc(title)}</div><p style="max-width:56ch">${esc(detail)}</p></div>`;
}

export function skeleton(rows = 3): string {
  return `<div class="stack-12">${Array.from({ length: rows }, (_unused, index) => `<div class="skel" style="width:${String(100 - index * 12)}%"></div>`).join('')}</div>`;
}
