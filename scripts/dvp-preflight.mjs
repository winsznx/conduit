#!/usr/bin/env node
/**
 * Everything that must be true before a twenty-five minute settlement starts.
 *
 *   node --env-file=.env scripts/dvp-preflight.mjs
 *
 * Attempt 3 spent twenty-five minutes reaching `issueCommit` and reverted on a
 * signature that could have been checked in the first second. Attempt 2 spent
 * twenty on a reservation the next node had not seen yet. Neither failure needed
 * a live settlement to find, and both cost one because nothing looked first.
 *
 * So this asks every question the run depends on, against the live deployment,
 * and fails on the first thing that is not true rather than at the point it
 * would have mattered. It sends no transaction: every check is a read, a
 * simulation, or a signature verified locally and then against the contract's
 * own view.
 *
 * The one thing it deliberately does not do is mint the commit attestations.
 * Base's measured economic finality is 1485 seconds and the coordinator's
 * `maxAttestationValidity` is an immutable 900, so an attestation created here
 * is expired before the finalized ASSET_PREPARED VAA exists. That is the design
 * working — commit-time compliance cannot be a prepare-time decision carried
 * forward — and the arithmetic is printed rather than worked around. What is
 * proven here is that the construction, the signer, and the verifier all agree;
 * the proofs the run submits are minted fresh after the wait.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { keccak256, recoverAddress } from 'viem';

import {
  ADAPTER_ABI,
  BASE_WORMHOLE_CHAIN_ID,
  COORDINATOR_ABI,
  CORE_ABI,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  ERC20_ABI,
  ESCROW_ABI,
  FINALITY,
  MONAD_EVM_CHAIN_ID,
  MONAD_WORMHOLE_CHAIN_ID,
  POLICY_ABI,
  RWA_ABI,
  buildIntent,
  cashLeg,
  eip712DomainSeparator,
  intentTuple,
  loadDvpConfig,
  padEmitter,
  reservation,
  settlement,
} from './lib/dvp.mjs';
import {
  attestationTuple,
  digestOf,
  foreignDomain,
  readAttestationDomain,
  signAttestation,
  singleFieldMutations,
} from './lib/attestation.mjs';
import { assertChainIdentity, readAcross, revertName, stringify } from './lib/chain.mjs';
import { cleanverseClientFromEnv } from './lib/cleanverse.mjs';
import { createLog, unbufferStdout } from './lib/observe.mjs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();
const log = createLog(join(ROOT, 'docs', 'evidence', 'artifacts', 'dvp-preflight.log'));

const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  log.stage(name);
}

/** Records a check and never lets one failure hide the ones after it. */
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ section: currentSection, name, ok: true, detail: detail ?? null });
    log.ok(`${name}${detail === undefined || detail === null ? '' : ` — ${stringify(detail)}`}`);
    return detail;
  } catch (error) {
    const reason = error instanceof Error ? (error.shortMessage ?? error.message) : String(error);
    results.push({ section: currentSection, name, ok: false, reason: reason.split('\n')[0] });
    log.fail(`${name} — ${reason.split('\n')[0]}`);
    return undefined;
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

const config = loadDvpConfig();
const { monad, base, addresses, deployer, complianceSigner } = config;
const { terms, settlementId } = buildIntent(config);

log.step(`settlement ${settlementId}`);
log.step(`deployer   ${deployer.address}`);
log.step(`signer     ${complianceSigner.address}`);
log.step(`monad providers ${monad.providers.join(', ')}`);
log.step(`base  providers ${base.providers.join(', ')}`);

// ── NETWORKS ────────────────────────────────────────────────────────────────

section('NETWORKS');

await check('monad testnet reports 10143 on every provider', async () => {
  const ids = await assertChainIdentity(monad);
  return ids.join(',');
});
await check('base sepolia reports 84532 on every provider', async () => {
  const ids = await assertChainIdentity(base);
  return ids.join(',');
});

await check('base has more than one independent provider', () => {
  must(
    base.pubs.length > 1,
    `only ${base.providers[0]} is configured; set BASE_SEPOLIA_RPC_URLS to a comma-separated ` +
      'list so a stale read can be told apart from a disagreement',
  );
  return `${base.pubs.length} providers`;
});

for (const [chain, coreAddress] of [
  [monad, addresses.wormholeMonad],
  [base, addresses.wormholeBase],
]) {
  await check(`${chain.name}: wormhole core has bytecode`, async () => {
    const code = await chain.pub.getCode({ address: coreAddress });
    must(code !== undefined && code.length > 2, `no bytecode at ${coreAddress}`);
    return `${(code.length - 2) / 2} bytes at ${coreAddress}`;
  });
  await check(`${chain.name}: wormhole core reports its own chain id`, async () => {
    const reported = await chain.pub.readContract({
      address: coreAddress,
      abi: CORE_ABI,
      functionName: 'chainId',
    });
    must(
      reported === chain.wormholeChainId,
      `core reports wormhole chain ${reported}, expected ${chain.wormholeChainId}`,
    );
    return reported;
  });
  await check(`${chain.name}: wormhole message fee is affordable`, async () => {
    const fee = await chain.pub.readContract({
      address: coreAddress,
      abi: CORE_ABI,
      functionName: 'messageFee',
    });
    const balance = await chain.pub.getBalance({ address: deployer.address });
    must(balance > fee, `native balance ${balance} does not cover the message fee ${fee}`);
    return `fee ${fee} wei, balance ${balance} wei`;
  });
}

const CONTRACTS = [
  ['SettlementCoordinator', monad, addresses.coordinator],
  ['CashEscrow', monad, addresses.escrow],
  ['ConduitSandboxSettlementCVA', monad, addresses.cash],
  ['ConduitRWACVA', base, addresses.rwa],
  ['RWACVASettlementAdapter', base, addresses.adapter],
];

for (const [name, chain, address] of CONTRACTS) {
  await check(`${name} has bytecode at ${address}`, async () => {
    const { value: code, agreed } = await readAcross(chain, (client) =>
      client.getCode({ address }),
    );
    must(code !== undefined && code.length > 2, 'no bytecode');
    must(agreed, 'providers returned different bytecode');
    return `codeHash ${keccak256(code)}`;
  });
}

await check('the deployment manifests describe what is deployed', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = join(ROOT, 'contracts', 'deployments');
  const manifests = readdirSync(dir)
    .filter((file) => file.endsWith('.json') && !file.includes('schema'))
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')));

  const problems = [];
  for (const [name, chain, address] of CONTRACTS) {
    const manifest = manifests.find((entry) => entry.contracts?.[name] !== undefined);
    if (manifest === undefined) {
      problems.push(`${name} appears in no manifest`);
      continue;
    }
    if (!sameAddress(manifest.contracts[name].address, address)) {
      problems.push(
        `${name}: manifest ${manifest.contracts[name].address}, environment ${address}`,
      );
      continue;
    }
    const code = await chain.pub.getCode({ address });
    const live = keccak256(code);
    if (manifest.bytecodeHashes[name] !== live) {
      problems.push(`${name}: manifest ${manifest.bytecodeHashes[name]}, live ${live}`);
    }
    if (manifest.deploymentId !== config.deploymentId) {
      problems.push(`${name}: manifest deploymentId ${manifest.deploymentId}`);
    }
  }
  must(problems.length === 0, problems.join('; '));
  return `${CONTRACTS.length} contracts match their manifest`;
});

