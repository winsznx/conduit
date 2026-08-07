import { readText } from './repo.js';

/**
 * The PRD outranks this repository's code (CLAUDE.md source-of-truth order), so
 * documentation coverage is checked against the PRD text itself rather than
 * against a second hand-maintained list. A requirement added upstream fails the
 * gate until the docs catch up; a requirement restated here could silently
 * drift from it.
 */
const PRD = readText('CONDUIT_PRD_v1.0.md');

/**
 * `CONDUIT_PRD_v1.1_OVERRIDE.md` outranks v1.0 wherever the two conflict, so its
 * acceptance additions are held to the same coverage standard. See ADR-0004.
 */
const OVERRIDE = readText('CONDUIT_PRD_v1.1_OVERRIDE.md');

function sectionOf(document: string, heading: string): string {
  const start = document.indexOf(heading);
  if (start === -1) throw new Error(`section not found: ${heading}`);

  const rest = document.slice(start + heading.length);
  const end = /\n#{1,2} /.exec(rest)?.index ?? rest.length;
  return rest.slice(0, end);
}

function section(heading: string): string {
  return sectionOf(PRD, heading);
}

/** PRD 14.3 — every threat that requires analysis and tests. */
export function prdThreats(): string[] {
  return [...section('## 14.3 Threats').matchAll(/^- (.+)$/gm)]
    .map((match) => (match[1] ?? '').trim().replace(/[;.]$/, ''))
    .filter((threat) => threat.length > 0);
}

/** PRD 14.4 — the fundamental invariant identifiers. */
export function prdInvariantIds(): string[] {
  return [...section('## 14.4 Fundamental invariants').matchAll(/^(I\d+)\s+/gm)].map(
    (match) => match[1] ?? '',
  );
}

/** PRD 23 — the questions that only live seam tests can answer. */
export function prdOpenQuestions(): string[] {
  return [...section('# 23. Mandatory unresolved questions').matchAll(/^\d+\.\s+(.+)$/gm)].map(
    (match) => match[1]?.trim() ?? '',
  );
}

/** PRD 19 — the mandatory execution phases, in order. */
export function prdPhases(): { id: string; title: string }[] {
  return [...PRD.matchAll(/^## Phase (\d{2}) — (.+)$/gm)].map((match) => ({
    id: match[1] ?? '',
    title: (match[2] ?? '').trim(),
  }));
}

/** PRD 9.7 — the exact evidence artifact labels that may never be interchanged. */
export function prdEvidenceLabels(): string[] {
  return ['CLEANVERSE_TRANSACTION_REPORT', 'CLEANVERSE_TRAVEL_RULE_REPORT'].filter((label) =>
    PRD.includes(label),
  );
}

/** v1.1 override section 17 — the acceptance criteria v1.0 completion now also requires. */
export function overrideAcceptanceAdditions(): string[] {
  return [...sectionOf(OVERRIDE, '## 17. Acceptance additions').matchAll(/^- \[[ x]\] (.+)$/gm)]
    .map((match) => (match[1] ?? '').trim().replace(/\.$/, ''))
    .filter((item) => item.length > 0);
}

/** v1.1 override section 11 — the asset-leg states the reservation model introduces. */
export function overrideAssetLegStates(): string[] {
  return ['UNRESERVED', 'RESERVED', 'COMMITTED', 'RELEASED', 'HELD', 'CANCELLED', 'DISPOSED'];
}
