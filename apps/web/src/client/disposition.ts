/**
 * The disposition flow, from the browser.
 *
 * A HELD leg is committed value that cannot be delivered. It is not a failure
 * and not a refund: the leg that already released stays released, and the held
 * leg moves only through an order a registered authority signed and the
 * controller accepted after a contest window.
 *
 * ## Authority is read, never assumed
 *
 * Every one of the six order types is shown, because the product implements all
 * six and hiding five would misrepresent what a held case can become. What is
 * *not* faked is who may file one: the connected account's class comes from
 * `AuthorityRegistry.authorityOf`, the policy's per-type signature threshold
 * comes from `policyOf`, and a type whose bitmask does not include that class is
 * disabled with the reason stated. A wallet with no authority sees six
 * explanations and no buttons, which is the truth.
 *
 * ## Filing is not executing
 *
 * `fileOrder` moves nothing. It starts or joins a case, the case rests for its
 * contest window, and only then can `executeOrder` run — and that re-reads the
 * held leg, the host state version and a fresh compliance proof at the moment of
 * transfer. Filing is permissionless to *submit*; the authority is the signer.
 */

import {
  AuthorityType,
  DESTINATION_RULE,
  DISPOSITION_ORDER_TYPE,
  DispositionType,
  Leg,
  caseIdFor,
  type DispositionTypeName,
} from '@conduit-protocol/domain';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';

import {
  BASE_SEPOLIA,
  CONTROLLER_ABI,
  REGISTRY_ABI,
  ZERO_ADDRESS,
  readDispositionCase as decodeCase,
  type AttestationTuple,
  type ComplianceProof,
  type DispositionCaseRecord,
  type DispositionOrderTuple,
} from '../onchain.js';
import type { Terms } from '../actions.js';
import { fromBaseUnits, type Deployment } from './protocol.js';
import { PrerequisiteMissing, runSequence } from './tx.js';
import { publicClient, wallet } from './wallet.js';

export interface DispositionKernel {
  readonly controller: Address;
  readonly registry: Address;
  readonly policyId: Hex;
  readonly contestWindowSeconds: number;
  readonly chainId: number;
}

export interface DispositionContext {
  readonly settlementId: Hex;
  readonly deployment: Deployment;
  readonly kernel?: DispositionKernel;
  readonly terms: Terms;
  readonly intendedReceiver: Address;
  readonly stateVersion: bigint;
}

const TYPE_NAMES: readonly DispositionTypeName[] = [
  'REVERIFY_AND_RESUME',
  'REBIND_RECEIVER',
  'RETURN_TO_ELIGIBLE_SENDER',
  'AUTHORIZED_SUBSTITUTION',
  'OPERATOR_ASSISTED_OFFRAMP',
  'RESTRICTED_HOLD',
];

const PURPOSE: Readonly<Record<DispositionTypeName, string>> = Object.freeze({
  REVERIFY_AND_RESUME:
    'Ask compliance again and retry the delivery the settlement already agreed to. No destination parameter exists, so it cannot send value anywhere new.',
  REBIND_RECEIVER:
    'Deliver to a different account that the registry records as the same legal person.',
  RETURN_TO_ELIGIBLE_SENDER: 'Send the held value back to the party it came from.',
  AUTHORIZED_SUBSTITUTION: 'Deliver to an approved substitute for the refused receiver.',
  OPERATOR_ASSISTED_OFFRAMP:
    'Move the value to a registered gateway account for an off-chain resolution.',
  RESTRICTED_HOLD:
    'Move the value into registered restricted custody. No party to the trade receives it.',
});

const AUTHORITY_NAMES: readonly string[] = [
  'SUBJECT',
  'COUNTERPARTY',
  'ISSUER',
  'TRANSFER_AGENT',
  'COMPLIANCE_OPERATOR',
  'GATEWAY_OPERATOR',
  'MULTISIG',
];