// ── PEERS ───────────────────────────────────────────────────────────────────

section('PEERS');

const PEERING = [
  ['SettlementCoordinator', monad, addresses.coordinator, COORDINATOR_ABI, addresses.adapter],
  ['CashEscrow', monad, addresses.escrow, ESCROW_ABI, addresses.adapter],
  ['RWACVASettlementAdapter', base, addresses.adapter, ADAPTER_ABI, addresses.coordinator],
];

for (const [name, chain, address, abi, expectedPeer] of PEERING) {
  await check(`${name}: peer is locked to ${expectedPeer}`, async () => {
    const [emitter, locked] = await Promise.all([
      chain.pub.readContract({ address, abi, functionName: 'remoteEmitter' }),
      chain.pub.readContract({ address, abi, functionName: 'remotePeerLocked' }),
    ]);
    must(locked, 'remote peer is not locked; no VAA is consumable');
    must(
      emitter === padEmitter(expectedPeer),
      `emitter ${emitter}, expected ${padEmitter(expectedPeer)}`,
    );
    return emitter;
  });

  await check(`${name}: deployment id matches the environment`, async () => {
    const value = await chain.pub.readContract({ address, abi, functionName: 'deploymentId' });
    must(value === config.deploymentId, `contract ${value}, environment ${config.deploymentId}`);
    return value;
  });

  await check(`${name}: settlement finality is FINALIZED`, async () => {
    const level = await chain.pub.readContract({
      address,
      abi,
      functionName: 'settlementFinality',
    });
    must(level === 2, `settlementFinality is ${FINALITY[level] ?? level}, expected FINALIZED`);
    return FINALITY[level];
  });
}

