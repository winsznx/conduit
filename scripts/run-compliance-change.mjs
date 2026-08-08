#!/usr/bin/env node
/**
 * Eligibility changes after COMMIT, and the protocol holds rather than choosing.
 *
 *   node --env-file=.env scripts/run-compliance-change.mjs
 *
 * The happy path proves Conduit can settle. This proves the harder thing: that
 * a trade which was legitimately committable can stop being legitimately
 * deliverable, and that Conduit neither refunds a seller who has been paid nor
 * sends a restricted asset to someone the policy now refuses. It holds the
 * committed value.
 *
 * ```text
 *   both legs prepared, buyer eligible
 *   Base finality
 *   fresh commit-time compliance, still eligible
 *   COMMIT, cash releases to the seller
 *   ── the issuer raises minTier on the RWA's RuleV2 ──
 *   the live policy now refuses the buyer: TierTooLow(buyer, 21, 20)
 *   fresh commit-time compliance, now a signed refusal
 *   releaseAsset → HELD. No refund, no delivery.
 *   the issuer restores the rule; eligibility returns
 * ```
 *
 * Nothing here is simulated. `setRuleV2` is the issuer-controlled surface the
 * CVA guide provides, it routes through the token to the live CCP policy, and
 * the refusal is computed by that policy rather than asserted by this script.
 * `update_status` was not used because `generate_apass` is 403 for this
 * credential (ASM-035), which puts account-status transitions out of reach;
 * RuleV2 is the other real Cleanverse compliance surface and it is the issuer's.
 *
 * The disposition that would end this story — `resolveHeldAsset` — is not in the
 * deployed adapter. It is proven in `CrossChainSettlementSeam.t.sol` and needs a
 * new deployment generation, which is blocked on Monad gas
 * (`phase-07-generation-2-blocked.json`). The run says so at the end rather than
 * stopping short and leaving the reader to notice.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseAbi } from 'viem';

import {
  ADAPTER_ABI,
  BASE_EVM_CHAIN_ID,
  COORDINATOR_ABI,
  ERC20_ABI,
  ESCROW_ABI,
  LegOutcome,
  MONAD_EVM_CHAIN_ID,
  MessageType,
  POLICY_ABI,
  RWA_ABI,
  buildIntent,
  cashLeg,
  fetchVaa,
  intentTuple,
  loadDvpConfig,
  padEmitter,
  reservation,
  resumeIntent,
  sequenceFrom,
  settlement,
} from './lib/dvp.mjs';
import { attestationTuple, readAttestationDomain, signAttestation } from './lib/attestation.mjs';
import {
  assertChainIdentity,
  classify,
  revertName,
  shortMessage,
  stringify,
  submit,
} from './lib/chain.mjs';
import { cleanverseClientFromEnv } from './lib/cleanverse.mjs';
import { createLog, unbufferStdout } from './lib/observe.mjs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();

const config = loadDvpConfig();
const { monad, base, addresses, deployer, complianceSigner } = config;

const resumePath = process.env['DVP_RESUME'];
const resumed =
  resumePath === undefined || resumePath === ''
    ? undefined
    : JSON.parse(readFileSync(join(ROOT, resumePath), 'utf8'));

const { terms, settlementId } =
  resumed === undefined ? buildIntent(config) : resumeIntent(config, resumed);

const log = createLog(
  join(ROOT, 'docs', 'evidence', 'artifacts', `compliance-change-${settlementId.slice(2, 12)}.log`),
);

const RULE = '(bytes2,bytes2,uint8,uint8,bool,uint256)';
const RULE_ABI = parseAbi([
  `function setRuleV2(${RULE} rule)`,
  `function getRulesV2() view returns (${RULE}[])`,
]);

const PROOF = '((bytes32,bytes32,address,bool,uint64,uint64,bytes32)[],bytes[])';
const DISPOSITION_ABI = parseAbi([
  `function resolveHeldAsset(bytes32 settlementId, ${PROOF} compliance)`,
  `function resolveHeldCash(bytes32 settlementId, ${PROOF} compliance)`,
]);

/** `cast sig`, pinned so a signature change fails the presence check loudly. */
const RESOLVE_HELD_ASSET_SELECTOR = '1911b514';

