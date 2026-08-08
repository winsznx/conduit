#!/usr/bin/env node
/**
 * Wires the Disposition Kernel into a deployed generation, and seeds it.
 *
 *   node --env-file=.env scripts/wire-disposition-kernel.mjs
 *
 * Two contracts per chain and four set-once bindings: each escrow learns its
 * controller, each controller learns its executor. Neither can be set at
 * construction because they reference each other, and neither can be changed
 * afterwards — the same shape as the Wormhole peer, for the same reason. An
 * owner who could repoint a live controller could redirect a held settlement.
 *
 * It then seeds the authority model so the kernel is usable rather than merely
 * present: one policy, the five authority classes the live runs need, and the
 * destination allow-lists each order type reads. Every grant waits out the
 * registry's `grantDelay` before it activates, which this script waits through
 * rather than around.
 *
 * The authority keys are derived from the deployer, not invented. There is one
 * controlled identity in this sandbox (ASM-035) and pretending otherwise would
 * put fictional signers in the evidence. What the addresses demonstrate is the
 * separation of *classes*: an ISSUER address cannot sign what only a
 * GATEWAY_OPERATOR may sign, and the registry enforces that regardless of who
 * holds the keys.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { keccak256, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { assertChainIdentity, submit, until } from './lib/chain.mjs';
import { loadDvpConfig } from './lib/dvp.mjs';
import { createLog, unbufferStdout } from './lib/observe.mjs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();
const log = createLog(join(ROOT, 'docs', 'evidence', 'artifacts', 'wire-disposition-kernel.log'));

const config = loadDvpConfig();
const { monad, base, addresses, deployer } = config;

const ESCROW_ABI = parseAbi([
  'function dispositionController() view returns (address)',
  'function setDispositionController(address controller)',
]);

const CONTROLLER_ABI = parseAbi([
  'function executorFor(uint8 leg) view returns (address)',
  'function setExecutor(uint8 leg, address executor)',
  'function registry() view returns (address)',
  'function deploymentId() view returns (bytes32)',
  'function domainSeparator() view returns (bytes32)',
]);

const REGISTRY_ABI = parseAbi([
  'function grantDelay() view returns (uint64)',
  'function proposeAuthority(address account, uint8 authorityType)',
  'function activateAuthority(address account)',
  'function authorityOf(address account) view returns ((uint8,bool,uint64))',
  'function pendingAuthorityAt(address account) view returns (uint64)',
  'function setPolicy(bytes32 policyId, (bool,uint32,uint16,uint16,uint8,uint8[6]) policy)',
  'function policyHash(bytes32 policyId) view returns (bytes32)',
  'function setIdentityCommitment(address account, bytes32 commitment)',
  'function identityCommitmentOf(address account) view returns (bytes32)',
  'function proposeRestrictedCustodian(address account)',
  'function activateRestrictedCustodian(address account)',
  'function isRestrictedCustodian(address account) view returns (bool)',
  'function proposeGatewayAccount(address account)',
  'function activateGatewayAccount(address account)',
  'function isGatewayAccount(address account) view returns (bool)',
  'function proposeSubstitute(address original, address substitute)',
  'function activateSubstitute(address original, address substitute)',
  'function isApprovedSubstitute(address original, address substitute) view returns (bool)',
]);

const LEG = { CASH: 0, ASSET: 1 };
const AUTHORITY = {
  SUBJECT: 0,
  COUNTERPARTY: 1,
  ISSUER: 2,
  TRANSFER_AGENT: 3,
  COMPLIANCE_OPERATOR: 4,
  GATEWAY_OPERATOR: 5,
  MULTISIG: 6,
};

const POLICY_ID = keccak256(toHex('conduit-disposition-policy-v1'));

/**
 * `requiredSignatures`, indexed by `DispositionType`.
 *
 * Two for a rebind, because it sends committed value to a wallet the
 * counterparties never named and PRD 5.4 puts an operator process behind it.
 * One signature is not a process.
 */
const REQUIRED_SIGNATURES = [1, 2, 1, 1, 1, 1];

const bit = (authorityType) => 1 << authorityType;

const SIGNERS =
  bit(AUTHORITY.ISSUER) |
  bit(AUTHORITY.TRANSFER_AGENT) |
  bit(AUTHORITY.COMPLIANCE_OPERATOR) |
  bit(AUTHORITY.GATEWAY_OPERATOR) |
  bit(AUTHORITY.SUBJECT);

/** Deliberately narrower than the signing set: creating a conflict is not resolving one. */
const RESOLVERS = bit(AUTHORITY.TRANSFER_AGENT);