await check('coordinator and adapter agree on the two wormhole chain ids', async () => {
  const [coordLocal, coordRemote, adapterLocal, adapterRemote] = await Promise.all([
    monad.pub.readContract({
      address: addresses.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'localWormholeChainId',
    }),
    monad.pub.readContract({
      address: addresses.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'remoteWormholeChainId',
    }),
    base.pub.readContract({
      address: addresses.adapter,
      abi: ADAPTER_ABI,
      functionName: 'localWormholeChainId',
    }),
    base.pub.readContract({
      address: addresses.adapter,
      abi: ADAPTER_ABI,
      functionName: 'remoteWormholeChainId',
    }),
  ]);
  must(coordLocal === MONAD_WORMHOLE_CHAIN_ID, `coordinator local ${coordLocal}`);
  must(coordRemote === BASE_WORMHOLE_CHAIN_ID, `coordinator remote ${coordRemote}`);
  must(adapterLocal === BASE_WORMHOLE_CHAIN_ID, `adapter local ${adapterLocal}`);
  must(adapterRemote === MONAD_WORMHOLE_CHAIN_ID, `adapter remote ${adapterRemote}`);
  must(coordLocal === adapterRemote && coordRemote === adapterLocal, 'the pair is not mirrored');
  return `${coordLocal} ↔ ${adapterLocal}`;
});

await check('each contract points at its own chain’s wormhole core', async () => {
  const [coordinatorCore, adapterCore] = await Promise.all([
    monad.pub.readContract({
      address: addresses.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'wormhole',
    }),
    base.pub.readContract({
      address: addresses.adapter,
      abi: ADAPTER_ABI,
      functionName: 'wormhole',
    }),
  ]);
  must(
    sameAddress(coordinatorCore, addresses.wormholeMonad),
    `coordinator core ${coordinatorCore}`,
  );
  must(sameAddress(adapterCore, addresses.wormholeBase), `adapter core ${adapterCore}`);
  return 'both';
});

// ── CVA AND POLICY ──────────────────────────────────────────────────────────

section('CVA/POLICY');

await check('the RWA CVA enforces the live Base CCP policy', async () => {
  const policy = await base.pub.readContract({
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'policy',
  });
  must(sameAddress(policy, addresses.policyBase), `token points at ${policy}`);
  const code = await base.pub.getCode({ address: policy });
  must(code !== undefined && code.length > 2, `policy ${policy} has no bytecode`);
  return policy;
});

await check('the cash CVA is a token with the expected shape', async () => {
  const [symbol, decimals, supply] = await Promise.all([
    monad.pub.readContract({ address: addresses.cash, abi: ERC20_ABI, functionName: 'symbol' }),
    monad.pub.readContract({ address: addresses.cash, abi: ERC20_ABI, functionName: 'decimals' }),
    monad.pub.readContract({
      address: addresses.cash,
      abi: ERC20_ABI,
      functionName: 'totalSupply',
    }),
  ]);
  return `${symbol} decimals ${decimals} supply ${supply}`;
});

const cleanverse = await cleanverseClientFromEnv().catch((error) => {
  log.warn(`Cleanverse client unavailable: ${String(error)}`);
  return undefined;
});

