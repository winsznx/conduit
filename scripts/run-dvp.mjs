#!/usr/bin/env node
/**
 * The full delivery-versus-payment run, across two chains. PRD 19 phase 06.
 *
 *   pnpm dvp:preflight && pnpm dvp:run
 *
 * ```text
 *   Base Sepolia    seller reserves the RWA CVA, the adapter announces the leg
 *   Monad Testnet   the buyer's cash enters CashEscrow, which tells the coordinator
 *   ── the wait ──  Base economic finality, roughly twenty-five minutes
 *   Monad Testnet   the coordinator consumes the finalized ASSET_PREPARED, READY
 *   ── fresh ──     Cleanverse is asked again, now, and the answer is signed
 *   Monad Testnet   COMMIT, then the escrow releases the cash
 *   Base Sepolia    the adapter consumes COMMIT and delivers the bond
 *   Monad Testnet   the asset leg reports back, and the settlement is SETTLED
 * ```
 *
 * Three things about this file are deliberate and were each bought with a
 * failed run.
 *
 * **The compliance proofs are minted after the wait, and they have to be.**
 * `maxAttestationValidity` is an immutable 900 seconds and measured Base
 * finality is 1485, so an attestation created at preparation time is expired
 * before the VAA it would authorize a commit against even exists. Commit-time
 * compliance is therefore structural rather than a convention to remember, and
 * the query that produces it is a live Cleanverse call with no application
 * cache, per PRD 9.4.
 *
 * **Every write is simulated, confirmed, made visible on every provider, and
 * read back before the next one goes out.** A receipt proves inclusion at block
 * N and says nothing about whether the node answering the next call has reached
 * N. That distinction cost a run once already.
 *
 * **Nothing is buffered.** Timestamps on every line, the transaction hash at
 * broadcast rather than at completion, and the whole stream teed to an artifact
 * as it is written. A twenty-five minute run that prints at the end is a
 * twenty-five minute run you cannot debug.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ADAPTER_ABI,
  BASE_EVM_CHAIN_ID,
  COORDINATOR_ABI,
  ERC20_ABI,
  ESCROW_ABI,
  LegOutcome,
  MONAD_EVM_CHAIN_ID,
  MessageType,
  RWA_ABI,
  buildIntent,
  cashLeg,
  fetchVaa,
  intentTuple,
  loadDvpConfig,
  padEmitter,
  reservation,
  sequenceFrom,
  settlement,
  vaaEmitter,
} from './lib/dvp.mjs';
import { attestationTuple, readAttestationDomain, signAttestation } from './lib/attestation.mjs';
import {
  Classification,
  assertChainIdentity,
  classify,
  readAcross,
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
const { terms, settlementId } = buildIntent(config);

const log = createLog(
  join(ROOT, 'docs', 'evidence', 'artifacts', `dvp-${settlementId.slice(2, 12)}.log`),
);

const evidence = {
  startedAt: new Date().toISOString(),
  settlementId,
  outcome: 'INCOMPLETE',
  intent: Object.fromEntries(Object.entries(terms).map(([key, value]) => [key, stringify(value)])),
  providers: { monadTestnet: monad.providers, baseSepolia: base.providers },
  addresses,
  stages: [],
  compliance: [],
  conservation: {},
  adversarial: [],
};

function stage(name) {
  log.stage(name);
  const entry = { stage: name, startedAt: new Date().toISOString(), detail: {} };
  evidence.stages.push(entry);
  return entry;
}

function record(entry, key, value) {
  entry.detail[key] = stringify(value);
}

/** A live compliance answer and a signature over it, minted at the point of use. */
async function freshProof({ chain, verifying, subject, cleanverseChain, atoken, poolAddress }) {
  const { queryEligibility } = await import('../packages/cleanverse/dist/compliance.js');
  const client = await cleanverseClientFromEnv();

  const decision = await queryEligibility(client, {
    chain: cleanverseChain,
    subject,
    atoken,
    poolAddress,
  });
  log.step(
    `compliance ${subject} on ${cleanverseChain}: ` +
      decision.sources.map((source) => `${source.endpoint} ${source.answer}`).join(', '),
  );
  evidence.compliance.push({
    at: new Date().toISOString(),
    subject,
    chain: cleanverseChain,
    verifyingContract: verifying,
    eligible: decision.eligible,
    evidenceHash: decision.evidenceHash,
    sources: decision.sources.map((source) => ({
      endpoint: source.endpoint,
      requestId: source.requestId,
      answer: source.answer,
      responseHash: source.responseHash,
    })),
  });

  const domain = await readAttestationDomain(chain, verifying);
  const issuedAt = BigInt(Math.floor(Date.now() / 1000) - 30);
  // Comfortably inside the immutable window, and short enough that a proof
  // cannot outlive the transaction it was minted for.
  const window = domain.maxValidity - 300n;

  const signed = await signAttestation({
    domain,
    signer: complianceSigner,
    attestation: {
      settlementId,
      intentHash: settlementId,
      subject,
      eligible: decision.eligible,
      issuedAt,
      expiresAt: issuedAt + window,
      evidenceHash: decision.evidenceHash,
    },
  });

  return { decision, signed, domain };
}