/** The holder's A-Pass tier on Base is 20, so 21 is the smallest real refusal. */
const RESTRICTIVE = ['0x0000', '0x0000', 21, 0, false, 0n];
const PERMISSIVE = ['0x0000', '0x0000', 0, 0, false, 0n];

const evidence = {
  startedAt: new Date().toISOString(),
  scenario: 'post-COMMIT compliance change, Path B: issuer-controlled RuleV2 transition',
  resumedFrom: resumed === undefined ? null : resumePath,
  settlementId,
  outcome: 'INCOMPLETE',
  intent: Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, stringify(v)])),
  addresses,
  stages: [],
  compliance: [],
  ruleTransitions: [],
  conservation: {},
  adversarial: [],
};

const evidencePath = join(ROOT, 'docs', 'evidence', 'phase-07-compliance-change.json');
function persist() {
  writeFileSync(
    evidencePath,
    `${JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2)}\n`,
  );
}

function stage(name) {
  log.stage(name);
  const entry = { stage: name, at: new Date().toISOString(), detail: {} };
  evidence.stages.push(entry);
  persist();
  return entry;
}
function record(entry, key, value) {
  entry.detail[key] = stringify(value);
  persist();
}

async function already(label, read) {
  const done = await read();
  if (done) log.step(`${label} — already done`);
  return done;
}

/**
 * Both sides of the ledger, at a named moment.
 *
 * Captured before, at HELD, and after, because "no disappearance, no double
 * ownership, no refundable committed leg" is a statement about three snapshots
 * and not about one.
 */