function node(tag: string, className?: string, text?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** The case for a held asset leg, read from the controller rather than the projection. */
export async function readDispositionCase(
  kernel: DispositionKernel,
  _deployment: Deployment,
  settlementId: Hex,
): Promise<DispositionCaseRecord | undefined> {
  try {
    const caseId = caseIdFor(await deploymentIdOf(kernel), settlementId, Leg.ASSET);
    const tuple = await publicClient(kernel.chainId).readContract({
      address: kernel.controller,
      abi: CONTROLLER_ABI,
      functionName: 'caseOf',
      args: [caseId],
    });
    const record = decodeCase(tuple);
    return record.state === 'NONE' ? undefined : record;
  } catch {
    return undefined;
  }
}

/** The controller's own deployment id, which the case id is derived from. */
async function deploymentIdOf(kernel: DispositionKernel): Promise<Hex> {
  return await publicClient(kernel.chainId).readContract({
    address: kernel.controller,
    abi: CONTROLLER_ABI,
    functionName: 'deploymentId',
  });
}

interface Policy {
  readonly active: boolean;
  readonly contestWindow: number;
  readonly allowedAuthorityTypes: number;
  readonly requiredSignatures: readonly number[];
}

async function readPolicy(kernel: DispositionKernel): Promise<Policy | undefined> {
  try {
    const tuple = (await publicClient(kernel.chainId).readContract({
      address: kernel.registry,
      abi: REGISTRY_ABI,
      functionName: 'policyOf',
      args: [kernel.policyId],
    })) as readonly [boolean, number, number, number, number, readonly number[]];
    return {
      active: tuple[0],
      contestWindow: tuple[1],
      allowedAuthorityTypes: tuple[2],
      requiredSignatures: tuple[5],
    };
  } catch {
    return undefined;
  }
}

interface AuthorityState {
  readonly authorityType: number;
  readonly active: boolean;
}

async function readAuthority(
  kernel: DispositionKernel,
  account: Address,
): Promise<AuthorityState | undefined> {
  try {
    const tuple = await publicClient(kernel.chainId).readContract({
      address: kernel.registry,
      abi: REGISTRY_ABI,
      functionName: 'authorityOf',
      args: [account],
    });
    return { authorityType: tuple[0], active: tuple[1] };
  } catch {
    return undefined;
  }
}

/**
 * Renders the HELD panel and, where the connected wallet has authority, the
 * order it may compose.
 */
export function mountDisposition(
  host: HTMLElement,
  context: DispositionContext,
  refresh: () => Promise<void>,
): void {
  void paint(host, context, refresh);
}

async function paint(
  host: HTMLElement,
  context: DispositionContext,
  refresh: () => Promise<void>,
): Promise<void> {
  const kernel = context.kernel;
  host.replaceChildren();

  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginTop = 'var(--spacing-16)';
  card.append(node('div', 't-caption-upper', 'Held'));
  card.append(
    node(
      'p',
      'muted',
      'Committed value is secured but currently cannot be delivered. The commitment remains valid. ' +
        'The released leg is not refunded. The held value can move only through an authorised disposition.',
    ),
  );

  if (kernel === undefined) {
    card.append(
      node(
        'div',
        'action-blocked',
        'No disposition kernel is wired to this deployment generation, so no order can be filed here. ' +
          'That is a property of this deployment, not of the held value: the value stays accounted for ' +
          'and a generation with a kernel can resolve it.',
      ),
    );
    host.append(card);
    return;
  }

  const account = wallet.current.address;
  const [policy, authority, dispositionCase] = await Promise.all([
    readPolicy(kernel),
    account === undefined ? Promise.resolve(undefined) : readAuthority(kernel, account),
    readDispositionCase(kernel, context.deployment, context.settlementId),
  ]);

  card.append(describeLeg(context, dispositionCase));

  if (dispositionCase !== undefined) {
    card.append(caseSummary(dispositionCase, kernel, refresh, context));
  }

  const grid = document.createElement('div');
  grid.className = 'grid-3';
  grid.style.marginTop = 'var(--spacing-16)';

  for (const name of TYPE_NAMES) {
    const value = DispositionType[name];
    const required = policy?.requiredSignatures[value] ?? 0;
    const permitted =
      policy !== undefined &&
      authority !== undefined &&
      authority.active &&
      (policy.allowedAuthorityTypes & (1 << authority.authorityType)) !== 0 &&
      required > 0;

    const reason =
      policy === undefined
        ? 'The authority policy could not be read from the registry.'
        : required === 0
          ? 'This policy does not permit this order type at all.'
          : account === undefined
            ? 'Connect a wallet to see whether it may sign this order.'
            : !authority?.active
              ? 'This wallet is not a registered authority on this deployment, so it cannot sign an order.'
              : (policy.allowedAuthorityTypes & (1 << authority.authorityType)) === 0
                ? `This wallet is registered as ${AUTHORITY_NAMES[authority.authorityType] ?? 'an unknown class'}, which this policy does not permit to sign.`
                : undefined;

    const tile = document.createElement('div');
    tile.className = 'dtype';
    tile.dataset['enabled'] = String(permitted);
    tile.dataset['dtype'] = name;
    tile.append(node('div', 'dtype-name', name));
    tile.append(node('p', 'muted t-caption', PURPOSE[name]));
    tile.append(
      node(
        'div',
        't-caption muted',
        `Destination — ${DESTINATION_RULE[name]}. Signatures required: ${String(required)}.`,
      ),
    );

    if (permitted && dispositionCase === undefined) {
      const file = document.createElement('button');
      file.className = 'btn btn-outline btn-sm';
      file.type = 'button';
      file.textContent = 'Compose and file';
      file.addEventListener('click', () => {
        file.disabled = true;
        void fileOrder(host, context, kernel, name, authority, refresh).catch((error: unknown) => {
          tile.append(node('div', 't-caption tx-error', message(error)));
          file.disabled = false;
        });
      });
      tile.append(file);
    } else if (reason !== undefined) {
      tile.append(node('div', 't-caption muted', reason));
    }

    grid.append(tile);
  }

  card.append(grid);
  card.append(
    node(
      'div',
      'note',
      'Filing never moves value. A filed order rests for the policy’s contest window, and a second ' +
        'valid order naming a different outcome makes the case CONTESTED — at which point nothing ' +
        'executes until a resolver with the class the policy requires picks one.',
    ),
  );
  const tx = document.createElement('div');
  tx.dataset['dispositionTx'] = '';
  card.append(tx);
  host.append(card);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeLeg(
  context: DispositionContext,
  dispositionCase: DispositionCaseRecord | undefined,
): HTMLElement {
  const table = document.createElement('table');
  table.className = 'kv';
  const rows: readonly [string, string][] = [
    ['Held leg', 'asset'],
    ['Amount', `${fromBaseUnits(context.terms.assetAmount)} cBOND`],
    ['Chain', 'Base Sepolia'],
    ['Original receiver', context.intendedReceiver],
    ['Other leg', 'cash — RELEASED and not refundable'],
    ['Case state', dispositionCase?.state ?? 'no case filed'],
  ];
  for (const [key, value] of rows) {
    const row = document.createElement('tr');
    row.append(node('td', undefined, key));
    row.append(node('td', 'mono', value));
    table.append(row);
  }
  return table;
}

function caseSummary(
  dispositionCase: DispositionCaseRecord,
  kernel: DispositionKernel,
  refresh: () => Promise<void>,
  context: DispositionContext,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.marginTop = 'var(--spacing-16)';

  const openUntil = Number(dispositionCase.filedAt) + kernel.contestWindowSeconds;
  const now = Math.floor(Date.now() / 1000);
  const resting = dispositionCase.state === 'OPEN' && now < openUntil;

  wrapper.append(
    node(
      'div',
      `badge ${dispositionCase.state === 'EXECUTED' ? 'badge-solid' : 'badge-soft'}`,
      dispositionCase.state === 'OPEN' && resting
        ? 'FILED — CONTEST WINDOW'
        : dispositionCase.state,
    ),
  );
  wrapper.append(
    node(
      'div',
      't-caption muted',
      resting
        ? `The window closes at ${new Date(openUntil * 1000).toISOString()}.`
        : dispositionCase.state === 'CONTESTED'
          ? 'Two authorised orders disagree. Nothing executes until a resolver picks one.'
          : dispositionCase.state === 'EXECUTED'
            ? `Executed to ${dispositionCase.executedDestination}.`
            : 'The window has closed with one filed outcome.',
    ),
  );

  if (!resting && (dispositionCase.state === 'OPEN' || dispositionCase.state === 'ADJUDICATED')) {
    const execute = document.createElement('button');
    execute.className = 'btn btn-primary btn-sm';
    execute.type = 'button';
    execute.dataset['dispositionExecute'] = '';
    execute.textContent = 'Execute disposition';
    execute.style.marginTop = 'var(--spacing-12)';
    execute.addEventListener('click', () => {
      execute.disabled = true;
      void executeOrder(wrapper, context, kernel, dispositionCase)
        .then(refresh)
        .catch((error: unknown) => {
          wrapper.append(node('div', 't-caption tx-error', message(error)));
          execute.disabled = false;
        });
    });
    wrapper.append(execute);
  }

  return wrapper;
}

/**
 * Composes the typed order, has the authority's wallet sign it, recovers the
 * signer locally, and files it.
 *
 * The recovery is not ceremony. A wallet that returns a signature for a
 * different digest than the one it displayed is exactly what a mismatched domain
 * produces, and the controller's refusal would be `InvalidAuthoritySignature`
 * with nothing to say which of five fields was wrong.
 */
async function fileOrder(
  host: HTMLElement,
  context: DispositionContext,
  kernel: DispositionKernel,
  name: DispositionTypeName,
  authority: AuthorityState | undefined,
  refresh: () => Promise<void>,
): Promise<void> {
  const account = wallet.current.address;
  if (account === undefined || authority === undefined) {
    throw new PrerequisiteMissing('no authority wallet is connected');
  }

  const deploymentId = await deploymentIdOf(kernel);
  const caseId = caseIdFor(deploymentId, context.settlementId, Leg.ASSET);
  const policyHash = await publicClient(kernel.chainId).readContract({
    address: kernel.registry,
    abi: REGISTRY_ABI,
    functionName: 'policyHash',
    args: [kernel.policyId],
  });

  const now = BigInt(Math.floor(Date.now() / 1000));
  const zero32: Hex = `0x${'0'.repeat(64)}`;

  // Only REVERIFY_AND_RESUME has a destination this browser can derive without
  // asking an operator: the current intended receiver, which is the one value it
  // is allowed to name. Every other type redirects value, and the destination is
  // an operator decision rather than a default.
  const destination =
    name === 'REVERIFY_AND_RESUME'
      ? context.intendedReceiver
      : (window.prompt(`Destination for ${name} (${DESTINATION_RULE[name]})`) ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) {
    throw new PrerequisiteMissing('a destination address is required for this order type');
  }

  const order = {
    caseId,
    settlementId: context.settlementId,
    deploymentId,
    leg: Leg.ASSET,
    dispositionType: DispositionType[name],
    sourceEscrow: context.deployment.rwaAdapter,
    asset: context.deployment.rwaToken,
    amount: context.terms.assetAmount,
    currentReceiver: context.intendedReceiver,
    destination: destination as Address,
    destinationIdentityCommitment: zero32,
    authority: account,
    authorityType: authority.authorityType as (typeof AuthorityType)[keyof typeof AuthorityType],
    authorityPolicyId: kernel.policyId,
    authorityPolicyHash: policyHash,
    evidenceCommitment: zero32,
    complianceAttestationIds: zero32,
    notBefore: now - 60n,
    expiry: now + 3_600n,
    nonce: now,
    hostStateVersion: context.stateVersion,
  };

  const domain = {
    name: 'Conduit',
    version: '1',
    chainId: kernel.chainId,
    verifyingContract: kernel.controller,
  };

  await wallet.ensureChain(kernel.chainId);
  const signature = await wallet.walletClient(kernel.chainId).signTypedData({
    account,
    domain,
    types: DISPOSITION_ORDER_TYPE,
    primaryType: 'DispositionOrder',
    message: order,
  });

  const recovered = await recoverTypedDataAddress({
    domain,
    types: DISPOSITION_ORDER_TYPE,
    primaryType: 'DispositionOrder',
    message: order,
    signature,
  });
  if (recovered.toLowerCase() !== account.toLowerCase()) {
    throw new Error(
      `the wallet returned a signature for ${recovered}, not ${account}. It has not been used.`,
    );
  }

  const tuple: DispositionOrderTuple = [
    order.caseId,
    order.settlementId,
    order.deploymentId,
    order.leg,
    order.dispositionType,
    order.sourceEscrow,
    order.asset,
    order.amount,
    order.currentReceiver,
    order.destination,
    order.destinationIdentityCommitment,
    order.authority,
    order.authorityType,
    order.authorityPolicyId,
    order.authorityPolicyHash,
    order.evidenceCommitment,
    order.complianceAttestationIds,
    order.notBefore,
    order.expiry,
    order.nonce,
    order.hostStateVersion,
  ];

  const txHost = host.querySelector<HTMLElement>('[data-disposition-tx]') ?? host;
  await runSequence(txHost, [
    {
      kind: 'file-disposition',
      label: `File ${name}`,
      chainId: kernel.chainId,
      target: kernel.controller,
      expected: 'the case opens and begins its contest window',
      send: async () =>
        wallet.walletClient(kernel.chainId).writeContract({
          chain: null,
          account,
          address: kernel.controller,
          abi: CONTROLLER_ABI,
          functionName: 'fileOrder',
          args: [tuple, signature],
        }),
      observe: async () => {
        const filed = await readDispositionCase(kernel, context.deployment, context.settlementId);
        return { ok: filed !== undefined, observed: filed?.state ?? 'no case' };
      },
    },
  ]);
  await refresh();
}

/**
 * Executes a rested case.
 *
 * The type, destination, amount and asset all come from the case, which came
 * from a signed order. The only thing supplied here is a compliance proof minted
 * at this moment, because delivery is where eligibility is checked again.
 */
async function executeOrder(
  host: HTMLElement,
  context: DispositionContext,
  kernel: DispositionKernel,
  dispositionCase: DispositionCaseRecord,
): Promise<void> {
  const account = wallet.current.address;
  if (account === undefined) throw new PrerequisiteMissing('no wallet is connected');

  const destination =
    dispositionCase.executedDestination === ZERO_ADDRESS
      ? context.intendedReceiver
      : dispositionCase.executedDestination;

  const response = await fetch('/api/attestations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      settlementId: context.settlementId,
      intentHash: context.settlementId,
      purpose: 'disposition',
      subjects: [destination],
    }),
  });
  const body = (await response.json()) as {
    ok?: boolean;
    unavailable?: boolean;
    attestations?: {
      settlementId: Hex;
      intentHash: Hex;
      subject: Address;
      eligible: boolean;
      issuedAt: string;
      expiresAt: string;
      evidenceHash: Hex;
      signature: Hex;
    }[];
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? 'the compliance authority could not be reached');
  }
  if (body.unavailable === true) {
    throw new PrerequisiteMissing(
      'Cleanverse did not answer, so no proof exists. That is not a refusal.',
    );
  }

  const attestations = body.attestations ?? [];
  const proof: ComplianceProof = [
    attestations.map((attestation): AttestationTuple => [
      attestation.settlementId,
      attestation.intentHash,
      attestation.subject,
      attestation.eligible,
      BigInt(attestation.issuedAt),
      BigInt(attestation.expiresAt),
      attestation.evidenceHash,
    ]),
    attestations.map((attestation) => attestation.signature),
  ];

  const caseId = caseIdFor(await deploymentIdOf(kernel), context.settlementId, Leg.ASSET);
  const txHost = host.querySelector<HTMLElement>('[data-disposition-tx]') ?? host;
  await runSequence(txHost, [
    {
      kind: 'execute-disposition',
      label: 'Execute the disposition',
      chainId: kernel.chainId,
      target: kernel.controller,
      expected: 'the case becomes EXECUTED and the value moves',
      send: async () =>
        wallet.walletClient(kernel.chainId).writeContract({
          chain: null,
          account,
          address: kernel.controller,
          abi: CONTROLLER_ABI,
          functionName: 'executeOrder',
          args: [caseId, proof],
        }),
      observe: async () => {
        const after = await readDispositionCase(kernel, context.deployment, context.settlementId);
        return { ok: after?.state === 'EXECUTED', observed: after?.state ?? 'unreadable' };
      },
    },
  ]);
}

export { BASE_SEPOLIA };