/**
 * `validator/is_register` and `validator/verify` are asked about a *registered
 * pool*, never about a token. On Monad the pool is `CashEscrow`, registered
 * through `ConduitVaultRegistrar`. Asking either of them about a token address
 * answers `registered: false` and `12027 Validator verify returned no data`,
 * which reads as "the platform is refusing us" and is a wrong argument.
 *
 * Base has no Conduit pool at all, because `validator/grant` there was refused
 * for this credential (ASM-037). The asset leg's eligibility therefore comes
 * from `verify_apass`, which is asked against the A-Token and works on both
 * chains.
 */
const POOLS = [['cash escrow pool', config.cleanverseChain.cash, addresses.escrow]];

if (cleanverse !== undefined) {
  const { validatorIsRegisterDataSchema, validatorIsPausedDataSchema } =
    await import('../packages/cleanverse/dist/schemas.js');

  for (const [label, chainSlug, poolAddress] of POOLS) {
    await check(`${label} is a registered validator pool`, async () => {
      const result = await cleanverse.call(
        'validatorIsRegister',
        { chain: chainSlug, contract_address: poolAddress },
        validatorIsRegisterDataSchema,
      );
      must(result.data.registered, `validator reports registered=false for ${poolAddress}`);
      return `${chainSlug} ${poolAddress}`;
    });

    await check(`${label} is not paused`, async () => {
      const result = await cleanverse.call(
        'validatorIsPaused',
        { chain: chainSlug, contract_address: poolAddress },
        validatorIsPausedDataSchema,
      );
      must(!result.data.paused, 'the validator reports this pool paused');
      return 'active';
    });
  }

  await check('the asset chain has no registered pool, and says so', async () => {
    const result = await cleanverse.call(
      'validatorIsRegister',
      { chain: config.cleanverseChain.asset, contract_address: addresses.rwa },
      validatorIsRegisterDataSchema,
    );
    must(
      !result.data.registered,
      'a Base pool now exists; validator/verify should be added as a second asset-side source',
    );
    return 'ASM-037 holds: verify_apass is the asset chain’s only eligibility source';
  });
}

// ── ROLES ───────────────────────────────────────────────────────────────────

section('ROLES');

await check('the adapter holds SETTLEMENT_ROLE and the deployer does not', async () => {
  const role = await base.pub.readContract({
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'SETTLEMENT_ROLE',
  });
  const [adapterHas, deployerHas] = await Promise.all([
    base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'hasRole',
      args: [role, addresses.adapter],
    }),
    base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'hasRole',
      args: [role, deployer.address],
    }),
  ]);
  must(adapterHas, 'the adapter cannot release a reservation');
  must(!deployerHas, 'an EOA holds SETTLEMENT_ROLE, which no deployment should allow');
  return 'adapter only';
});

await check('the deployer can mint the RWA', async () => {
  const role = await base.pub.readContract({
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'MINTER_ROLE',
  });
  const has = await base.pub.readContract({
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'hasRole',
    args: [role, deployer.address],
  });
  must(has, 'MINTER_ROLE is missing, so the seller cannot be topped up');
  return 'yes';
});

await check('the coordinator accepts the cash leg only from this escrow', async () => {
  const wired = await monad.pub.readContract({
    address: addresses.coordinator,
    abi: COORDINATOR_ABI,
    functionName: 'cashEscrow',
  });
  must(sameAddress(wired, addresses.escrow), `coordinator points at ${wired}`);
  return wired;
});

await check('the escrow points back at this coordinator and this asset', async () => {
  const [coordinator, cashAsset] = await Promise.all([
    monad.pub.readContract({
      address: addresses.escrow,
      abi: ESCROW_ABI,
      functionName: 'coordinator',
    }),
    monad.pub.readContract({
      address: addresses.escrow,
      abi: ESCROW_ABI,
      functionName: 'cashAsset',
    }),
  ]);
  must(sameAddress(coordinator, addresses.coordinator), `escrow coordinator ${coordinator}`);
  must(sameAddress(cashAsset, addresses.cash), `escrow asset ${cashAsset}`);
  return 'mutual';
});