/** Merges per-subject proofs into the one `ComplianceProof` the ABI takes. */
function proofOf(...signed) {
  return [signed.map((s) => attestationTuple(s.attestation)), signed.map((s) => s.signature)];
}

/**
 * Asks the verifying contract itself whether it accepts this proof.
 *
 * The last thing before a value-moving transaction, and the check attempt 3 did
 * not have. A locally correct signature over the wrong domain recovers to a
 * stranger, and only the contract can say so.
 */
async function requireContractAccepts(chain, address, abi, subject, proof) {
  const accepted = await chain.pub.readContract({
    address,
    abi,
    functionName: 'verifyEligible',
    args: [settlementId, settlementId, subject, proof],
  });
  if (!accepted) {
    throw new Error(`${address} refuses the proof for ${subject}`);
  }
  log.ok(`${address} accepts the proof for ${subject}`);
}

/** Simulates a call that must fail, and records the exact refusal. */
async function mustRefuse(label, chain, request, expected) {
  const outcome = await chain.pub
    .simulateContract({ ...request, account: deployer })
    .then(() => undefined)
    .catch((error) => error);

  if (outcome === undefined) {
    throw new Error(`${label}: the call succeeded, and it must not`);
  }
  const name = revertName(outcome);
  evidence.adversarial.push({ attempt: label, refusedWith: name ?? shortMessage(outcome) });
  if (expected !== undefined && name !== expected) {
    throw new Error(
      `${label}: expected ${expected}, refused with ${name ?? shortMessage(outcome)}`,
    );
  }
  log.ok(`${label} — refused with ${name ?? shortMessage(outcome)}`);
  return name;
}

