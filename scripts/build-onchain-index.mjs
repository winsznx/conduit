#!/usr/bin/env node
/**
 * The curated index of what Conduit actually did on two public chains.
 *
 *   node scripts/build-onchain-index.mjs           # refresh from the chains
 *   node scripts/build-onchain-index.mjs --check   # fail if it has drifted
 *
 * ## Why the hashes are resolved rather than transcribed
 *
 * The run artifacts under `docs/evidence` record transaction hashes as the runs
 * produced them. Some carry a chain id alongside; most carry the hash under a
 * stage whose title names the chain in prose. Copying a hash into a document
 * and writing "Base Sepolia" next to it because the stage said so is a
 * transcription, and a transcription can be wrong in exactly the way that
 * matters: a link that resolves on the wrong explorer looks like a missing
 * transaction, and a missing transaction looks like a claim that was never true.
 *
 * So every hash here is looked up. Both chains are asked, the chain that has a
 * receipt is the chain it is on, and the block, the status and the contract it
 * called are read from that receipt rather than from the artifact. A hash that
 * neither chain knows is recorded as `NOT_FOUND` and stays in the document —
 * removing it would hide the one row worth looking at.
 *
 * An RPC that cannot be reached produces `UNREACHABLE`, never a pass. "We could
 * not ask" and "the answer was yes" are different answers, and `--check` fails
 * on the first.
 *
 * ## What this is not
 *
 * Not evidence. `docs/evidence/MANIFEST.md` is the record and the artifacts
 * under it are the proof. This is an index: one page from which a reader can
 * open any transaction in the project on the explorer for the chain that mined
 * it, without reading a single JSON file first.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, http } from 'viem';

import { ROOT } from './lib/run.mjs';

const EVIDENCE = join(ROOT, 'docs', 'evidence');
const OUT = join(ROOT, 'docs', 'onchain.md');
const RECORD = join(EVIDENCE, 'onchain-transactions.json');

const CHAINS = {
  monadTestnet: {
    label: 'Monad Testnet',
    chainId: 10_143,
    rpc: 'https://testnet-rpc.monad.xyz',
    explorer: 'https://testnet.monadexplorer.com',
  },
  baseSepolia: {
    label: 'Base Sepolia',
    chainId: 84_532,
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
  },
};

const CLIENTS = Object.fromEntries(
  Object.entries(CHAINS).map(([key, chain]) => [
    key,
    createPublicClient({ transport: http(chain.rpc, { retryCount: 2, timeout: 15_000 }) }),
  ]),
);

const HASH = /^0x[0-9a-f]{64}$/i;

const read = (name) => JSON.parse(readFileSync(join(EVIDENCE, name), 'utf8'));

/**
 * The runs this index covers, in the order a reader should meet them.
 *
 * Named rather than globbed. A glob would silently pick up the next artifact
 * somebody adds and present it as a curated entry, and the point of a curated
 * index is that a person decided what belongs in it.
 */
const RUNS = [
  {
    file: 'phase-06-dvp-attempt-4.json',
    title: 'First complete DvP — scripted',
    note: 'Driven by `scripts/run-dvp.mjs`. The settlement that proved the whole path end to end.',
  },
  {
    file: 'phase-06-browser-dvp.json',
    title: 'First complete DvP from a browser',
    note: 'Every transaction signed by a wallet extension against the deployed console. Assisted at two points, which the artifact records.',
  },
  {
    file: 'phase-06-browser-dvp-run1.json',
    title: 'Second browser DvP — unassisted',
    note: 'Composed, prepared, committed and released from the browser with no intervention.',
  },
  {
    file: 'phase-07-compliance-change-0x893ca44e.json',
    title: 'Compliance change mid-settlement — generation 2',
    note: 'The buyer becomes ineligible after COMMIT. The cash stays released, the asset holds, and a disposition resolves it.',
  },
  {
    file: 'phase-07-compliance-change-0xdcb9db12.json',
    title: 'Compliance change mid-settlement — generation 3',
    note: 'The same scenario on the canonical generation, with the disposition kernel wired.',
  },
];

/**
 * Every transaction hash an artifact records, with the label it was recorded
 * under.
 *
 * Two shapes exist and both are read. `transactions[]` carries a hash and a
 * chain id; `stages[].detail` carries named hashes under a stage title. The
 * chain in either case comes from the receipt, not from here.
 */
