/**
 * Server-rendered pages for the settlement console and the public proof view.
 *
 * ## Why this is a Worker and not Next.js
 *
 * PRD 11 asks for OpenNext on Cloudflare. There is no `design.md` yet, so the
 * visual language is a `HUMAN_GATE_DESIGN` deliverable and everything built now
 * is a data-flow skeleton whichever framework renders it. Given that, a Worker
 * that renders HTML directly gets every route, loader, view model and error
 * state working today with no build step to fail, and swapping the presentation
 * layer later changes markup rather than architecture.
 *
 * This is a deliberate substitution and it is recorded rather than quietly made.
 * What would be lost by keeping it: client-side routing, React state, and
 * incremental rendering. None of those is load-bearing for a page whose entire
 * job is to display what two chains say.
 *
 * ## The one rule the markup has to obey
 *
 * `HELD` must never look like a failure. It is committed value awaiting a
 * lawful resolution — the cash has moved, the counterparty is owed an asset,
 * and no refund exists. A red "failed" badge would tell a reader the opposite
 * of the truth about their money. It gets its own treatment, its own wording,
 * and an explicit sentence saying no refund is possible.
 */

export interface SettlementView {
  readonly settlementId: string;
  readonly deploymentId: string;
  readonly generation: number;
  readonly canonicalState: string;
  readonly decision: string;
  readonly verifierClass: string | undefined;
  readonly cash: LegView;
  readonly asset: LegView;
  readonly messages: readonly MessageView[];
  readonly compliance: readonly ComplianceView[];
  readonly disposition: DispositionView | undefined;
  readonly conservation: readonly [string, string][];
}

export interface LegView {
  readonly chain: string;
  readonly chainId: number;
  readonly asset: string;
  readonly assetSymbol: string;
  readonly amount: string;
  readonly outcome: string;
  readonly counterparty: string;
}

export interface MessageView {
  readonly messageType: string;
  readonly sequence: string;
  readonly finality: string;
  readonly emitter: string;
  readonly wormholeChainId: number;
  readonly consumed: boolean;
  readonly finalitySeconds: number | undefined;
}

export interface ComplianceView {
  readonly subject: string;
  readonly eligible: boolean;
  readonly at: string;
  readonly source: string;
  readonly evidenceHash: string;
}

export interface DispositionView {
  readonly caseId: string;
  readonly leg: string;
  readonly state: string;
  readonly dispositionType: string | undefined;
  readonly destination: string | undefined;
  readonly authorities: readonly { address: string; authorityType: string }[];
  readonly policyHash: string;
}

/**
 * How each state should read to somebody looking at their own money.
 *
 * `tone` drives colour and nothing else. The sentence is what actually
 * communicates, and `HELD` gets the longest one because it is the state most
 * likely to be misread.
 */
export const STATE_MEANING: Readonly<
  Record<string, { tone: 'settled' | 'held' | 'progress' | 'contested' | 'ended'; says: string }>
> = Object.freeze({
  NONE: { tone: 'progress', says: 'No settlement with this identifier has been prepared.' },
  CASH_PREPARED: { tone: 'progress', says: 'Cash is locked. Waiting on the asset leg.' },
  ASSET_PREPARED: { tone: 'progress', says: 'The asset is reserved. Waiting on the cash leg.' },
  READY: {
    tone: 'progress',
    says: 'Both legs are prepared. Commitment waits on economic finality and a fresh compliance answer.',
  },
  COMMIT_ISSUED: {
    tone: 'progress',
    says: 'Committed. From here there is no refund — both legs execute or the value is held.',
  },
  ABORT_ISSUED: {
    tone: 'ended',
    says: 'Aborted before commitment. Both legs return to their owners.',
  },
  SETTLED: { tone: 'settled', says: 'Both legs executed. The trade is complete.' },
  ABORTED: { tone: 'ended', says: 'Returned to both parties. Nothing moved between them.' },
  HELD: {
    tone: 'held',
    says:
      'Committed value awaiting a lawful resolution. One leg executed and the other cannot be ' +
      'delivered under current compliance rules. This is not a failure and not a refund: the ' +
      'commitment stands, the value is accounted for, and it moves only through an authorised ' +
      'disposition.',
  },
  CONTESTED: {
    tone: 'contested',
    says:
      'Two authorised parties have proposed different resolutions. Nothing moves until the ' +
      'authority policy resolves the conflict.',
  },
});

/**
 * The verifier's own classifications, kept visually distinct from chain state.
 *
 * ADR-0017: `SETTLED` is a Solidity enum and `SETTLED_FINAL` is a conclusion
 * this software drew. A page that rendered them in the same badge would erase
 * the difference for every reader.
 */