async function conservation(label) {
  const snapshot = {
    at: new Date().toISOString(),
    cash: {
      payer: await monad.pub.readContract({
        address: addresses.cash,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [terms.cashPayer],
      }),
      receiver: await monad.pub.readContract({
        address: addresses.cash,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [terms.cashReceiver],
      }),
      escrow: await monad.pub.readContract({
        address: addresses.cash,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [addresses.escrow],
      }),
      totalEscrowed: await monad.pub.readContract({
        address: addresses.escrow,
        abi: ESCROW_ABI,
        functionName: 'totalEscrowed',
      }),
      totalSupply: await monad.pub.readContract({
        address: addresses.cash,
        abi: ERC20_ABI,
        functionName: 'totalSupply',
      }),
    },
    rwa: {
      sellerNominal: await base.pub.readContract({
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'balanceOf',
        args: [terms.assetSeller],
      }),
      sellerReserved: await base.pub.readContract({
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'reservedBalanceOf',
        args: [terms.assetSeller],
      }),
      sellerAvailable: await base.pub.readContract({
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'availableBalanceOf',
        args: [terms.assetSeller],
      }),
      receiver: await base.pub.readContract({
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'balanceOf',
        args: [terms.assetReceiver],
      }),
      totalSupply: await base.pub.readContract({
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'totalSupply',
      }),
    },
  };
  evidence.conservation[label] = JSON.parse(
    JSON.stringify(snapshot, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
  );
  persist();
  log.step(
    `${label}: escrow ${snapshot.cash.escrow}/${snapshot.cash.totalEscrowed}, ` +
      `seller reserved ${snapshot.rwa.sellerReserved}, receiver ${snapshot.rwa.receiver}`,
  );
  return snapshot;
}

/** The live policy's own answer, and the gateway's, side by side. */
async function complianceSnapshot(label) {
  const { queryEligibility } = await import('../packages/cleanverse/dist/compliance.js');
  const client = await cleanverseClientFromEnv();

  const decision = await queryEligibility(client, {
    chain: config.cleanverseChain.asset,
    subject: terms.assetReceiver,
    atoken: addresses.rwa,
  });

  let onChain;
  try {
    onChain = String(
      await base.pub.readContract({
        address: addresses.policyBase,
        abi: POLICY_ABI,
        functionName: 'canTransfer',
        args: [addresses.rwa, terms.assetSeller, terms.assetReceiver, terms.assetAmount],
      }),
    );
  } catch (error) {
    onChain = `revert ${revertName(error) ?? shortMessage(error)}`;
  }

  const rules = await base.pub.readContract({
    address: addresses.rwa,
    abi: RULE_ABI,
    functionName: 'getRulesV2',
  });

  const snapshot = {
    label,
    at: new Date().toISOString(),
    subject: terms.assetReceiver,
    eligible: decision.eligible,
    evidenceHash: decision.evidenceHash,
    sources: decision.sources.map((s) => ({
      endpoint: s.endpoint,
      requestId: s.requestId,
      answer: s.answer,
      responseHash: s.responseHash,
    })),
    onChainCanTransfer: onChain,
    ruleV2: stringify(rules),
  };
  evidence.compliance.push(snapshot);
  persist();

  log.step(
    `${label}: ${decision.sources.map((s) => `${s.endpoint} ${s.answer}`).join(', ')} | ` +
      `canTransfer ${onChain} | rule ${stringify(rules)}`,
  );
  return { decision, snapshot };
}

async function setRule(label, rule) {
  const entry = stage(`RuleV2: ${label}`);
  const before = await base.pub.readContract({
    address: addresses.rwa,
    abi: RULE_ABI,
    functionName: 'getRulesV2',
  });

  const result = await submit(base, {
    label: `setRuleV2 ${label}`,
    log,
    request: { address: addresses.rwa, abi: RULE_ABI, functionName: 'setRuleV2', args: [rule] },
    postState: {
      describe: 'the policy reports the new rule',
      read: async (client) =>
        stringify(
          await client.readContract({
            address: addresses.rwa,
            abi: RULE_ABI,
            functionName: 'getRulesV2',
          }),
        ),
      matches: (value) => value === stringify([rule]),
    },
  });

  evidence.ruleTransitions.push({
    label,
    hash: result.hash,
    before: stringify(before),
    after: stringify([rule]),
  });
  record(entry, 'hash', result.hash);
  record(entry, 'before', before);
  record(entry, 'after', [rule]);
  return result;
}

async function mustRefuse(label, chain, request, expected) {
  const outcome = await chain.pub
    .simulateContract({ ...request, account: deployer })
    .then(() => undefined)
    .catch((error) => error);
  if (outcome === undefined) throw new Error(`${label}: the call succeeded, and it must not`);
  const nameOf = revertName(outcome);
  evidence.adversarial.push({ attempt: label, refusedWith: nameOf ?? shortMessage(outcome) });
  persist();
  if (expected !== undefined && !expected.includes(nameOf)) {
    throw new Error(`${label}: expected one of ${expected.join(', ')}, got ${nameOf ?? '?'}`);
  }
  log.ok(`${label} — refused with ${nameOf ?? shortMessage(outcome)}`);
}

async function proofFor(chain, verifying, subject, decision) {
  const domain = await readAttestationDomain(chain, verifying);
  const issuedAt = BigInt(Math.floor(Date.now() / 1000) - 30);
  const signed = await signAttestation({
    domain,
    signer: complianceSigner,
    attestation: {
      settlementId,
      intentHash: settlementId,
      subject,
      eligible: decision.eligible,
      issuedAt,
      expiresAt: issuedAt + (domain.maxValidity - 300n),
      evidenceHash: decision.evidenceHash,
    },
  });
  return [[attestationTuple(signed.attestation)], [signed.signature]];
}

async function main() {
  log.step(`settlement ${settlementId}`);
  log.step(`buyer/seller ${terms.cashPayer}`);
  await assertChainIdentity(monad);
  await assertChainIdentity(base);

  // The rule must start permissive, whatever a previous run left behind.
  const startingRule = await base.pub.readContract({
    address: addresses.rwa,
    abi: RULE_ABI,
    functionName: 'getRulesV2',
  });
  if (stringify(startingRule) !== stringify([PERMISSIVE])) {
    log.warn(`rule is ${stringify(startingRule)}; restoring the permissive rule first`);
    await setRule('restore before starting', PERMISSIVE);
  }

  await conservation('before');
  await complianceSnapshot('before preparation');

  // ── prepare both legs ─────────────────────────────────────────────────────

  {
    const entry = stage('Base Sepolia: reserve and announce');
    const available = await base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'availableBalanceOf',
      args: [terms.assetSeller],
    });
    if (available < terms.assetAmount) {
      await submit(base, {
        label: 'mint',
        log,
        request: {
          address: addresses.rwa,
          abi: RWA_ABI,
          functionName: 'mint',
          args: [terms.assetSeller, terms.assetAmount * 4n],
        },
        postState: {
          describe: 'the seller can cover the reservation',
          read: (client) =>
            client.readContract({
              address: addresses.rwa,
              abi: RWA_ABI,
              functionName: 'availableBalanceOf',
              args: [terms.assetSeller],
            }),
          matches: (value) => value >= terms.assetAmount,
        },
      });
    }

    const reservedBefore = await base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'reservedBalanceOf',
      args: [terms.assetSeller],
    });

    if (
      !(await already(
        'reserveForSettlement',
        async () =>
          reservation(
            await base.pub.readContract({
              address: addresses.rwa,
              abi: RWA_ABI,
              functionName: 'reservationOf',
              args: [settlementId],
            }),
          ).owner !== '0x0000000000000000000000000000000000000000',
      ))
    ) {
      const reserve = await submit(base, {
        label: 'reserveForSettlement',
        log,
        request: {
          address: addresses.rwa,
          abi: RWA_ABI,
          functionName: 'reserveForSettlement',
          args: [settlementId, terms.assetAmount],
        },
        postState: {
          describe: 'the reservation is observable on every provider',
          read: (client) =>
            client.readContract({
              address: addresses.rwa,
              abi: RWA_ABI,
              functionName: 'reservedBalanceOf',
              args: [terms.assetSeller],
            }),
          matches: (value) => value >= reservedBefore + terms.assetAmount,
        },
      });
      record(entry, 'reserve', reserve.hash);
    }

    if (
      !(await already(
        'prepareAsset',
        async () =>
          (await base.pub.readContract({
            address: addresses.adapter,
            abi: ADAPTER_ABI,
            functionName: 'intendedReceiver',
            args: [settlementId],
          })) !== '0x0000000000000000000000000000000000000000',
      ))
    ) {
      const prepare = await submit(base, {
        label: 'prepareAsset',
        log,
        request: {
          address: addresses.adapter,
          abi: ADAPTER_ABI,
          functionName: 'prepareAsset',
          args: [settlementId, settlementId, terms.assetReceiver, BigInt(MONAD_EVM_CHAIN_ID), 1],
        },
        postState: {
          describe: 'the adapter recorded the intended receiver',
          read: (client) =>
            client.readContract({
              address: addresses.adapter,
              abi: ADAPTER_ABI,
              functionName: 'intendedReceiver',
              args: [settlementId],
            }),
          matches: (v) => v.toLowerCase() === terms.assetReceiver.toLowerCase(),
        },
      });
      const published = sequenceFrom(prepare.receipt);
      evidence.assetPrepared = {
        hash: prepare.hash,
        sequence: String(published.sequence),
        emitter: addresses.adapter,
      };
      record(entry, 'prepareAsset', prepare.hash);
      record(entry, 'sequence', published.sequence);
    } else {
      evidence.assetPrepared = resumed?.assetPrepared;
      if (evidence.assetPrepared === undefined) {
        throw new Error('the asset leg is prepared but no record carries its sequence');
      }
    }
    persist();
  }

  {
    const entry = stage('Monad Testnet: the cash enters escrow');
    const allowance = await monad.pub.readContract({
      address: addresses.cash,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [terms.cashPayer, addresses.escrow],
    });
    if (allowance < terms.cashAmount) {
      await submit(monad, {
        label: 'approve',
        log,
        request: {
          address: addresses.cash,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [addresses.escrow, terms.cashAmount * 10n],
        },
        postState: {
          describe: 'the escrow may take the cash',
          read: (client) =>
            client.readContract({
              address: addresses.cash,
              abi: ERC20_ABI,
              functionName: 'allowance',
              args: [terms.cashPayer, addresses.escrow],
            }),
          matches: (v) => v >= terms.cashAmount,
        },
      });
    }

    if (
      !(await already(
        'prepareCash',
        async () =>
          cashLeg(
            await monad.pub.readContract({
              address: addresses.escrow,
              abi: ESCROW_ABI,
              functionName: 'legOf',
              args: [settlementId],
            }),
          ).state !== 'NONE',
      ))
    ) {
      const prepare = await submit(monad, {
        label: 'prepareCash',
        log,
        request: {
          address: addresses.escrow,
          abi: ESCROW_ABI,
          functionName: 'prepareCash',
          args: [
            settlementId,
            settlementId,
            terms.cashReceiver,
            terms.cashAmount,
            BigInt(BASE_EVM_CHAIN_ID),
            1,
          ],
        },
        postState: {
          describe: 'the coordinator heard it from the escrow',
          read: async (client) =>
            settlement(
              await client.readContract({
                address: addresses.coordinator,
                abi: COORDINATOR_ABI,
                functionName: 'settlementOf',
                args: [settlementId],
              }),
            ).cashPrepared,
          matches: (v) => v === true,
        },
      });
      record(entry, 'prepareCash', prepare.hash);
    }
  }

  // ── the wait, then the decision ───────────────────────────────────────────

  {
    const entry = stage('waiting for the finalized ASSET_PREPARED VAA');
    if (
      await already(
        'recordAssetPrepared',
        async () =>
          settlement(
            await monad.pub.readContract({
              address: addresses.coordinator,
              abi: COORDINATOR_ABI,
              functionName: 'settlementOf',
              args: [settlementId],
            }),
          ).assetPrepared,
      )
    ) {
      record(entry, 'recordAssetPrepared', 'already consumed');
    } else {
      const { vaa, waitSeconds } = await fetchVaa(
        base.wormholeChainId,
        padEmitter(addresses.adapter),
        evidence.assetPrepared.sequence,
        { log, label: 'finalized ASSET_PREPARED' },
      );
      record(entry, 'waitSeconds', waitSeconds);
      const result = await submit(monad, {
        label: 'recordAssetPrepared',
        log,
        request: {
          address: addresses.coordinator,
          abi: COORDINATOR_ABI,
          functionName: 'recordAssetPrepared',
          args: [vaa],
        },
        postState: {
          describe: 'READY',
          read: async (client) =>
            settlement(
              await client.readContract({
                address: addresses.coordinator,
                abi: COORDINATOR_ABI,
                functionName: 'settlementOf',
                args: [settlementId],
              }),
            ).state,
          matches: (v) => v === 'READY',
        },
      });
      record(entry, 'recordAssetPrepared', result.hash);
    }
  }

  const commit = await (async () => {
    const entry = stage('fresh compliance, then COMMIT — the buyer is still eligible');

    if (
      await already(
        'issueCommit',
        async () =>
          settlement(
            await monad.pub.readContract({
              address: addresses.coordinator,
              abi: COORDINATOR_ABI,
              functionName: 'settlementOf',
              args: [settlementId],
            }),
          ).decision === 'COMMIT',
      )
    ) {
      if (resumed?.commit === undefined) throw new Error('committed but no recorded sequence');
      evidence.commit = resumed.commit;
      return BigInt(resumed.commit.sequence);
    }

    const { decision } = await complianceSnapshot('at commit time, before the rule change');
    if (!decision.eligible) {
      throw new Error('the buyer is already ineligible; restore the rule and rerun');
    }

    const { queryEligibility } = await import('../packages/cleanverse/dist/compliance.js');
    const client = await cleanverseClientFromEnv();
    const cashDecision = await queryEligibility(client, {
      chain: config.cleanverseChain.cash,
      subject: terms.cashPayer,
      atoken: addresses.cash,
      poolAddress: addresses.escrow,
    });
    if (!cashDecision.eligible) throw new Error('the cash party is not eligible');

    const proof = await proofFor(monad, addresses.coordinator, terms.cashPayer, cashDecision);
    const signature = await deployer.sign({ hash: settlementId });

    const result = await submit(monad, {
      label: 'issueCommit',
      log,
      request: {
        address: addresses.coordinator,
        abi: COORDINATOR_ABI,
        functionName: 'issueCommit',
        args: [intentTuple(terms), settlementId, signature, signature, proof, 1],
      },
      postState: {
        describe: 'the canonical decision exists',
        read: async (client) =>
          settlement(
            await client.readContract({
              address: addresses.coordinator,
              abi: COORDINATOR_ABI,
              functionName: 'settlementOf',
              args: [settlementId],
            }),
          ).decision,
        matches: (v) => v === 'COMMIT',
      },
    });
    const published = sequenceFrom(result.receipt);
    evidence.commit = { hash: result.hash, sequence: String(published.sequence) };
    record(entry, 'issueCommit', result.hash);
    record(entry, 'sequence', published.sequence);
    return published.sequence;
  })();

  // The seller is paid. From here the trade is irreversible.
  {
    const entry = stage('the cash releases: the seller is paid and cannot be un-paid');
    if (
      !(await already(
        'releaseCash',
        async () =>
          settlement(
            await monad.pub.readContract({
              address: addresses.coordinator,
              abi: COORDINATOR_ABI,
              functionName: 'settlementOf',
              args: [settlementId],
            }),
          ).cashOutcome !== 'NONE',
      ))
    ) {
      const { queryEligibility } = await import('../packages/cleanverse/dist/compliance.js');
      const client = await cleanverseClientFromEnv();
      const decision = await queryEligibility(client, {
        chain: config.cleanverseChain.cash,
        subject: terms.cashReceiver,
        atoken: addresses.cash,
        poolAddress: addresses.escrow,
      });
      const proof = await proofFor(monad, addresses.escrow, terms.cashReceiver, decision);
      const result = await submit(monad, {
        label: 'releaseCash',
        log,
        request: {
          address: addresses.escrow,
          abi: ESCROW_ABI,
          functionName: 'releaseCash',
          args: [settlementId, proof],
        },
        postState: {
          describe: 'the coordinator records the cash leg released',
          read: async (client) =>
            settlement(
              await client.readContract({
                address: addresses.coordinator,
                abi: COORDINATOR_ABI,
                functionName: 'settlementOf',
                args: [settlementId],
              }),
            ).cashOutcome,
          matches: (v) => v === 'RELEASED',
        },
      });
      record(entry, 'releaseCash', result.hash);
    }
  }

  // ── the compliance change ─────────────────────────────────────────────────

  await setRule('restrict — minTier 21 against a tier-20 holder', RESTRICTIVE);

  const { decision: refusal, snapshot } = await complianceSnapshot('after the rule change');
  if (refusal.eligible) {
    throw new Error('the rule change did not make the receiver ineligible; nothing to demonstrate');
  }
  log.ok(`the live policy now refuses the buyer: ${snapshot.onChainCanTransfer}`);
  log.ok(`Cleanverse now refuses: ${snapshot.sources.map((s) => s.answer).join(', ')}`);

  // ── the asset leg holds ───────────────────────────────────────────────────

  {
    const entry = stage('the asset leg is asked to deliver, and holds instead');

    const delivered = reservation(
      await base.pub.readContract({
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'reservationOf',
        args: [settlementId],
      }),
    );

    if (!delivered.committed) {
      const { vaa, waitSeconds } = await fetchVaa(
        monad.wormholeChainId,
        padEmitter(addresses.coordinator),
        String(commit),
        { log, label: 'finalized COMMIT' },
      );
      record(entry, 'commitVaaWaitSeconds', waitSeconds);

      // Signed as a refusal, not withheld. ADR-0014: a refusal is evidence and
      // an absent attestation is silence, and only one of them is an answer.
      const proof = await proofFor(base, addresses.adapter, terms.assetReceiver, refusal);

      const result = await submit(base, {
        label: 'releaseAsset',
        log,
        request: {
          address: addresses.adapter,
          abi: ADAPTER_ABI,
          functionName: 'releaseAsset',
          args: [vaa, proof],
        },
        postState: {
          describe: 'the reservation is committed and undelivered — held',
          read: async (client) => {
            const state = reservation(
              await client.readContract({
                address: addresses.rwa,
                abi: RWA_ABI,
                functionName: 'reservationOf',
                args: [settlementId],
              }),
            );
            return `${String(state.committed)}/${String(state.released)}`;
          },
          matches: (v) => v === 'true/false',
        },
      });
      record(entry, 'releaseAsset', result.hash);
      evidence.assetHeld = { hash: result.hash };
    }

    const held = reservation(
      await base.pub.readContract({
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'reservationOf',
        args: [settlementId],
      }),
    );
    if (!held.committed || held.released || held.cancelled) {
      throw new Error(`reservation is ${stringify(held)}, expected committed and open`);
    }
    log.ok('the bond was not delivered, and it was not returned either');
  }

  await conservation('at held');

  // ── the refusals that make this a hold and not a reversal ────────────────

  {
    stage('what cannot happen now');

    await mustRefuse(
      'a refund to the payer after COMMIT',
      monad,
      {
        address: addresses.escrow,
        abi: ESCROW_ABI,
        functionName: 'returnCash',
        args: [settlementId, [[], []]],
      },
      ['LegNotInState', 'ReturnRequiresAbort'],
    );

    await mustRefuse(
      'the seller reclaiming the reserved bond',
      base,
      {
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'cancelReservation',
        args: [settlementId],
      },
      ['ReservationAlreadyCommitted'],
    );

    await mustRefuse(
      'an ABORT after the COMMIT',
      monad,
      {
        address: addresses.coordinator,
        abi: COORDINATOR_ABI,
        functionName: 'issueAbort',
        args: [intentTuple(terms), settlementId, 0, [[[], []], '0x', '0x'], 1],
      },
      ['AbortAfterCommitForbidden'],
    );
  }

  // ── the asset leg reports HELD, and the coordinator agrees ───────────────

  {
    const entry = stage('the asset leg reports what the token did: ASSET_HELD');

    if (
      !(await already(
        'the asset leg resolution',
        async () =>
          settlement(
            await monad.pub.readContract({
              address: addresses.coordinator,
              abi: COORDINATOR_ABI,
              functionName: 'settlementOf',
              args: [settlementId],
            }),
          ).assetOutcome !== 'NONE',
      ))
    ) {
      const report = await submit(base, {
        label: 'reportResolution',
        log,
        request: {
          address: addresses.adapter,
          abi: ADAPTER_ABI,
          functionName: 'reportResolution',
          args: [settlementId, BigInt(MONAD_EVM_CHAIN_ID), 1],
        },
      });
      const published = sequenceFrom(report.receipt);
      record(entry, 'reportResolution', report.hash);
      record(entry, 'sequence', published.sequence);

      const { vaa, waitSeconds } = await fetchVaa(
        base.wormholeChainId,
        padEmitter(addresses.adapter),
        String(published.sequence),
        { log, label: 'finalized ASSET_HELD' },
      );
      record(entry, 'reportWaitSeconds', waitSeconds);

      const resolved = await submit(monad, {
        label: 'recordLegResolved(ASSET_HELD)',
        log,
        request: {
          address: addresses.coordinator,
          abi: COORDINATOR_ABI,
          functionName: 'recordLegResolved',
          args: [vaa, MessageType.ASSET_HELD, LegOutcome.HELD],
        },
        postState: {
          describe: 'the settlement is HELD',
          read: async (client) =>
            settlement(
              await client.readContract({
                address: addresses.coordinator,
                abi: COORDINATOR_ABI,
                functionName: 'settlementOf',
                args: [settlementId],
              }),
            ).state,
          matches: (v) => v === 'HELD',
        },
      });
      record(entry, 'recordLegResolved', resolved.hash);
      evidence.held = { hash: resolved.hash };
    }
  }

  // ── the authority changes its mind ────────────────────────────────────────

  await setRule('restore — minTier 0', PERMISSIVE);
  const { decision: restored } = await complianceSnapshot('after the rule is restored');
  if (!restored.eligible) throw new Error('eligibility did not return after restoring the rule');
  log.ok('the buyer is eligible again, and the bond is still held pending a disposition');

  await conservation('after');

  // ── the disposition, if this generation carries one ───────────────────────

  const entry = stage('disposition');
  const code = await base.pub.getCode({ address: addresses.adapter });
  const canDisposition = code.includes(RESOLVE_HELD_ASSET_SELECTOR);
  record(entry, 'resolveHeldAssetPresentInBytecode', canDisposition);

  if (!canDisposition) {
    log.warn(
      'resolveHeldAsset is not in this deployed adapter, so the held bond stays held. The path ' +
        'is proven in CrossChainSettlementSeam.t.sol against producer-originated messages and ' +
        'needs the deployment generation blocked in phase-07-generation-2-blocked.json.',
    );
    evidence.dispositionBlocked = {
      reason: 'resolveHeldAsset postdates this deployment generation',
      provenIn: 'contracts/test/CrossChainSettlementSeam.t.sol test_12',
      blockedBy: 'docs/evidence/phase-07-generation-2-blocked.json',
    };
    evidence.outcome = 'HELD_ON_REAL_COMPLIANCE_CHANGE';
    return;
  }

  // ── REVERIFY_AND_RESUME ───────────────────────────────────────────────────
  //
  // The authority has revised its answer and the destination has not changed.
  // That is the one disposition order type reachable without the authority
  // registry: no rebinding, no substitution, and the receiver is still the one
  // the intent named.

  const { decision: nowEligible } = await complianceSnapshot('at disposition time');
  if (!nowEligible.eligible) {
    throw new Error('the receiver is still ineligible; the disposition would only re-hold');
  }

  const proof = await proofFor(base, addresses.adapter, terms.assetReceiver, nowEligible);
  const resolveResult = await submit(base, {
    label: 'resolveHeldAsset',
    log,
    request: {
      address: addresses.adapter,
      abi: DISPOSITION_ABI,
      functionName: 'resolveHeldAsset',
      args: [settlementId, proof],
    },
    postState: {
      describe: 'the reservation is released',
      read: async (client) =>
        reservation(
          await client.readContract({
            address: addresses.rwa,
            abi: RWA_ABI,
            functionName: 'reservationOf',
            args: [settlementId],
          }),
        ).released,
      matches: (v) => v === true,
    },
  });
  record(entry, 'resolveHeldAsset', resolveResult.hash);
  evidence.disposition = { type: 'REVERIFY_AND_RESUME', hash: resolveResult.hash };
  log.ok('the bond is delivered to the receiver the intent named, and nowhere else');

  // The coordinator has to hear about it, or the settlement stays HELD there.
  const report = await submit(base, {
    label: 'reportResolution after disposition',
    log,
    request: {
      address: addresses.adapter,
      abi: ADAPTER_ABI,
      functionName: 'reportResolution',
      args: [settlementId, BigInt(MONAD_EVM_CHAIN_ID), 1],
    },
  });
  const published = sequenceFrom(report.receipt);
  record(entry, 'reportResolution', report.hash);

  const { vaa, waitSeconds } = await fetchVaa(
    base.wormholeChainId,
    padEmitter(addresses.adapter),
    String(published.sequence),
    { log, label: 'finalized ASSET_RELEASED' },
  );
  record(entry, 'dispositionReportWaitSeconds', waitSeconds);

  // HELD -> RELEASED is a forward move the coordinator allows precisely so a
  // disposition can complete one. PRD 7.1 lists it; nothing else uses it.
  const settled = await submit(monad, {
    label: 'recordLegResolved(ASSET_RELEASED) after disposition',
    log,
    request: {
      address: addresses.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'recordLegResolved',
      args: [vaa, MessageType.ASSET_RELEASED, LegOutcome.RELEASED],
    },
    postState: {
      describe: 'the settlement is terminal',
      read: async (client) =>
        settlement(
          await client.readContract({
            address: addresses.coordinator,
            abi: COORDINATOR_ABI,
            functionName: 'settlementOf',
            args: [settlementId],
          }),
        ).state,
      matches: (v) => v === 'SETTLED',
    },
  });
  record(entry, 'recordLegResolved', settled.hash);
  evidence.settled = { hash: settled.hash };

  await conservation('after disposition');
  evidence.outcome = 'HELD_THEN_DISPOSITIONED_TO_SETTLED';
}

try {
  await main();
  log.ok(
    evidence.outcome === 'HELD_THEN_DISPOSITIONED_TO_SETTLED'
      ? 'HELD on a real compliance change, then dispositioned to SETTLED'
      : 'HELD on a real compliance change, no refund, no illegal delivery',
  );
} catch (error) {
  evidence.outcome = 'FAILED';
  evidence.failure = {
    classification: classify(error),
    message: shortMessage(error),
    detail: error?.detail ?? null,
  };
  log.fail(`${classify(error)} — ${shortMessage(error)}`);
  log.step(String(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.artifact = log.artifactPath;
  persist();
  log.step(`written ${evidencePath}`);
}