function hashesIn(artifact) {
  const found = [];

  // A `transactions[]` array records the run's own order and no step names, so
  // the ordinal is the only true label available. Inventing one from the callee
  // would be a guess dressed as a fact, and the callee has its own column.
  let ordinal = 0;
  for (const entry of artifact.transactions ?? []) {
    if (typeof entry?.hash === 'string' && HASH.test(entry.hash)) {
      ordinal += 1;
      found.push({ hash: entry.hash.toLowerCase(), label: `#${ordinal} in run order`, stage: '' });
    }
  }

  for (const stage of artifact.stages ?? []) {
    for (const [key, value] of Object.entries(stage.detail ?? {})) {
      if (typeof value === 'string' && HASH.test(value)) {
        found.push({ hash: value.toLowerCase(), label: key, stage: stage.stage ?? '' });
      }
    }
  }

  const seen = new Set();
  return found.filter((entry) => {
    if (seen.has(entry.hash)) return false;
    seen.add(entry.hash);
    return true;
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Asks both chains until one of them answers properly.
 *
 * Fifty-seven lookups against two public testnet RPCs will meet a rate limit,
 * and a rate limit is not an absent transaction. Retrying with a widening gap
 * is what separates "this endpoint is busy" from "this hash is on neither
 * chain", and only the second is a finding.
 */
async function resolve(hash, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const outcome = await ask(hash);
    if (outcome.status !== 'UNREACHABLE') return outcome;
    if (attempt < attempts - 1) await sleep(1_000 * 2 ** attempt);
  }
  return await ask(hash);
}

/** One round of asking both chains, and believing the one that has a receipt. */
async function ask(hash) {
  const outcomes = await Promise.all(
    Object.entries(CLIENTS).map(async ([key, client]) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return { key, receipt };
      } catch (error) {
        // viem throws the same class for "no such transaction" as for a network
        // failure, so the message is what separates them. Getting this wrong in
        // the safe direction means reporting UNREACHABLE for a hash that is
        // simply on the other chain, which is why both arms are inspected.
        const text = String(error?.name ?? '') + String(error?.message ?? '');
        const absent = /TransactionReceiptNotFound|could not be found/i.test(text);
        return { key, absent, error: absent ? undefined : text.slice(0, 200) };
      }
    }),
  );

  const hit = outcomes.find((outcome) => outcome.receipt !== undefined);
  if (hit !== undefined) {
    const chain = CHAINS[hit.key];
    return {
      status: hit.receipt.status === 'success' ? 'SUCCESS' : 'REVERTED',
      chain: hit.key,
      chainId: chain.chainId,
      block: hit.receipt.blockNumber.toString(),
      to: (hit.receipt.to ?? '').toLowerCase(),
      explorerUrl: `${chain.explorer}/tx/${hash}`,
    };
  }

  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  if (failed.length > 0) {
    return { status: 'UNREACHABLE', detail: failed.map((entry) => entry.error).join(' | ') };
  }
  return { status: 'NOT_FOUND' };
}

/** Which deployed contract an address is, where this project knows. */
function contractNames() {
  const names = new Map();
  const verification = read('onchain-verification.json');
  for (const contract of verification.contracts ?? []) {
    names.set(String(contract.address).toLowerCase(), contract.role);
  }
  names.set('0xfefd2ea28db25c720ec5298964f8d2f34e3f1f16', 'ConduitSandboxSettlementCVA (cSETTLE)');
  names.set('0xddb1ae5685f4033ed10b3dfce5e9dc13d3e4989b', 'ConduitRWACVA (cBOND)');
  return names;
}