export const CLASS_MEANING: Readonly<Record<string, string>> = Object.freeze({
  SETTLED_FINAL: 'Independently verified: both legs delivered to the parties the intent named.',
  DISPOSITION_FINAL:
    'Independently verified: terminal through an authorised disposition, not through ordinary delivery.',
  RESTRICTED_HOLD_FINAL:
    'Independently verified: terminal in registered restricted custody. No party to the trade received the value.',
  CONTESTED: 'Two authorised orders disagree. Nothing may move until the policy resolves it.',
  HELD_PENDING_DISPOSITION: 'Committed and undelivered, with no disposition resolving it yet.',
  SETTLED_PENDING_VERIFICATION:
    'The coordinator reports SETTLED, but at least one independent check did not pass.',
  NOT_SETTLED: 'The coordinator’s own state is not SETTLED.',
});

const escape = (value: unknown): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const short = (value: string): string =>
  value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;

/**
 * Unstyled beyond legibility, on purpose.
 *
 * There is no `design.md`, so inventing a visual language now would be
 * inventing something a designer has to undo. What is here is structure,
 * hierarchy and the one semantic distinction that cannot wait for design: the
 * four state tones.
 */
const STYLE = `
:root{--bg:#0b0d10;--fg:#e6e9ef;--dim:#8b93a1;--line:#1d2229;--card:#11151a;
--settled:#3fb950;--held:#d29922;--progress:#58a6ff;--contested:#db6d28;--ended:#8b949e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}
a{color:var(--progress);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:32px 20px 96px}
header{border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:28px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:32px 0 12px;font-weight:600}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:12px}
.badge{display:inline-block;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:600;letter-spacing:.02em}
.settled{background:rgba(63,185,80,.14);color:var(--settled);border:1px solid rgba(63,185,80,.3)}
.held{background:rgba(210,153,34,.14);color:var(--held);border:1px solid rgba(210,153,34,.35)}
.progress{background:rgba(88,166,255,.12);color:var(--progress);border:1px solid rgba(88,166,255,.3)}
.contested{background:rgba(219,109,40,.14);color:var(--contested);border:1px solid rgba(219,109,40,.35)}
.ended{background:rgba(139,148,158,.12);color:var(--ended);border:1px solid rgba(139,148,158,.3)}
.says{margin-top:10px;color:var(--dim);max-width:62ch}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:500;padding:6px 10px 6px 0;border-bottom:1px solid var(--line)}
td{padding:8px 10px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}
.k{color:var(--dim);width:38%}
.note{border-left:2px solid var(--held);padding-left:12px;color:var(--dim);margin:16px 0}
form{display:flex;gap:8px;margin:20px 0}
input{flex:1;background:var(--card);border:1px solid var(--line);color:var(--fg);padding:10px 12px;border-radius:6px;font-family:ui-monospace,monospace;font-size:13px}
button{background:var(--progress);color:#0b0d10;border:0;padding:10px 18px;border-radius:6px;font-weight:600;cursor:pointer}
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} — Conduit</title><style>${STYLE}</style></head>
<body><div class="wrap"><header>
<h1><a href="/">Conduit</a></h1>
<div class="mono" style="color:var(--dim)">Cross-chain delivery-versus-payment for Cleanverse-native assets. The assets never bridge.</div>
</header>${body}</div></body></html>`;
}

export function stateBadge(state: string): string {
  const meaning = STATE_MEANING[state] ?? { tone: 'progress' as const, says: '' };
  return `<span class="badge ${meaning.tone}">${escape(state)}</span>`;
}

export function renderHome(recent: readonly SettlementView[]): string {
  const rows =
    recent.length === 0
      ? '<tr><td colspan="4" style="color:var(--dim)">No settlements indexed yet.</td></tr>'
      : recent
          .map(
            (settlement) => `<tr>
<td class="mono"><a href="/settlements/${escape(settlement.settlementId)}">${escape(short(settlement.settlementId))}</a></td>
<td>${stateBadge(settlement.canonicalState)}</td>
<td class="mono" style="color:var(--dim)">${escape(settlement.verifierClass ?? 'not verified')}</td>
<td class="mono" style="color:var(--dim)">gen ${escape(settlement.generation)}</td></tr>`,
          )
          .join('');

  return page(
    'Settlements',
    `<p style="max-width:64ch">A restricted RWA on Base and a Cleanverse settlement unit on Monad move under one
signed intent. Neither asset crosses a chain. What crosses is authenticated settlement
state, and commitment becomes irreversible only after economic finality and a fresh
compliance answer.</p>

<form action="/verify" method="get">
  <input name="id" placeholder="0x… settlement id" pattern="0x[0-9a-fA-F]{64}" required>
  <button type="submit">Verify</button>
</form>

<h2>Settlements</h2>
<div class="card"><table>
<tr><th>Settlement</th><th>Canonical state</th><th>Verifier</th><th>Generation</th></tr>
${rows}</table></div>

<h2>What the states mean</h2>
<div class="card">
${Object.entries(STATE_MEANING)
  .filter(([name]) => ['SETTLED', 'HELD', 'CONTESTED'].includes(name))
  .map(
    ([name, meaning]) =>
      `<div style="margin-bottom:14px">${stateBadge(name)}<div class="says">${escape(meaning.says)}</div></div>`,
  )
  .join('')}
</div>`,
  );
}