/**
 * How long a filed order rests before it may execute.
 *
 * PRD FR-012's conflict rule is unenforceable without it — the first order would
 * simply win. Short enough here that a live demonstration can wait it out, and
 * the value it protects is protected for exactly as long as it is set.
 */
const CONTEST_WINDOW = Number(process.env['DISPOSITION_CONTEST_WINDOW'] ?? 300);

const POLICY = [true, CONTEST_WINDOW, SIGNERS, RESOLVERS, 1, REQUIRED_SIGNATURES];

/** One key per class, derived so the derivation is reproducible from the deployer. */
function authorityKey(role) {
  return keccak256(toHex(`conduit-authority:${role}:${deployer.address.toLowerCase()}`));
}

const AUTHORITIES = [
  ['issuer', AUTHORITY.ISSUER],
  ['transferAgent', AUTHORITY.TRANSFER_AGENT],
  ['complianceOperator', AUTHORITY.COMPLIANCE_OPERATOR],
  ['gatewayOperator', AUTHORITY.GATEWAY_OPERATOR],
].map(([role, authorityType]) => {
  const account = privateKeyToAccount(authorityKey(role));
  return { role, authorityType, address: account.address, privateKey: authorityKey(role) };
});

/** Destinations, each permissible for exactly one order type. */
const CUSTODIAN = privateKeyToAccount(authorityKey('restrictedCustodian')).address;
const GATEWAY_ACCOUNT = privateKeyToAccount(authorityKey('gatewayDeposit')).address;

const done = [];

async function ensure({ label, chain, isDone, request }) {
  if (await isDone()) {
    log.step(`${label} — already true`);
    done.push({ step: label, action: 'skipped' });
    return;
  }
  const result = await submit(chain, {
    label,
    log,
    request,
    postState: {
      describe: 'read back',
      read: async () => await isDone(),
      matches: (value) => value === true,
    },
  });
  done.push({ step: label, action: 'sent', hash: result.hash });
}

await assertChainIdentity(monad);
await assertChainIdentity(base);

const monadController = process.env['MONAD_DISPOSITION_CONTROLLER'];
const monadRegistry = process.env['MONAD_AUTHORITY_REGISTRY'];
const baseController = process.env['BASE_DISPOSITION_CONTROLLER'];
const baseRegistry = process.env['BASE_AUTHORITY_REGISTRY'];

for (const [name, value] of Object.entries({
  MONAD_DISPOSITION_CONTROLLER: monadController,
  MONAD_AUTHORITY_REGISTRY: monadRegistry,
  BASE_DISPOSITION_CONTROLLER: baseController,
  BASE_AUTHORITY_REGISTRY: baseRegistry,
})) {
  if (value === undefined || value === '') {
    log.fail(`${name} is not set; deploy the kernel first`);
    process.exit(1);
  }
}

// ── The two set-once bindings, per chain ────────────────────────────────────

log.stage('executor bindings');

const zero = '0x0000000000000000000000000000000000000000';

await ensure({
  label: 'escrow.setDispositionController(monad controller)',
  chain: monad,
  isDone: async () =>
    (
      await monad.pub.readContract({
        address: addresses.escrow,
        abi: ESCROW_ABI,
        functionName: 'dispositionController',
      })
    ).toLowerCase() === monadController.toLowerCase(),
  request: {
    address: addresses.escrow,
    abi: ESCROW_ABI,
    functionName: 'setDispositionController',
    args: [monadController],
  },
});

await ensure({
  label: 'monad controller.setExecutor(CASH, escrow)',
  chain: monad,
  isDone: async () => {
    const current = await monad.pub
      .readContract({
        address: monadController,
        abi: CONTROLLER_ABI,
        functionName: 'executorFor',
        args: [LEG.CASH],
      })
      .catch(() => zero);
    return current.toLowerCase() === addresses.escrow.toLowerCase();
  },
  request: {
    address: monadController,
    abi: CONTROLLER_ABI,
    functionName: 'setExecutor',
    args: [LEG.CASH, addresses.escrow],
  },
});

await ensure({
  label: 'adapter.setDispositionController(base controller)',
  chain: base,
  isDone: async () =>
    (
      await base.pub.readContract({
        address: addresses.adapter,
        abi: ESCROW_ABI,
        functionName: 'dispositionController',
      })
    ).toLowerCase() === baseController.toLowerCase(),
  request: {
    address: addresses.adapter,
    abi: ESCROW_ABI,
    functionName: 'setDispositionController',
    args: [baseController],
  },
});