function short(hash) {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

async function main() {
  const check = process.argv.includes('--check');
  const names = contractNames();
  const runs = [];

  for (const run of RUNS) {
    const artifact = read(run.file);
    const rows = [];
    for (const entry of hashesIn(artifact)) {
      rows.push({ ...entry, ...(await resolve(entry.hash)) });
    }
    runs.push({
      ...run,
      settlementId: artifact.settlementId ?? '',
      deploymentId: artifact.deploymentId ?? artifact.deployment?.deploymentId ?? '',
      outcome: artifact.outcome ?? '',
      transactions: rows,
    });
  }

  const all = runs.flatMap((run) => run.transactions);
  const unreachable = all.filter((row) => row.status === 'UNREACHABLE').length;
  const missing = all.filter((row) => row.status === 'NOT_FOUND').length;
  const reverted = all.filter((row) => row.status === 'REVERTED').length;

  const lines = [];
  lines.push('# On-chain transaction index');
  lines.push('');
  lines.push(
    'Every transaction Conduit sent in the runs that produced its evidence, resolved against the',
    'chain that mined it and linked to that chain’s explorer.',
  );
  lines.push('');
  lines.push(
    'Generated by `scripts/build-onchain-index.mjs`. Nothing here is typed by hand: each hash is',
    'read out of an artifact under `docs/evidence`, then looked up on both chains, and the chain,',
    'block, status and callee come from the receipt. `pnpm onchain:index:check` fails if this file',
    'and the chains disagree.',
  );
  lines.push('');
  lines.push(
    'This is an index, not the evidence. `docs/evidence/MANIFEST.md` is the record; the artifacts',
    'under it are the proof.',
  );
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`- transactions indexed: **${all.length}**`);
  lines.push(`- succeeded: **${all.filter((row) => row.status === 'SUCCESS').length}**`);
  lines.push(`- reverted: **${reverted}**`);
  lines.push(`- not found on either chain: **${missing}**`);
  lines.push(`- could not be checked: **${unreachable}**`);
  lines.push('');

  for (const run of runs) {
    lines.push(`## ${run.title}`);
    lines.push('');
    lines.push(run.note);
    lines.push('');
    if (run.settlementId !== '') {
      lines.push(`\`\`\`text`);
      lines.push(`settlement   ${run.settlementId}`);
      if (run.deploymentId !== '') lines.push(`deployment   ${run.deploymentId}`);
      if (run.outcome !== '') lines.push(`outcome      ${run.outcome}`);
      lines.push(`artifact     docs/evidence/${run.file}`);
      lines.push(`\`\`\``);
      lines.push('');
    }

    lines.push('| Step | Chain | Transaction | Block | Called | Status |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of run.transactions) {
      const chain = row.chain === undefined ? '—' : CHAINS[row.chain].label;
      const link =
        row.explorerUrl === undefined
          ? `\`${short(row.hash)}\``
          : `[\`${short(row.hash)}\`](${row.explorerUrl})`;
      const called = row.to === undefined || row.to === '' ? '—' : (names.get(row.to) ?? row.to);
      const step = row.stage === '' ? row.label : `${row.label} — ${row.stage}`;
      lines.push(
        `| ${step} | ${chain} | ${link} | ${row.block ?? '—'} | ${called} | ${row.status} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Contracts');
  lines.push('');
  lines.push(
    'Addresses, code hashes and source verification live in [`docs/deployments.md`](./deployments.md),',
    'and are re-checked by `pnpm onchain:check` against the chains and Sourcify.',
  );
  lines.push('');

  const markdown = `${lines.join('\n')}`;
  const record = {
    capturedAt: new Date().toISOString(),
    totals: { indexed: all.length, reverted, missing, unreachable },
    runs: runs.map((run) => ({
      file: run.file,
      settlementId: run.settlementId,
      transactions: run.transactions.map((row) => ({
        hash: row.hash,
        label: row.label,
        chainId: row.chainId ?? null,
        block: row.block ?? null,
        status: row.status,
      })),
    })),
  };

  if (check) {
    const failures = [];
    if (unreachable > 0) {
      failures.push(`${unreachable} transaction(s) could not be checked against either chain`);
    }
    if (missing > 0) failures.push(`${missing} transaction(s) are on neither chain`);

    let previous = '';
    try {
      previous = readFileSync(OUT, 'utf8');
    } catch {
      failures.push('docs/onchain.md does not exist — run `pnpm onchain:index`');
    }
    // The capture timestamp changes every run and says nothing about the
    // chains, so the comparison is on the document, which does not carry one.
    if (previous !== '' && previous !== markdown) {
      failures.push('docs/onchain.md has drifted from what the chains report');
    }

    if (failures.length > 0) {
      console.error('on-chain index check FAILED');
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.log(`on-chain index OK — ${all.length} transactions, all resolved`);
    return;
  }

  // An outage must never overwrite a good record with a worse one. A run that
  // could not reach a chain knows less than the file already on disk, and
  // writing it would turn a temporary network problem into a permanent claim
  // that transactions cannot be found.
  if (unreachable > 0) {
    console.error(
      `refusing to write: ${unreachable} of ${all.length} transactions could not be checked`,
    );
    console.error('  an RPC was unreachable. The existing docs/onchain.md is left untouched.');
    process.exit(1);
  }

  writeFileSync(OUT, markdown);
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote docs/onchain.md — ${all.length} transactions`);
  if (missing > 0) console.log(`  ${missing} not found on either chain`);
}

await main();