export function renderSettlement(view: SettlementView): string {
  const meaning = STATE_MEANING[view.canonicalState] ?? { tone: 'progress' as const, says: '' };

  const leg = (name: string, value: LegView) => `<div class="card">
<h2 style="margin-top:0">${escape(name)}</h2>
<table>
<tr><td class="k">chain</td><td class="mono">${escape(value.chain)} · ${escape(value.chainId)}</td></tr>
<tr><td class="k">asset</td><td class="mono">${escape(value.assetSymbol)} ${escape(short(value.asset))}</td></tr>
<tr><td class="k">amount</td><td class="mono">${escape(value.amount)}</td></tr>
<tr><td class="k">counterparty</td><td class="mono">${escape(short(value.counterparty))}</td></tr>
<tr><td class="k">outcome</td><td>${stateBadge(value.outcome)}</td></tr>
</table></div>`;

  const messages = view.messages
    .map(
      (message) => `<tr>
<td class="mono">${escape(message.messageType)}</td>
<td class="mono">${escape(message.sequence)}</td>
<td><span class="badge ${message.finality === 'FINALIZED' ? 'settled' : 'held'}">${escape(message.finality)}</span></td>
<td class="mono" style="color:var(--dim)">${message.finalitySeconds === undefined ? '—' : `${escape(message.finalitySeconds)}s`}</td>
<td>${message.consumed ? 'consumed' : '<span style="color:var(--dim)">not consumed</span>'}</td></tr>`,
    )
    .join('');

  const compliance = view.compliance
    .map(
      (entry) => `<tr>
<td class="mono">${escape(short(entry.subject))}</td>
<td><span class="badge ${entry.eligible ? 'settled' : 'held'}">${entry.eligible ? 'eligible' : 'refused'}</span></td>
<td class="mono" style="color:var(--dim)">${escape(entry.source)}</td>
<td class="mono" style="color:var(--dim)">${escape(short(entry.evidenceHash))}</td></tr>`,
    )
    .join('');

  return page(
    `Settlement ${short(view.settlementId)}`,
    `<div class="mono" style="color:var(--dim);word-break:break-all">${escape(view.settlementId)}</div>

<div class="card" style="margin-top:16px">
  ${stateBadge(view.canonicalState)}
  <span class="mono" style="color:var(--dim);margin-left:10px">canonical, read from the coordinator</span>
  <div class="says">${escape(meaning.says)}</div>
  ${
    view.verifierClass === undefined
      ? ''
      : `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
<span class="badge progress">${escape(view.verifierClass)}</span>
<span class="mono" style="color:var(--dim);margin-left:10px">derived by the verifier, not an on-chain value</span>
<div class="says">${escape(CLASS_MEANING[view.verifierClass] ?? '')}</div></div>`
  }
</div>

<div class="grid">${leg('Cash leg', view.cash)}${leg('Asset leg', view.asset)}</div>

<h2>Cross-chain messages</h2>
<div class="card"><table>
<tr><th>Type</th><th>Seq</th><th>Finality</th><th>Observed</th><th>Destination</th></tr>
${messages || '<tr><td colspan="5" style="color:var(--dim)">none found in the searched range</td></tr>'}
</table>
<div class="note">Finality is classified, never compared as a number. Wormhole encodes 200 as instant
and 201 as safe; everything else is finalized. Ranking the raw byte would place instant above
finalized, which is the substitution a settlement layer cannot afford.</div>
</div>

<h2>Compliance</h2>
<div class="card"><table>
<tr><th>Subject</th><th>Answer</th><th>Source</th><th>Evidence</th></tr>
${compliance || '<tr><td colspan="4" style="color:var(--dim)">none recorded</td></tr>'}
</table>
<div class="note">Attestations expire after 900 seconds, fixed in the deployed bytecode. Observed Base
finality on this deployment has run 999 to 1485 seconds — so a prepare-time answer cannot reach a
commit, and the answer that authorises it is minted after the wait.</div>
</div>

${view.disposition === undefined ? '' : renderDispositionCard(view.disposition)}

<h2>Conservation</h2>
<div class="card"><table>
${view.conservation.map(([k, v]) => `<tr><td class="k">${escape(k)}</td><td class="mono">${escape(v)}</td></tr>`).join('')}
</table></div>

<p style="margin-top:24px"><a href="/verify/${escape(view.settlementId)}">Verify independently</a> ·
<a href="/evidence/${escape(view.settlementId)}">Evidence manifest</a></p>`,
  );
}