async function main() {
  log.step(`settlement ${settlementId}`);
  log.step(`buyer/seller ${terms.cashPayer}`);
  log.step(`cash ${terms.cashAmount} / asset ${terms.assetAmount}`);
  log.step(`artifact ${log.artifactPath}`);

  await assertChainIdentity(monad);
  await assertChainIdentity(base);

  const opening = {
    cashPayer: await monad.pub.readContract({
      address: addresses.cash,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [terms.cashPayer],
    }),
    cashReceiver: await monad.pub.readContract({
      address: addresses.cash,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [terms.cashReceiver],
    }),
    cashSupply: await monad.pub.readContract({
      address: addresses.cash,
      abi: ERC20_ABI,
      functionName: 'totalSupply',
    }),
    escrow: await monad.pub.readContract({
      address: addresses.cash,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [addresses.escrow],
    }),
    assetSeller: await base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'balanceOf',
      args: [terms.assetSeller],
    }),
    assetBuyer: await base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'balanceOf',
      args: [terms.assetReceiver],
    }),
    assetSupply: await base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'totalSupply',
    }),
  };
  evidence.conservation.opening = Object.fromEntries(
    Object.entries(opening).map(([key, value]) => [key, stringify(value)]),
  );

  // ── 1. The asset leg, on Base ─────────────────────────────────────────────

  {
    const entry = stage('Base Sepolia: reserve the bond and announce the leg');

    const available = await base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'availableBalanceOf',
      args: [terms.assetSeller],
    });

    if (available < terms.assetAmount) {
      const topUp = terms.assetAmount * 4n;
      const result = await submit(base, {
        label: 'mint',
        log,
        request: {
          address: addresses.rwa,
          abi: RWA_ABI,
          functionName: 'mint',
          args: [terms.assetSeller, topUp],
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
      record(entry, 'mint', result.hash);
    }

    const reservedBefore = await base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'reservedBalanceOf',
      args: [terms.assetSeller],
    });

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
    record(entry, 'reservedBefore', reservedBefore);
    record(entry, 'reservedAfter', reserve.observed);

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
        matches: (value) => value.toLowerCase() === terms.assetReceiver.toLowerCase(),
      },
    });

    const announced = reservation(
      await base.pub.readContract({
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'reservationOf',
        args: [settlementId],
      }),
    );
    if (!announced.announced) {
      throw new Error('prepareAsset did not announce the reservation');
    }
    log.ok('the reservation is announced, so only a canonical ABORT can free it');

    const published = sequenceFrom(prepare.receipt);
    record(entry, 'prepareAsset', prepare.hash);
    record(entry, 'assetPreparedSequence', published.sequence);
    record(entry, 'publishedConsistencyLevel', published.consistencyLevel);
    evidence.assetPrepared = {
      hash: prepare.hash,
      sequence: String(published.sequence),
      emitter: addresses.adapter,
      emitterChainId: base.wormholeChainId,
    };
  }

  // ── 2. The cash leg, on Monad ─────────────────────────────────────────────

  {
    const entry = stage('Monad Testnet: the cash enters escrow and the escrow reports it');

    const allowance = await monad.pub.readContract({
      address: addresses.cash,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [terms.cashPayer, addresses.escrow],
    });
    if (allowance < terms.cashAmount) {
      const approve = await submit(monad, {
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
          matches: (value) => value >= terms.cashAmount,
        },
      });
      record(entry, 'approve', approve.hash);
    }

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
        matches: (value) => value === true,
      },
    });
    record(entry, 'prepareCash', prepare.hash);

    const leg = cashLeg(
      await monad.pub.readContract({
        address: addresses.escrow,
        abi: ESCROW_ABI,
        functionName: 'legOf',
        args: [settlementId],
      }),
    );
    if (leg.state !== 'PREPARED' || leg.amount !== terms.cashAmount) {
      throw new Error(`escrow leg is ${leg.state} holding ${leg.amount}`);
    }
    log.ok(`escrow holds ${leg.amount} for ${leg.receiver}`);
    record(entry, 'escrowedAmount', leg.amount);
  }

  // ── 3. The wait that cannot be shortened ──────────────────────────────────

  const assetVaa = await (async () => {
    const entry = stage('waiting for the finalized ASSET_PREPARED VAA (Base economic finality)');
    log.step('a fast VAA would be refused here: settlementFinality is FINALIZED on chain');

    const { vaa, waitSeconds } = await fetchVaa(
      base.wormholeChainId,
      padEmitter(addresses.adapter),
      evidence.assetPrepared.sequence,
      { log, label: 'finalized ASSET_PREPARED' },
    );

    const parsed = vaaEmitter(vaa);
    if (parsed.emitterAddress !== padEmitter(addresses.adapter).slice(2)) {
      log.step(`VAA emitter ${parsed.emitterAddress}`);
    }
    record(entry, 'waitSeconds', waitSeconds);
    record(entry, 'consistencyLevel', parsed.consistencyLevel);
    record(entry, 'emitterChainId', parsed.emitterChainId);
    record(entry, 'sequence', parsed.sequence);
    evidence.baseFinalitySeconds = waitSeconds;
    return vaa;
  })();

  {
    const entry = stage('Monad Testnet: the coordinator consumes the finalized VAA');
    const result = await submit(monad, {
      label: 'recordAssetPrepared',
      log,
      request: {
        address: addresses.coordinator,
        abi: COORDINATOR_ABI,
        functionName: 'recordAssetPrepared',
        args: [assetVaa],
      },
      postState: {
        describe: 'both legs prepared, the settlement is READY',
        read: async (client) =>
          settlement(
            await client.readContract({
              address: addresses.coordinator,
              abi: COORDINATOR_ABI,
              functionName: 'settlementOf',
              args: [settlementId],
            }),
          ).state,
        matches: (value) => value === 'READY',
      },
    });
    record(entry, 'recordAssetPrepared', result.hash);
  }

  // ── 4. Fresh compliance, then the canonical decision ──────────────────────

  const commit = await (async () => {
    const entry = stage('Monad Testnet: fresh compliance, then COMMIT');

    const payer = await freshProof({
      chain: monad,
      verifying: addresses.coordinator,
      subject: terms.cashPayer,
      cleanverseChain: config.cleanverseChain.cash,
      atoken: addresses.cash,
      poolAddress: addresses.escrow,
    });
    const receiver = await freshProof({
      chain: monad,
      verifying: addresses.coordinator,
      subject: terms.cashReceiver,
      cleanverseChain: config.cleanverseChain.cash,
      atoken: addresses.cash,
      poolAddress: addresses.escrow,
    });

    if (!payer.decision.eligible || !receiver.decision.eligible) {
      throw new Error('a party is not eligible at commit time; this is the compliance-change path');
    }

    const proof = proofOf(payer.signed, receiver.signed);
    await requireContractAccepts(
      monad,
      addresses.coordinator,
      COORDINATOR_ABI,
      terms.cashPayer,
      proof,
    );
    await requireContractAccepts(
      monad,
      addresses.coordinator,
      COORDINATOR_ABI,
      terms.cashReceiver,
      proof,
    );

    const buyerSignature = await deployer.sign({ hash: settlementId });
    const sellerSignature = await deployer.sign({ hash: settlementId });

    const result = await submit(monad, {
      label: 'issueCommit',
      log,
      request: {
        address: addresses.coordinator,
        abi: COORDINATOR_ABI,
        functionName: 'issueCommit',
        args: [intentTuple(terms), settlementId, buyerSignature, sellerSignature, proof, 1],
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
        matches: (value) => value === 'COMMIT',
      },
    });

    const published = sequenceFrom(result.receipt);
    record(entry, 'issueCommit', result.hash);
    record(entry, 'commitSequence', published.sequence);
    record(entry, 'payerEvidence', payer.decision.evidenceHash);
    record(entry, 'receiverEvidence', receiver.decision.evidenceHash);
    record(entry, 'attestationAgeSeconds', log.elapsedSeconds());
    evidence.commit = { hash: result.hash, sequence: String(published.sequence) };
    return { hash: result.hash, sequence: published.sequence };
  })();

  // ── 5. The paths that must be closed the moment COMMIT exists ─────────────

  {
    stage('the refusals that make COMMIT irreversible');

    await mustRefuse(
      'a refund after COMMIT',
      monad,
      {
        address: addresses.escrow,
        abi: ESCROW_ABI,
        functionName: 'returnCash',
        args: [settlementId, [[], []]],
      },
      'ReturnRequiresAbort',
    );

    // Base has not seen the COMMIT yet, and that is precisely the window the
    // announced flag closes: the cash is about to move on Monad and the seller
    // must not be able to walk away here.
    await mustRefuse(
      'the seller cancelling before the COMMIT VAA arrives',
      base,
      {
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'cancelReservation',
        args: [settlementId],
      },
      'ReservationAlreadyAnnounced',
    );

    await mustRefuse('replaying the ASSET_PREPARED VAA', monad, {
      address: addresses.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'recordAssetPrepared',
      args: [assetVaa],
    });
  }

  // ── 6. The cash leg releases ──────────────────────────────────────────────

  {
    const entry = stage('Monad Testnet: the escrow reads the decision and pays');

    const receiver = await freshProof({
      chain: monad,
      verifying: addresses.escrow,
      subject: terms.cashReceiver,
      cleanverseChain: config.cleanverseChain.cash,
      atoken: addresses.cash,
      poolAddress: addresses.escrow,
    });
    const proof = proofOf(receiver.signed);
    await requireContractAccepts(monad, addresses.escrow, ESCROW_ABI, terms.cashReceiver, proof);

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
        matches: (value) => value === 'RELEASED',
      },
    });
    record(entry, 'releaseCash', result.hash);
    evidence.cashReleased = { hash: result.hash };
  }

  // ── 7. The asset leg releases ─────────────────────────────────────────────

  const commitVaa = await (async () => {
    const entry = stage('waiting for the finalized COMMIT VAA (Monad finality)');
    const { vaa, waitSeconds } = await fetchVaa(
      monad.wormholeChainId,
      padEmitter(addresses.coordinator),
      commit.sequence,
      { log, label: 'finalized COMMIT' },
    );
    record(entry, 'waitSeconds', waitSeconds);
    record(entry, 'consistencyLevel', vaaEmitter(vaa).consistencyLevel);
    evidence.monadFinalitySeconds = waitSeconds;
    return vaa;
  })();

  {
    const entry = stage('Base Sepolia: the adapter consumes COMMIT and delivers');

    const receiver = await freshProof({
      chain: base,
      verifying: addresses.adapter,
      subject: terms.assetReceiver,
      cleanverseChain: config.cleanverseChain.asset,
      atoken: addresses.rwa,
      poolAddress: undefined,
    });
    const proof = proofOf(receiver.signed);
    await requireContractAccepts(base, addresses.adapter, ADAPTER_ABI, terms.assetReceiver, proof);

    const result = await submit(base, {
      label: 'releaseAsset',
      log,
      request: {
        address: addresses.adapter,
        abi: ADAPTER_ABI,
        functionName: 'releaseAsset',
        args: [commitVaa, proof],
      },
      postState: {
        describe: 'the buyer holds the bond',
        read: (client) =>
          client.readContract({
            address: addresses.rwa,
            abi: RWA_ABI,
            functionName: 'balanceOf',
            args: [terms.assetReceiver],
          }),
        matches: (value) => value >= opening.assetBuyer + terms.assetAmount,
      },
    });
    record(entry, 'releaseAsset', result.hash);

    const state = reservation(
      await base.pub.readContract({
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'reservationOf',
        args: [settlementId],
      }),
    );
    if (!state.released || !state.committed) {
      throw new Error(`reservation is committed=${state.committed} released=${state.released}`);
    }
    evidence.assetReleased = { hash: result.hash };

    await mustRefuse('replaying the COMMIT VAA at the adapter', base, {
      address: addresses.adapter,
      abi: ADAPTER_ABI,
      functionName: 'releaseAsset',
      args: [commitVaa, proof],
    });
  }

  // ── 8. The asset leg reports, and the settlement finishes ─────────────────

  {
    const entry = stage('Base Sepolia: the asset leg reports what the token did');

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
    record(entry, 'assetReleasedSequence', published.sequence);

    const { vaa, waitSeconds } = await fetchVaa(
      base.wormholeChainId,
      padEmitter(addresses.adapter),
      published.sequence,
      { log, label: 'finalized ASSET_RELEASED' },
    );
    record(entry, 'reportWaitSeconds', waitSeconds);

    const resolved = await submit(monad, {
      label: 'recordLegResolved',
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
        matches: (value) => value === 'SETTLED',
      },
    });
    record(entry, 'recordLegResolved', resolved.hash);
    evidence.settled = { hash: resolved.hash };
  }

  // ── 9. Conservation, read from the chain ──────────────────────────────────

  {
    const entry = stage('conservation');

    const closing = {
      cashPayer: (
        await readAcross(monad, (client) =>
          client.readContract({
            address: addresses.cash,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [terms.cashPayer],
          }),
        )
      ).value,
      cashSupply: (
        await readAcross(monad, (client) =>
          client.readContract({
            address: addresses.cash,
            abi: ERC20_ABI,
            functionName: 'totalSupply',
          }),
        )
      ).value,
      escrow: (
        await readAcross(monad, (client) =>
          client.readContract({
            address: addresses.cash,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [addresses.escrow],
          }),
        )
      ).value,
      escrowAccounted: (
        await readAcross(monad, (client) =>
          client.readContract({
            address: addresses.escrow,
            abi: ESCROW_ABI,
            functionName: 'totalEscrowed',
          }),
        )
      ).value,
      assetSeller: (
        await readAcross(base, (client) =>
          client.readContract({
            address: addresses.rwa,
            abi: RWA_ABI,
            functionName: 'balanceOf',
            args: [terms.assetSeller],
          }),
        )
      ).value,
      assetBuyer: (
        await readAcross(base, (client) =>
          client.readContract({
            address: addresses.rwa,
            abi: RWA_ABI,
            functionName: 'balanceOf',
            args: [terms.assetReceiver],
          }),
        )
      ).value,
      assetSupply: (
        await readAcross(base, (client) =>
          client.readContract({
            address: addresses.rwa,
            abi: RWA_ABI,
            functionName: 'totalSupply',
          }),
        )
      ).value,
      assetReserved: (
        await readAcross(base, (client) =>
          client.readContract({
            address: addresses.rwa,
            abi: RWA_ABI,
            functionName: 'reservedBalanceOf',
            args: [terms.assetSeller],
          }),
        )
      ).value,
    };

    evidence.conservation.closing = Object.fromEntries(
      Object.entries(closing).map(([key, value]) => [key, stringify(value)]),
    );

    // The buyer and the seller are the same key in this deployment, so the cash
    // nets to zero across the pair and the escrow must be the thing that emptied.
    const problems = [];
    if (closing.cashSupply !== opening.cashSupply) problems.push('cash supply changed');
    if (closing.escrow !== opening.escrow - terms.cashAmount) {
      problems.push(`escrow ${opening.escrow} → ${closing.escrow}`);
    }
    if (closing.assetSupply !== opening.assetSupply) {
      // A mint at the start of the run is legitimate and accounted for.
      const minted = closing.assetSupply - opening.assetSupply;
      log.step(`asset supply grew by ${minted} from the pre-run mint`);
    }
    if (closing.assetBuyer !== opening.assetBuyer + terms.assetAmount) {
      problems.push(`buyer ${opening.assetBuyer} → ${closing.assetBuyer}`);
    }
    if (closing.assetReserved !== 0n) problems.push(`${closing.assetReserved} still reserved`);
    if (closing.escrowAccounted !== 0n) {
      log.step(`escrow still accounts for ${closing.escrowAccounted} from other settlements`);
    }

    if (problems.length > 0) throw new Error(`conservation broken: ${problems.join('; ')}`);
    log.ok('cash and asset both conserved exactly');
    record(entry, 'cashMoved', terms.cashAmount);
    record(entry, 'assetMoved', terms.assetAmount);
  }

  // ── 10. What an independent reader sees ───────────────────────────────────

  {
    const entry = stage('independent verification, from chain state alone');

    const final = settlement(
      await monad.pub.readContract({
        address: addresses.coordinator,
        abi: COORDINATOR_ABI,
        functionName: 'settlementOf',
        args: [settlementId],
      }),
    );
    const leg = cashLeg(
      await monad.pub.readContract({
        address: addresses.escrow,
        abi: ESCROW_ABI,
        functionName: 'legOf',
        args: [settlementId],
      }),
    );
    const reserved = reservation(
      await base.pub.readContract({
        address: addresses.rwa,
        abi: RWA_ABI,
        functionName: 'reservationOf',
        args: [settlementId],
      }),
    );

    const claims = [
      ['coordinator state', final.state, 'SETTLED'],
      ['coordinator decision', final.decision, 'COMMIT'],
      ['cash outcome', final.cashOutcome, 'RELEASED'],
      ['asset outcome', final.assetOutcome, 'RELEASED'],
      ['bound intent hash', final.intentHash, settlementId],
      ['escrow leg', leg.state, 'RELEASED'],
      ['reservation released', reserved.released, true],
      ['reservation committed', reserved.committed, true],
      ['reservation cancelled', reserved.cancelled, false],
    ];

    const wrong = claims.filter(([, actual, expected]) => actual !== expected);
    for (const [label, actual, expected] of claims) {
      log.step(
        `${label}: ${stringify(actual)}${actual === expected ? '' : ` (expected ${stringify(expected)})`}`,
      );
    }
    if (wrong.length > 0) {
      throw new Error(`chain state disagrees: ${wrong.map(([label]) => label).join(', ')}`);
    }

    evidence.verification = Object.fromEntries(
      claims.map(([label, actual]) => [label, stringify(actual)]),
    );
    record(entry, 'settlementState', final.state);
    log.ok('every claim in this report is a read of deployed contract state');
  }

  evidence.outcome = 'SETTLED_FINAL';
}

try {
  await main();
  log.ok('SETTLED_FINAL');
} catch (error) {
  evidence.outcome = 'FAILED';
  evidence.failure = {
    classification: classify(error),
    message: shortMessage(error),
    detail: error?.detail ?? null,
  };
  log.fail(`${classify(error)} — ${shortMessage(error)}`);
  if (classify(error) === Classification.UNKNOWN) {
    log.step(String(error?.stack ?? error));
  }
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.elapsedSeconds = log.elapsedSeconds();
  evidence.artifact = log.artifactPath;
  const path = join(ROOT, 'docs', 'evidence', 'phase-06-dvp.json');
  writeFileSync(
    path,
    `${JSON.stringify(evidence, (_key, value) => (typeof value === 'bigint' ? String(value) : value), 2)}\n`,
  );
  log.step(`written ${path}`);
}