await check('the adapter points at this token', async () => {
  const asset = await base.pub.readContract({
    address: addresses.adapter,
    abi: ADAPTER_ABI,
    functionName: 'asset',
  });
  must(sameAddress(asset, addresses.rwa), `adapter asset ${asset}`);
  return asset;
});

await check('preparations are not paused', async () => {
  const paused = await monad.pub.readContract({
    address: addresses.escrow,
    abi: ESCROW_ABI,
    functionName: 'preparationsPaused',
  });
  must(!paused, 'the escrow is refusing new preparations');
  return 'open';
});

const AUTHORITIES = [
  ['SettlementCoordinator', monad, addresses.coordinator, COORDINATOR_ABI],
  ['CashEscrow', monad, addresses.escrow, ESCROW_ABI],
  ['RWACVASettlementAdapter', base, addresses.adapter, ADAPTER_ABI],
];

for (const [name, chain, address, abi] of AUTHORITIES) {
  await check(
    `${name}: the compliance signer is authorized and the quorum is reachable`,
    async () => {
      const [authorized, quorum, signerCount] = await Promise.all([
        chain.pub.readContract({
          address,
          abi,
          functionName: 'isComplianceSigner',
          args: [complianceSigner.address],
        }),
        chain.pub.readContract({ address, abi, functionName: 'complianceQuorum' }),
        chain.pub.readContract({ address, abi, functionName: 'complianceSignerCount' }),
      ]);
      must(authorized, `${complianceSigner.address} is not an authorized signer`);
      must(quorum > 0n, 'the quorum is zero, so this contract refuses everything');
      must(quorum <= signerCount, `quorum ${quorum} exceeds ${signerCount} signers`);
      must(
        quorum === 1n,
        `quorum is ${quorum} and only one signing key is configured in this environment`,
      );
      return `quorum ${quorum} of ${signerCount} — ASM-036: a 1-of-1 threshold is a testnet property`;
    },
  );
}

// ── IDENTITIES ──────────────────────────────────────────────────────────────

section('IDENTITIES');

/** The same question, and the same sources, the commit proofs will use. */
const SUBJECTS = [
  ['cash payer', config.cleanverseChain.cash, addresses.cash, addresses.escrow, terms.cashPayer],
  [
    'cash receiver',
    config.cleanverseChain.cash,
    addresses.cash,
    addresses.escrow,
    terms.cashReceiver,
  ],
  ['asset seller', config.cleanverseChain.asset, addresses.rwa, undefined, terms.assetSeller],
  ['asset receiver', config.cleanverseChain.asset, addresses.rwa, undefined, terms.assetReceiver],
];

if (cleanverse !== undefined) {
  const { queryEligibility } = await import('../packages/cleanverse/dist/compliance.js');

  for (const [label, chainSlug, atoken, poolAddress, subject] of SUBJECTS) {
    await check(`${label} ${subject} is eligible now`, async () => {
      const decision = await queryEligibility(cleanverse, {
        chain: chainSlug,
        subject,
        atoken,
        poolAddress,
      });
      must(
        decision.eligible,
        `refused: ${decision.sources.map((s) => `${s.endpoint} ${s.answer}`).join(', ')}`,
      );
      return `${decision.sources.map((s) => `${s.endpoint} ${s.answer}`).join(', ')} → evidence ${decision.evidenceHash}`;
    });
  }
}

const TRANSFERS = [
  [
    'cash into escrow',
    monad,
    addresses.policyMonad,
    addresses.cash,
    terms.cashPayer,
    addresses.escrow,
    terms.cashAmount,
  ],
  [
    'cash out to the receiver',
    monad,
    addresses.policyMonad,
    addresses.cash,
    addresses.escrow,
    terms.cashReceiver,
    terms.cashAmount,
  ],
  [
    'the bond to the buyer',
    base,
    addresses.policyBase,
    addresses.rwa,
    terms.assetSeller,
    terms.assetReceiver,
    terms.assetAmount,
  ],
];

for (const [label, chain, policy, token, from, to, amount] of TRANSFERS) {
  await check(`the live policy permits ${label}`, async () => {
    const allowed = await chain.pub.readContract({
      address: policy,
      abi: POLICY_ABI,
      functionName: 'canTransfer',
      args: [token, from, to, amount],
    });
    must(allowed, `canTransfer(${token}, ${from}, ${to}, ${amount}) is false`);
    return 'true';
  });
}