await ensure({
  label: 'base controller.setExecutor(ASSET, adapter)',
  chain: base,
  isDone: async () => {
    const current = await base.pub
      .readContract({
        address: baseController,
        abi: CONTROLLER_ABI,
        functionName: 'executorFor',
        args: [LEG.ASSET],
      })
      .catch(() => zero);
    return current.toLowerCase() === addresses.adapter.toLowerCase();
  },
  request: {
    address: baseController,
    abi: CONTROLLER_ABI,
    functionName: 'setExecutor',
    args: [LEG.ASSET, addresses.adapter],
  },
});

// ── The policy and the authority classes, on both chains ────────────────────

for (const [chain, registry, label] of [
  [monad, monadRegistry, 'Monad'],
  [base, baseRegistry, 'Base'],
]) {
  log.stage(`${label}: authority policy`);

  await ensure({
    label: `${label} registry.setPolicy(conduit-disposition-policy-v1)`,
    chain,
    isDone: async () => {
      const hash = await chain.pub
        .readContract({
          address: registry,
          abi: REGISTRY_ABI,
          functionName: 'policyHash',
          args: [POLICY_ID],
        })
        .catch(() => null);
      // An unset policy hashes over an all-zero struct, which is a real hash and
      // not a sentinel. `policyOf` reverting is the only reliable "absent".
      if (hash === null) return false;
      return await chain.pub
        .readContract({
          address: registry,
          abi: REGISTRY_ABI,
          functionName: 'policyHash',
          args: [POLICY_ID],
        })
        .then(async () => {
          const active = await chain.pub
            .readContract({
              address: registry,
              abi: parseAbi([
                'function policyOf(bytes32 policyId) view returns ((bool,uint32,uint16,uint16,uint8,uint8[6]))',
              ]),
              functionName: 'policyOf',
              args: [POLICY_ID],
            })
            .catch(() => null);
          return active !== null && active[1] === CONTEST_WINDOW;
        });
    },
    request: {
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'setPolicy',
      args: [POLICY_ID, POLICY],
    },
  });

  log.stage(`${label}: authority classes`);

  for (const authority of AUTHORITIES) {
    const isActive = async () => {
      const entry = await chain.pub.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: 'authorityOf',
        args: [authority.address],
      });
      return entry[1] === true && Number(entry[0]) === authority.authorityType;
    };

    if (await isActive()) {
      log.step(`${authority.role} — already active`);
      continue;
    }

    const pendingAt = await chain.pub.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'pendingAuthorityAt',
      args: [authority.address],
    });

    if (pendingAt === 0n) {
      await submit(chain, {
        label: `${label} proposeAuthority(${authority.role})`,
        log,
        request: {
          address: registry,
          abi: REGISTRY_ABI,
          functionName: 'proposeAuthority',
          args: [authority.address, authority.authorityType],
        },
      });
    }

    // The delay is waited through rather than around. A registry that could be
    // hurried is a registry whose timelock is decoration.
    await until(
      `${authority.role} grant matures`,
      async () => {
        const latest = await chain.pub.getBlock();
        const at = await chain.pub.readContract({
          address: registry,
          abi: REGISTRY_ABI,
          functionName: 'pendingAuthorityAt',
          args: [authority.address],
        });
        return latest.timestamp >= at;
      },
      (matured) => matured === true,
      { budgetMs: 600_000, everyMs: 15_000, log },
    );

    await submit(chain, {
      label: `${label} activateAuthority(${authority.role})`,
      log,
      request: {
        address: registry,
        abi: REGISTRY_ABI,
        functionName: 'activateAuthority',
        args: [authority.address],
      },
      postState: {
        describe: 'authority is active with the class it was granted',
        read: isActive,
        matches: (value) => value === true,
      },
    });
  }

  log.stage(`${label}: destinations`);

  // The buyer's identity commitment, so a REBIND_RECEIVER has something to bind
  // to. There is one controlled identity, so no replacement wallet is
  // registered: a rebind cannot be demonstrated live and the registry says so by
  // having nowhere to send it.
  await ensure({
    label: `${label} setIdentityCommitment(deployer)`,
    chain,
    isDone: async () =>
      (await chain.pub.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: 'identityCommitmentOf',
        args: [deployer.address],
      })) === keccak256(toHex(`conduit-identity:${deployer.address.toLowerCase()}`)),
    request: {
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'setIdentityCommitment',
      args: [
        deployer.address,
        keccak256(toHex(`conduit-identity:${deployer.address.toLowerCase()}`)),
      ],
    },
  });

  for (const [kind, account, proposeFn, activateFn, checkFn] of [
    [
      'restricted custodian',
      CUSTODIAN,
      'proposeRestrictedCustodian',
      'activateRestrictedCustodian',
      'isRestrictedCustodian',
    ],
    [
      'gateway account',
      GATEWAY_ACCOUNT,
      'proposeGatewayAccount',
      'activateGatewayAccount',
      'isGatewayAccount',
    ],
  ]) {
    const isDone = async () =>
      await chain.pub.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: checkFn,
        args: [account],
      });

    if (await isDone()) {
      log.step(`${kind} ${account} — already approved`);
      continue;
    }

    await submit(chain, {
      label: `${label} ${proposeFn}(${account})`,
      log,
      request: { address: registry, abi: REGISTRY_ABI, functionName: proposeFn, args: [account] },
    });

    const delay = await chain.pub.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'grantDelay',
    });
    const proposedAt = (await chain.pub.getBlock()).timestamp;
    await until(
      `${kind} approval matures`,
      async () => (await chain.pub.getBlock()).timestamp >= proposedAt + delay,
      (matured) => matured === true,
      { budgetMs: 600_000, everyMs: 15_000, log },
    );

    await submit(chain, {
      label: `${label} ${activateFn}(${account})`,
      log,
      request: { address: registry, abi: REGISTRY_ABI, functionName: activateFn, args: [account] },
      postState: { describe: 'approved', read: isDone, matches: (value) => value === true },
    });
  }
}

