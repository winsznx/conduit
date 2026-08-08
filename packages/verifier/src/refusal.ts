import {
  decodeErrorResult,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

/**
 * The evidence rule for negative claims.
 *
 * A negative proof is valid only if the intended operation actually reached the
 * layer whose rejection is being claimed. That sentence exists because this
 * repository has produced two false passes with the same shape, five days
 * apart, and neither looked wrong at the time.
 *
 * The first: a script proved that a superseded contract could no longer call a
 * privileged function. It could not — but the reason the assertion passed was
 * `Function "recordCashPrepared" not found on ABI`. viem refused to build the
 * calldata, the `catch` treated any error as a refusal, and the report said the
 * chain had rejected an authority that was never exercised. The check would
 * have passed against a contract with no access control at all.
 *
 * The second: a verifier finding asserted `reservedBalanceOf(seller) == 0` to
 * prove a settled leg held nothing. That is an aggregate over every open
 * reservation the wallet has, and a different settlement was legitimately held,
 * so a perfect settlement was reported as incomplete.
 *
 * Both are the same error. A claim was keyed to something adjacent to the thing
 * it was about, and the adjacent thing answered.
 *
 * ```text
 *   CLIENT_ENCODING_FAILURE  !=  CONTRACT_REVERT
 *   RPC_FAILURE              !=  POLICY_REFUSAL
 *   AGGREGATE_STATE          !=  SETTLEMENT_STATE
 * ```
 *
 * So a refusal is not something this module infers from a thrown error. It is
 * something it constructs, step by step, and it will not return a refusal it
 * cannot show the whole path for: calldata that encoded, a target that is a
 * contract, a call that reached it, raw revert bytes that came back, and a
 * decoded error from the target's own ABI.
 */

/** Why a call did not succeed, or that it did. Only one of these is a refusal. */
export const RefusalOutcome = {
  /** The client could not even build the transaction. Never a protocol fact. */
  CLIENT_ENCODING_FAILURE: 'CLIENT_ENCODING_FAILURE',
  /** There is no code at the address, so nothing refused anything. */
  TARGET_NOT_A_CONTRACT: 'TARGET_NOT_A_CONTRACT',
  /** The node did not answer. Says nothing about the contract. */
  RPC_FAILURE: 'RPC_FAILURE',
  /** The call reached the contract and the contract reverted. */
  CONTRACT_REVERT: 'CONTRACT_REVERT',
  /** The call reached the contract and it did not revert. */
  UNEXPECTED_SUCCESS: 'UNEXPECTED_SUCCESS',
} as const;

export type RefusalOutcome = (typeof RefusalOutcome)[keyof typeof RefusalOutcome];

export interface RefusalEvidence {
  readonly label: string;
  readonly outcome: RefusalOutcome;
  /** True only for `CONTRACT_REVERT`. Nothing else may be reported as one. */
  readonly isProtocolRefusal: boolean;
  readonly chainId: number;
  readonly target: Address;
  readonly caller: Address | undefined;
  /** Proof the operation was expressible at all. */
  readonly calldata: Hex | undefined;
  /** Exactly what came back, before anyone interpreted it. */
  readonly rawRevert: Hex | undefined;
  readonly decodedError: string | undefined;
  readonly decodedArgs: readonly unknown[] | undefined;
  /**
   * State read before the call, keyed the way the claim is keyed. A refusal
   * about a settlement records that settlement's state, never a wallet
   * aggregate that happens to contain it.
   */
  readonly preState: Readonly<Record<string, unknown>> | undefined;
  readonly detail: string;
}

export class NotARefusalError extends Error {
  public override readonly name = 'NotARefusalError';
  public readonly evidence: RefusalEvidence;

  public constructor(evidence: RefusalEvidence) {
    super(`${evidence.label}: ${evidence.outcome} — ${evidence.detail}`);
    this.evidence = evidence;
  }
}

export interface RefusalRequest {
  readonly label: string;
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args?: readonly unknown[];
  /** The address whose authority is under test. Omitting it tests nobody's. */
  readonly account?: Address;
  /** The custom error the refusal must name, if the claim is that specific. */
  readonly expectedError?: string;
  /** Read and recorded before the call, keyed to the subject of the claim. */
  readonly preState?: Readonly<Record<string, unknown>>;
}

/** The subset of a viem public client this needs, so tests need no network. */
export interface RefusalClient {
  getChainId: PublicClient['getChainId'];
  getCode: PublicClient['getCode'];
  call: PublicClient['call'];
}

/**
 * Walks a call to the point of refusal and records every step of the way.
 *
 * Returns evidence only when the call genuinely reached the contract and the
 * contract reverted. Every other outcome throws `NotARefusalError` carrying the
 * same evidence structure, so a caller cannot accidentally treat "the client
 * could not encode this" as "the contract said no" — which is the whole point.
 */
export async function proveContractRefusal(
  client: RefusalClient,
  request: RefusalRequest,
): Promise<RefusalEvidence> {
  const chainId = await client.getChainId();

  const base = {
    label: request.label,
    chainId,
    target: request.address,
    caller: request.account,
    preState: request.preState,
  } as const;

  // 1. The operation has to be expressible. A wrong function name, a missing
  //    ABI entry or a bad argument type fails here, and none of them is a
  //    statement about the contract.
  let calldata: Hex;
  try {
    calldata = encodeFunctionData({
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
    });
  } catch (error) {
    throw new NotARefusalError({
      ...base,
      outcome: RefusalOutcome.CLIENT_ENCODING_FAILURE,
      isProtocolRefusal: false,
      calldata: undefined,
      rawRevert: undefined,
      decodedError: undefined,
      decodedArgs: undefined,
      detail: `the call was never built: ${messageOf(error)}`,
    });
  }

  // 2. There has to be something there to refuse. An empty address reverts on
  //    every call, which reads exactly like access control working.
  const code = await client.getCode({ address: request.address });
  if (code === undefined || code === '0x') {
    throw new NotARefusalError({
      ...base,
      outcome: RefusalOutcome.TARGET_NOT_A_CONTRACT,
      isProtocolRefusal: false,
      calldata,
      rawRevert: undefined,
      decodedError: undefined,
      decodedArgs: undefined,
      detail: 'no code at the target address',
    });
  }

  // 3. The call has to reach it.
  let raw: Hex | undefined;
  try {
    await client.call({
      to: request.address,
      data: calldata,
      ...(request.account === undefined ? {} : { account: request.account }),
    });
    throw new NotARefusalError({
      ...base,
      outcome: RefusalOutcome.UNEXPECTED_SUCCESS,
      isProtocolRefusal: false,
      calldata,
      rawRevert: undefined,
      decodedError: undefined,
      decodedArgs: undefined,
      detail: 'the call succeeded, so nothing was refused',
    });
  } catch (error) {
    if (error instanceof NotARefusalError) throw error;

    raw = revertDataOf(error);
    if (raw === undefined) {
      // No revert data means the node did not execute the call, or executed it
      // and lost the reason. Either way the contract has not spoken.
      throw new NotARefusalError({
        ...base,
        outcome: RefusalOutcome.RPC_FAILURE,
        isProtocolRefusal: false,
        calldata,
        rawRevert: undefined,
        decodedError: undefined,
        decodedArgs: undefined,
        detail: `no revert data returned: ${messageOf(error)}`,
      });
    }
  }

  // 4. And the bytes have to decode against the target's own ABI. A selector
  //    the target cannot produce is not the target refusing.
  let decodedError: string | undefined;
  let decodedArgs: readonly unknown[] | undefined;
  try {
    const decoded = decodeErrorResult({ abi: request.abi, data: raw });
    decodedError = decoded.errorName;
    decodedArgs = decoded.args;
  } catch {
    decodedError = undefined;
  }

  const evidence: RefusalEvidence = {
    ...base,
    outcome: RefusalOutcome.CONTRACT_REVERT,
    isProtocolRefusal: true,
    calldata,
    rawRevert: raw,
    decodedError,
    decodedArgs,
    detail:
      decodedError === undefined
        ? `reverted with undecodable data ${raw}`
        : `reverted with ${decodedError}`,
  };

  if (request.expectedError !== undefined && decodedError !== request.expectedError) {
    throw new NotARefusalError({
      ...evidence,
      isProtocolRefusal: false,
      detail: `expected ${request.expectedError}, got ${decodedError ?? `raw ${raw}`}`,
    });
  }

  return evidence;
}

/**
 * viem nests the revert payload differently depending on where the call failed,
 * and the field is `data` at whichever depth it reached. Walking the cause
 * chain is more robust than matching one error class, and a missing `data` is
 * the signal that no execution happened at all.
 */
function revertDataOf(error: unknown): Hex | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth += 1) {
    const candidate = (current as { data?: unknown }).data;
    if (typeof candidate === 'string' && candidate.startsWith('0x') && candidate.length >= 10) {
      return candidate as Hex;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}