// ── BALANCES ────────────────────────────────────────────────────────────────

section('BALANCES');

await check('the seller can cover the reservation, or can be topped up', async () => {
  const [held, reserved, available] = await Promise.all([
    base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'balanceOf',
      args: [terms.assetSeller],
    }),
    base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'reservedBalanceOf',
      args: [terms.assetSeller],
    }),
    base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'availableBalanceOf',
      args: [terms.assetSeller],
    }),
  ]);
  must(held - reserved === available, `R1 broken: ${held} - ${reserved} != ${available}`);
  return `held ${held} reserved ${reserved} available ${available} (need ${terms.assetAmount})`;
});

await check('the payer holds enough cash', async () => {
  const balance = await monad.pub.readContract({
    address: addresses.cash,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [terms.cashPayer],
  });
  must(balance >= terms.cashAmount, `payer holds ${balance}, needs ${terms.cashAmount}`);
  return `${balance}`;
});

await check('the escrow is allowed to take the cash', async () => {
  const allowance = await monad.pub.readContract({
    address: addresses.cash,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [terms.cashPayer, addresses.escrow],
  });
  must(
    allowance >= terms.cashAmount,
    `allowance ${allowance} is below ${terms.cashAmount}; the run will approve first`,
  );
  return `${allowance}`;
});

await check('the escrow’s books match its balance', async () => {
  const [accounted, actual] = await Promise.all([
    monad.pub.readContract({
      address: addresses.escrow,
      abi: ESCROW_ABI,
      functionName: 'totalEscrowed',
    }),
    monad.pub.readContract({
      address: addresses.cash,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [addresses.escrow],
    }),
  ]);
  must(actual >= accounted, `escrow accounts for ${accounted} and holds ${actual}`);
  return `accounted ${accounted}, held ${actual}`;
});

for (const chain of [monad, base]) {
  await check(`${chain.name}: the deployer can pay for gas`, async () => {
    const balance = await chain.pub.getBalance({ address: deployer.address });
    const gasPrice = await chain.pub.getGasPrice();
    // Nine writes on the worst chain, at four hundred thousand gas each, is the
    // shape of this run. A margin below that is a run that stops halfway.
    const needed = gasPrice * 400_000n * 9n;
    must(balance > needed, `balance ${balance} wei, want more than ${needed} wei`);
    return `${balance} wei at ${gasPrice} wei/gas`;
  });
}

// ── SETTLEMENT ──────────────────────────────────────────────────────────────

section('SETTLEMENT');

await check('the coordinator’s intent domain is the one this settlement id assumes', async () => {
  const onChain = await monad.pub.readContract({
    address: addresses.coordinator,
    abi: COORDINATOR_ABI,
    functionName: 'domainSeparator',
  });
  const recomputed = eip712DomainSeparator({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: MONAD_EVM_CHAIN_ID,
    verifyingContract: addresses.coordinator,
  });
  must(onChain === recomputed, `contract ${onChain}, recomputed ${recomputed}`);
  return onChain;
});

await check('the coordinator would derive this settlement id from these terms', async () => {
  // `_validateIntent` recomputes the digest and refuses a mismatch, so this is
  // the same arithmetic run ahead of the transaction rather than inside it.
  const simulated = await monad.pub
    .simulateContract({
      address: addresses.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'issueCommit',
      args: [intentTuple(terms), settlementId, '0x', '0x', [[], []], 1],
      account: deployer,
    })
    .then(() => undefined)
    .catch((error) => error);
  must(simulated !== undefined, 'issueCommit succeeded with no signatures, which cannot happen');
  const name = revertName(simulated);
  must(
    name !== 'IntentDoesNotMatchSettlementId',
    `the coordinator derives a different id from these terms: ${String(simulated.message).split('\n').slice(0, 4).join(' ')}`,
  );
  must(
    name !== 'WrongChainForCashLeg',
    'the coordinator is not on the cash chain this intent names',
  );
  // `NotReady` is the refusal that comes *after* the id and the chain have been
  // accepted, so reaching it proves both. Anything else means the terms are
  // wrong in a way the run would only discover after both legs were prepared.
  must(
    name === 'NotReady',
    `expected NotReady, got ${name ?? String(simulated.message).split('\n')[0]}`,
  );
  return 'NotReady — the id and the cash chain both matched';
});