export function renderDispositionCard(disposition: DispositionView): string {
  return `<h2>Disposition</h2>
<div class="card">
<table>
<tr><td class="k">case</td><td class="mono">${escape(short(disposition.caseId))}</td></tr>
<tr><td class="k">leg</td><td class="mono">${escape(disposition.leg)}</td></tr>
<tr><td class="k">case state</td><td><span class="badge ${disposition.state === 'CONTESTED' ? 'contested' : disposition.state === 'EXECUTED' ? 'settled' : 'progress'}">${escape(disposition.state)}</span>
<span class="mono" style="color:var(--dim);margin-left:8px">on-chain enum</span></td></tr>
${disposition.dispositionType === undefined ? '' : `<tr><td class="k">order type</td><td class="mono">${escape(disposition.dispositionType)}</td></tr>`}
${disposition.destination === undefined ? '' : `<tr><td class="k">destination</td><td class="mono">${escape(short(disposition.destination))}</td></tr>`}
<tr><td class="k">authorities</td><td class="mono">${disposition.authorities.map((a) => `${escape(short(a.address))} <span style="color:var(--dim)">${escape(a.authorityType)}</span>`).join('<br>') || '—'}</td></tr>
<tr><td class="k">policy</td><td class="mono">${escape(short(disposition.policyHash))}</td></tr>
</table>
<div class="note">A filed order rests for the policy's contest window before it can execute. Without that
wait, whichever relayer submitted first would decide the outcome, and two authorities who genuinely
disagree would be adjudicated by gas price.</div>
</div>`;
}

export function renderVerification(
  settlementId: string,
  result: {
    classification: string;
    findings: readonly { check: string; ok: boolean; detail: string }[];
    hadScanGap: boolean;
    searchedRanges: Readonly<Record<string, { from: string; to: string }>>;
    trustRoot: string;
  },
): string {
  const failed = result.findings.filter((finding) => !finding.ok);

  return page(
    `Verification ${short(settlementId)}`,
    `<div class="mono" style="color:var(--dim);word-break:break-all">${escape(settlementId)}</div>

<div class="card" style="margin-top:16px">
${
  result.hadScanGap
    ? `<span class="badge contested">INCOMPLETE</span>
<div class="says">Part of the history could not be read. An RPC scan gap is not a verdict: "no
messages found" and "no messages exist" are different answers, and only one of them is a
finding. Widen the search window before drawing a conclusion.</div>`
    : `<span class="badge ${result.classification.endsWith('_FINAL') ? 'settled' : 'held'}">${escape(result.classification)}</span>
<div class="says">${escape(CLASS_MEANING[result.classification] ?? '')}</div>`
}
</div>

<h2>Checks — ${escape(result.findings.length - failed.length)} of ${escape(result.findings.length)} passed</h2>
<div class="card"><table>
${result.findings
  .map(
    (
      finding,
    ) => `<tr><td style="width:24px">${finding.ok ? '<span style="color:var(--settled)">✓</span>' : '<span style="color:var(--contested)">✗</span>'}</td>
<td>${escape(finding.check)}<div class="mono" style="color:var(--dim);font-size:12px">${escape(finding.detail)}</div></td></tr>`,
  )
  .join('')}
</table></div>

<h2>What was searched</h2>
<div class="card"><table>
${Object.entries(result.searchedRanges)
  .map(
    ([chainId, range]) =>
      `<tr><td class="k">chain ${escape(chainId)}</td><td class="mono">${escape(range.from)} – ${escape(range.to)}</td></tr>`,
  )
  .join('')}
</table>
<div class="note">${escape(result.trustRoot)}</div>
</div>`,
  );
}

export function renderNotFound(what: string, detail: string): string {
  return page(
    'Not found',
    `<div class="card"><span class="badge ended">NOT FOUND</span>
<div class="says">${escape(what)}</div>
<div class="note">${escape(detail)}</div></div>`,
  );
}