// ── Evidence ────────────────────────────────────────────────────────────────

const evidence = {
  capturedAt: new Date().toISOString(),
  deploymentId: config.deploymentId,
  policyId: POLICY_ID,
  contestWindowSeconds: CONTEST_WINDOW,
  requiredSignatures: {
    REVERIFY_AND_RESUME: REQUIRED_SIGNATURES[0],
    REBIND_RECEIVER: REQUIRED_SIGNATURES[1],
    RETURN_TO_ELIGIBLE_SENDER: REQUIRED_SIGNATURES[2],
    AUTHORIZED_SUBSTITUTION: REQUIRED_SIGNATURES[3],
    OPERATOR_ASSISTED_OFFRAMP: REQUIRED_SIGNATURES[4],
    RESTRICTED_HOLD: REQUIRED_SIGNATURES[5],
  },
  monad: {
    controller: monadController,
    registry: monadRegistry,
    executor: addresses.escrow,
    policyHash: await monad.pub.readContract({
      address: monadRegistry,
      abi: REGISTRY_ABI,
      functionName: 'policyHash',
      args: [POLICY_ID],
    }),
    domainSeparator: await monad.pub.readContract({
      address: monadController,
      abi: CONTROLLER_ABI,
      functionName: 'domainSeparator',
    }),
  },
  base: {
    controller: baseController,
    registry: baseRegistry,
    executor: addresses.adapter,
    policyHash: await base.pub.readContract({
      address: baseRegistry,
      abi: REGISTRY_ABI,
      functionName: 'policyHash',
      args: [POLICY_ID],
    }),
    domainSeparator: await base.pub.readContract({
      address: baseController,
      abi: CONTROLLER_ABI,
      functionName: 'domainSeparator',
    }),
  },
  authorities: AUTHORITIES.map(({ role, authorityType, address }) => ({
    role,
    authorityType,
    address,
  })),
  destinations: { restrictedCustodian: CUSTODIAN, gatewayAccount: GATEWAY_ACCOUNT },
  /**
   * Stated rather than implied. One controlled identity means no second wallet
   * can hold a real A-Pass, so REBIND_RECEIVER and AUTHORIZED_SUBSTITUTION have
   * no destination the live policy would accept. Both are implemented and
   * tested; neither is demonstrable live here.
   */
  limitation:
    'ASM-035: generate_apass is 403 for this credential, so only one identity holds an ' +
    'A-Pass. REBIND_RECEIVER and AUTHORIZED_SUBSTITUTION have no live-eligible destination ' +
    'and are IMPLEMENTED + TESTED rather than LIVE DEMONSTRATED.',
  steps: done,
};

const path = join(ROOT, 'docs', 'evidence', 'phase-07-kernel-wiring.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
log.ok(`kernel wired on both chains — ${path}`);

// The domain separators differ by construction: chainId and verifyingContract
// are both inside them. Saying so here means a reader does not have to take it
// on trust from the ADR.
if (evidence.monad.domainSeparator === evidence.base.domainSeparator) {
  log.fail('the two controllers share a domain separator, which must be impossible');
  process.exit(1);
}
log.ok('the two controllers have distinct EIP-712 domains, so an order cannot cross chains');