await check('this settlement id is unused everywhere', async () => {
  const [coordinatorState, leg, receiver, reserved] = await Promise.all([
    monad.pub.readContract({
      address: addresses.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'settlementOf',
      args: [settlementId],
    }),
    monad.pub.readContract({
      address: addresses.escrow,
      abi: ESCROW_ABI,
      functionName: 'legOf',
      args: [settlementId],
    }),
    base.pub.readContract({
      address: addresses.adapter,
      abi: ADAPTER_ABI,
      functionName: 'intendedReceiver',
      args: [settlementId],
    }),
    base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'reservationOf',
      args: [settlementId],
    }),
  ]);
  must(
    settlement(coordinatorState).state === 'NONE',
    `coordinator: ${settlement(coordinatorState).state}`,
  );
  must(cashLeg(leg).state === 'NONE', `escrow leg: ${cashLeg(leg).state}`);
  must(receiver === '0x0000000000000000000000000000000000000000', `adapter receiver ${receiver}`);
  must(
    reservation(reserved).owner === '0x0000000000000000000000000000000000000000',
    `reservation already owned by ${reservation(reserved).owner}`,
  );
  return `nonce ${terms.nonce} is free`;
});

await check('both parties’ signatures recover to the parties the intent names', async () => {
  const buyerSignature = await deployer.sign({ hash: settlementId });
  const sellerSignature = await deployer.sign({ hash: settlementId });
  const [buyer, seller] = await Promise.all([
    recoverAddress({ hash: settlementId, signature: buyerSignature }),
    recoverAddress({ hash: settlementId, signature: sellerSignature }),
  ]);
  must(sameAddress(buyer, terms.cashPayer), `buyer signature recovers to ${buyer}`);
  must(sameAddress(seller, terms.assetSeller), `seller signature recovers to ${seller}`);
  return `${buyer} / ${seller}`;
});

await check('the deadlines leave room for Base finality', async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const margin = terms.commitDeadline - now;
  must(terms.prepareDeadline > now, 'the prepare deadline has already passed');
  must(margin > 2_400n, `only ${margin}s to the commit deadline; Base finality alone took 1485s`);
  return `${margin}s to the commit deadline, ${terms.releaseDeadline - now}s to release`;
});

// ── COMMIT ATTESTATION ──────────────────────────────────────────────────────

section('COMMIT ATTESTATION');

const domains = {};
for (const [name, chain, address] of [
  ['coordinator', monad, addresses.coordinator],
  ['escrow', monad, addresses.escrow],
  ['adapter', base, addresses.adapter],
]) {
  const domain = await check(
    `${name}: the attestation domain is the one we can construct`,
    async () => {
      const read = await readAttestationDomain(chain, address);
      return read;
    },
  );
  if (domain !== undefined) domains[name] = domain;
}

const coordinatorDomain = domains['coordinator'];

