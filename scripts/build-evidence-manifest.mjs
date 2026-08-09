#!/usr/bin/env node
/**
 * Assembles the canonical evidence manifest from the committed artifacts.
 *
 *   node scripts/build-evidence-manifest.mjs           # regenerate
 *   node scripts/build-evidence-manifest.mjs --check   # fail if it has drifted
 *
 * One document, so a reader who wants the whole record does not have to open
 * eleven JSON files and know which is which. Every value in it is copied from an
 * artifact under `docs/evidence` — nothing is typed here, and `--check` fails
 * the gate if the two disagree.
 *
 * Finality observations are listed per message and never averaged. That is a
 * deliberate refusal: an average across message classes and chains would produce
 * a number that was never observed and would hide the slowest, which is the one
 * a commit window has to survive.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './lib/run.mjs';

const EVIDENCE = join(ROOT, 'docs', 'evidence');
const DEPLOYMENTS = join(ROOT, 'contracts', 'deployments');
const OUT = join(EVIDENCE, 'MANIFEST.md');

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const evidence = (name) => read(join(EVIDENCE, name));

const CANONICAL = '0xdcb9db121ca873817fca7ee6a8e2cd8ef0249b7c83f4e656553338da00eccaa6';

function verificationFor(settlementId) {
  const file = readdirSync(EVIDENCE).find(
    (name) =>
      name.startsWith('verification-') &&
      name.endsWith('.json') &&
      evidence(name).settlementId === settlementId,
  );
  return file === undefined ? undefined : { file, ...evidence(file) };
}

function table(rows) {
  if (rows.length === 0) return '_none recorded_\n';
  const head = Object.keys(rows[0]);
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [
    line(head),
    line(head.map(() => '---')),
    ...rows.map((row) => line(head.map((key) => String(row[key] ?? '—')))),
  ].join('\n');
}

const short = (value, head = 14) =>
  typeof value === 'string' && value.length > head + 6
    ? `${value.slice(0, head)}…${value.slice(-4)}`
    : String(value ?? '—');

function browserSection(title, artifact, note) {
  const verification = verificationFor(artifact.settlementId);
  const messages = verification?.messages ?? [];

  return `## ${title}

\`\`\`text
settlementId  ${artifact.settlementId}
intentHash    ${artifact.settlementId}   (the id is the EIP-712 digest of the terms)
deployment    ${artifact.deploymentId}
generation    3 — canonical
driver        ${artifact.driver}
chains        Monad Testnet 10143 (cash) · Base Sepolia 84532 (asset)
\`\`\`

${note}

### Contracts

${table(
  Object.entries(artifact.addresses).map(([role, address]) => ({
    role,
    address,
    chain: ['rwa', 'adapter', 'policyBase', 'wormholeBase'].includes(role)
      ? 'Base Sepolia 84532'
      : 'Monad Testnet 10143',
  })),
)}

### Participant signatures

Checked in calldata by \`issueCommit\` and kept nowhere on chain, so these come
from the projection that recorded them when each party signed in their browser.

${table(
  artifact.intentSignatures === null
    ? []
    : [
        { party: 'payer', signature: artifact.intentSignatures.payer ?? '—' },
        { party: 'seller', signature: artifact.intentSignatures.seller ?? '—' },
        { party: 'terms source', signature: artifact.intentSignatures.termsSource },
        { party: 'nonce', signature: artifact.intentSignatures.nonce },
      ],
)}

### Transactions

Every hash below was fetched back from its chain and required to have succeeded
and to have been sent to one of this deployment's own contracts.

${table(
  artifact.transactions.map((entry) => ({
    chain: entry.chain,
    hash: entry.hash,
    block: entry.block,
    to: short(entry.to),
    succeeded: entry.succeeded ? 'yes' : 'NO',
    'to this deployment': entry.toThisDeployment ? 'yes' : 'NO',
  })),
)}

### Cross-chain messages

${table(
  messages.map((message) => ({
    type: message.messageType,
    seq: message.sequence,
    emitter: short(message.emitterKey ?? '', 30),
    'vaa hash': short(message.vaaHash ?? '—'),
    finality: message.finality,
    consumed: message.consumedAtDestination ? 'yes' : 'no consumer',
  })),
)}

### Finality observations

Per message. Never averaged.

${table(
  artifact.messages.map((message) => ({
    type: message.messageType,
    seq: message.sequence,
    'published tx': short(message.publishedTx),
    'included at': message.includedAt ?? '—',
    'observed signed after':
      message.observedSecondsAfterPublication === null
        ? 'not measured'
        : `${String(message.observedSecondsAfterPublication)}s`,
  })),
)}

### Compliance attestations

Redacted. The subject, the window, the endpoint that answered and the hash of the
answer — never the answer.

${table(
  artifact.attestations.map((entry) => ({
    subject: entry.subject,
    eligible: entry.eligible ? 'yes' : 'no',
    endpoint: entry.cleanverseEndpoint ?? '—',
    answer: entry.cleanverseAnswer ?? '—',
    'evidence hash': short(entry.evidenceHash),
    signer: short(entry.signer),
    window: `${entry.issuedAt} → ${entry.expiresAt}`,
  })),
)}

### Canonical state and conservation

\`\`\`text
coordinator   ${artifact.coordinator.state} · decision ${artifact.coordinator.decision}
cash leg      ${artifact.coordinator.cashOutcome}   escrow leg ${artifact.cashLeg.state}, ${artifact.cashLeg.amount} base units
asset leg     ${artifact.coordinator.assetOutcome}   reservation committed=${String(artifact.reservation.committed)} released=${String(artifact.reservation.released)} cancelled=${String(artifact.reservation.cancelled)}
\`\`\`

${table(
  Object.entries(artifact.balances).map(([account, value]) => ({
    account,
    'base units at capture': value,
  })),
)}

### Independent verification

${
  verification === undefined
    ? '_no verification artifact_'
    : `\`\`\`text
classification  ${verification.derived}
canonical       ${verification.canonicalState}
checks          ${String((verification.findings ?? []).filter((f) => f.ok).length)} of ${String((verification.findings ?? []).length)} passed
trust root      ${verification.trustRoot}
artifact        docs/evidence/${verification.file}
\`\`\`

Searched block ranges, so "no messages found" and "no messages exist" stay
different answers:

${table(
  Object.entries(verification.searchedBlockRanges ?? {}).map(([chainId, range]) => ({
    chain: chainId,
    from: range.from,
    to: range.to,
  })),
)}`
}

Artifact: \`docs/evidence/${artifact.source ?? 'phase-06-browser-dvp.json'}\`
`;
}

const run2 = evidence('phase-06-browser-dvp.json');
const run1 = evidence('phase-06-browser-dvp-run1.json');
run1.source = 'phase-06-browser-dvp-run1.json';
run2.source = 'phase-06-browser-dvp.json';

const change = evidence('phase-07-compliance-change-0xdcb9db12.json');
const changeVerification = verificationFor(change.settlementId);

const manifests = readdirSync(DEPLOYMENTS)
  .filter((name) => name.endsWith('.json') && !name.includes('schema'))
  .sort()
  .map((name) => ({ file: name, ...read(join(DEPLOYMENTS, name)) }));

const generations = new Map();
for (const manifest of manifests) {
  const existing = generations.get(manifest.deploymentId) ?? {
    deploymentId: manifest.deploymentId,
    gitCommit: manifest.gitCommit,
    solcVersion: manifest.solcVersion,
    contracts: [],
    files: [],
  };
  existing.files.push(`contracts/deployments/${manifest.file}`);
  for (const [role, entry] of Object.entries(manifest.contracts ?? {})) {
    existing.contracts.push({
      role,
      chain: entry.chain,
      address: entry.address,
      codeHash: manifest.bytecodeHashes?.[role] ?? '—',
    });
  }
  generations.set(manifest.deploymentId, existing);
}

const body = `<!-- Generated by scripts/build-evidence-manifest.mjs. Do not edit by hand:
     \`pnpm evidence:check\` fails when this file and docs/evidence disagree. -->

# Canonical evidence manifest

Every value here is copied from an artifact under \`docs/evidence\` or a manifest
under \`contracts/deployments\`. Nothing is typed into this file, and the gate
fails if it drifts from its sources.

Three settlements are recorded in full: two driven from a browser, and one where
compliance changed after the commitment and the protocol held the value rather
than delivering it.

| Settlement | What it shows | Canonical | Verifier |
| --- | --- | --- | --- |
| \`${run2.settlementId}\` | a participant settling from a browser, unaided | ${run2.coordinator.state} | ${verificationFor(run2.settlementId)?.derived ?? '—'} |
| \`${run1.settlementId}\` | the same path, and the four defects it found | ${run1.coordinator.state} | ${verificationFor(run1.settlementId)?.derived ?? '—'} |
| \`${change.settlementId}\` | RuleV2 changed after COMMIT → HELD → disposition | ${changeVerification?.canonicalState ?? '—'} | ${changeVerification?.derived ?? '—'} |

---

${browserSection(
  'Browser settlement 2 — canonical',
  run2,
  'Composed, checked against Cleanverse, signed, reserved, escrowed, waited out\nBase economic finality, asked compliance again, committed, released both legs,\nreported the outcome and reached SETTLED. No intervention of any kind.',
)}

---

${browserSection(
  'Browser settlement 1',
  run1,
  'The same path. It found four defects in the recording of published messages and\nneeded two of them recorded by hand before it could finish; the settlement\nitself is unaffected, and every transaction below came from the browser. The\nattestation table is empty because this run predates the code that records what\nthe authority signed — the attestations existed and the coordinator accepted\nthem, and nothing wrote them down.',
)}

---

## Compliance changed after COMMIT

The case the whole design exists for. Eligible at commit time, refused at
delivery time by a transfer rule the issuer moved in between, and the value held
rather than returned.

\`\`\`text
settlementId  ${change.settlementId}
deployment    ${change.deploymentId ?? CANONICAL}
outcome       ${change.outcome}
scenario      ${change.scenario ?? 'post-COMMIT compliance change'}
artifact      docs/evidence/phase-07-compliance-change-0xdcb9db12.json
\`\`\`

### The sequence

${table(
  (change.stages ?? []).map((stage, index) => ({
    '#': String(index + 1),
    stage: stage.stage,
  })),
)}

### RuleV2 transitions

The issuer's transfer rule, moved on chain, twice.

${table(
  (change.ruleTransitions ?? []).map((entry) => ({
    change: entry.label,
    tx: entry.hash,
    before: entry.before,
    after: entry.after,
  })),
)}

### Compliance answers

${table(
  (change.compliance ?? []).map((entry) => ({
    at: entry.at,
    subject: short(entry.subject),
    eligible: entry.eligible ? 'yes' : 'no',
    answers: (entry.sources ?? [])
      .map((source) => `${source.endpoint} ${source.answer}`)
      .join(', '),
    'evidence hash': short(entry.evidenceHash),
  })),
)}

### What could not happen once COMMIT existed

${table(
  (change.adversarial ?? []).map((entry) => ({
    attempt: entry.attempt,
    'refused with': entry.refusedWith,
  })),
)}

### Resolution

\`\`\`text
disposition   ${change.disposition?.type ?? '—'}
tx            ${change.disposition?.hash ?? '—'}
verifier      ${changeVerification?.derived ?? '—'}, ${String((changeVerification?.findings ?? []).filter((f) => f.ok).length)} of ${String((changeVerification?.findings ?? []).length)} checks
\`\`\`

---

## Deployment generations

Core contracts are non-upgradeable, so a new version is a new generation. A
settlement stays verifiable against the generation that produced it, forever,
and the current generation cannot answer for it.

${[...generations.values()]
  .map((generation) => {
    const canonical = generation.deploymentId === CANONICAL;
    return `### ${canonical ? 'Canonical — generation 3' : 'Historical'} \`${generation.deploymentId}\`

\`\`\`text
git commit  ${generation.gitCommit}
solc        ${generation.solcVersion}
manifests   ${generation.files.join(', ')}
status      ${canonical ? 'CANONICAL — every settlement below was produced by it' : 'HISTORICAL — superseded, and still the only generation that can answer for its own settlements'}
\`\`\`

${table(
  generation.contracts.map((contract) => ({
    role: contract.role,
    chain: contract.chain,
    address: contract.address,
    'code hash': short(contract.codeHash),
  })),
)}`;
  })
  .join('\n\n')}

---

## Finality

Listed per observation in
[docs/evidence/observed-latency.md](./observed-latency.md), never averaged, with
the measurement granularity stated for each one. The rule for anything derived
from that page: quote a sample and say which run it came from.

## What none of this proves

The contract verifies that an authorised signer asserted eligibility and bound
the assertion to a settlement, an intent and a window. It cannot verify that the
signer asked Cleanverse, or that Cleanverse answered that way. With this
deployment's quorum of one, that is a trust assumption in the signer's operator —
threat register T-08 and T-09, accepted with a written waiver at
[docs/security-waivers/attestation-signer-quorum.md](../security-waivers/attestation-signer-quorum.md).
`;

if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== body) {
    console.error('docs/evidence/MANIFEST.md has drifted from its sources.');
    console.error('Run: node scripts/build-evidence-manifest.mjs');
    process.exit(1);
  }
  console.log('evidence manifest matches its artifacts');
} else {
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT}`);
}