if (coordinatorDomain !== undefined) {
  const issuedAt = BigInt(Math.floor(Date.now() / 1000) - 30);
  const probe = {
    settlementId,
    intentHash: settlementId,
    subject: terms.cashPayer,
    eligible: true,
    issuedAt,
    expiresAt: issuedAt + (coordinatorDomain.maxValidity - 60n),
    evidenceHash: keccak256(new TextEncoder().encode('preflight-probe')),
  };

  const signed = await check(
    'a probe attestation signs and recovers to the intended signer',
    async () => {
      const result = await signAttestation({
        domain: coordinatorDomain,
        signer: complianceSigner,
        attestation: probe,
      });
      must(
        sameAddress(result.recovered, complianceSigner.address),
        `recovered ${result.recovered}`,
      );
      return result.digest;
    },
  );

  await check('the contract’s own view accepts the probe', async () => {
    const result = await signAttestation({
      domain: coordinatorDomain,
      signer: complianceSigner,
      attestation: probe,
    });
    const accepted = await monad.pub.readContract({
      address: addresses.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'verifyEligible',
      args: [
        settlementId,
        settlementId,
        probe.subject,
        [[attestationTuple(probe)], [result.signature]],
      ],
    });
    must(accepted, 'the coordinator refuses a proof this preflight considers correct');
    return 'accepted';
  });

  await check('every field of the attestation changes the digest', () => {
    const baseline = digestOf(coordinatorDomain.separator, probe);
    const unchanged = singleFieldMutations(probe)
      .filter(([, mutated]) => digestOf(coordinatorDomain.separator, mutated) === baseline)
      .map(([field]) => field);
    must(unchanged.length === 0, `these fields do not affect the digest: ${unchanged.join(', ')}`);
    return `${singleFieldMutations(probe).length} fields, all bound`;
  });

  await check('a signature over another contract’s domain does not verify here', async () => {
    const wrong = foreignDomain(coordinatorDomain, { verifyingContract: addresses.escrow });
    must(wrong.separator !== coordinatorDomain.separator, 'the two domains collided');
    const digest = digestOf(wrong.separator, probe);
    const signature = await complianceSigner.sign({ hash: digest });
    const recoveredAtCoordinator = await recoverAddress({
      hash: digestOf(coordinatorDomain.separator, probe),
      signature,
    });
    must(
      !sameAddress(recoveredAtCoordinator, complianceSigner.address),
      'a wrong-domain signature still recovered to the signer, which cannot happen',
    );
    const authorized = await monad.pub.readContract({
      address: addresses.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'isComplianceSigner',
      args: [recoveredAtCoordinator],
    });
    must(!authorized, `${recoveredAtCoordinator} is authorized, which defeats the binding`);
    return `recovers to the stranger ${recoveredAtCoordinator}, unauthorized`;
  });

  await check('the commit proofs cannot be minted here, and that is the design', () => {
    const measuredBaseFinality = 1_485n;
    must(
      coordinatorDomain.maxValidity < measuredBaseFinality,
      'the validity window now exceeds measured Base finality; re-derive this claim',
    );
    return (
      `maxAttestationValidity ${coordinatorDomain.maxValidity}s < measured Base finality ` +
      `${measuredBaseFinality}s, so a prepare-time decision cannot reach a commit`
    );
  });

  if (signed !== undefined) log.step(`probe digest ${signed}`);
}

// ── Report ──────────────────────────────────────────────────────────────────

const failed = results.filter((entry) => !entry.ok);
const bySection = new Map();
for (const entry of results) {
  bySection.set(entry.section, (bySection.get(entry.section) ?? 0) + (entry.ok ? 0 : 1));
}

log.stage('preflight summary');
for (const [name, failures] of bySection) {
  const total = results.filter((entry) => entry.section === name).length;
  const line = `${name.padEnd(20)} ${total - failures}/${total}`;
  if (failures === 0) log.ok(line);
  else log.fail(line);
}

const evidence = {
  capturedAt: new Date().toISOString(),
  settlementId,
  nonce: String(terms.nonce),
  outcome: failed.length === 0 ? 'READY' : 'BLOCKED',
  providers: { monadTestnet: monad.providers, baseSepolia: base.providers },
  addresses,
  checks: results,
  note:
    'The commit attestations are deliberately not minted here. maxAttestationValidity is an ' +
    'immutable 900s and measured Base economic finality is 1485s, so an attestation created ' +
    'before the wait is expired when the finalized VAA arrives. Commit-time compliance is ' +
    'therefore structural rather than a convention the runner has to remember.',
};

const path = join(ROOT, 'docs', 'evidence', 'phase-06-dvp-preflight.json');
writeFileSync(
  path,
  `${JSON.stringify(evidence, (_key, value) => (typeof value === 'bigint' ? String(value) : value), 2)}\n`,
);
log.step(`written ${path}`);

if (failed.length > 0) {
  log.fail(`${failed.length} check(s) failed; not starting a live settlement`);
  process.exit(1);
}
log.ok('preflight green — the run may start');
