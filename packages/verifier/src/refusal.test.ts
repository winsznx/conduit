import { encodeErrorResult, parseAbi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  NotARefusalError,
  RefusalOutcome,
  proveContractRefusal,
  type RefusalClient,
} from './refusal.js';

/**
 * The two false passes this module exists to prevent, reproduced.
 *
 * Both were reported as protocol refusals and neither was one. The tests below
 * drive the same conditions and assert that the outcome is named for what
 * actually happened, because a helper that returns "refused" for all of them is
 * exactly the helper that produced the reports.
 */

const ABI = parseAbi([
  'function recordCashPrepared(bytes32 settlementId, bytes32 intentHash)',
  'error NotTheCashEscrow(address caller, address expected)',
]);

const TARGET = '0x0AEBe99A17796325Da45E49Ef3Ba8BD13bbE5c86' as Address;
const CALLER = '0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE' as Address;
const SETTLEMENT: Hex = `0x${'11'.repeat(32)}`;

/** A viem-shaped error: the payload sits at `data`, one or more causes down. */
function revertingWith(data: Hex): Error {
  const inner = new Error('execution reverted') as Error & { data: Hex };
  inner.data = data;
  const outer = new Error('call execution failed');
  (outer as Error & { cause: unknown }).cause = inner;
  return outer;
}

function client(overrides: Partial<RefusalClient> = {}): RefusalClient {
  return {
    getChainId: () => Promise.resolve(10_143),
    getCode: () => Promise.resolve('0x60806040'),
    call: () =>
      Promise.reject(
        revertingWith(
          encodeErrorResult({ abi: ABI, errorName: 'NotTheCashEscrow', args: [CALLER, TARGET] }),
        ),
      ),
    ...overrides,
  };
}

const request = {
  label: 'the superseded coordinator refuses a cash preparation',
  address: TARGET,
  abi: ABI,
  functionName: 'recordCashPrepared',
  args: [SETTLEMENT, SETTLEMENT],
  account: CALLER,
} as const;

describe('proveContractRefusal', () => {
  it('records a real revert with the whole path that produced it', async () => {
    // #given a contract that reverts with its own custom error
    // #when the refusal is proven
    const evidence = await proveContractRefusal(client(), {
      ...request,
      expectedError: 'NotTheCashEscrow',
      preState: { 'settlement.cashPrepared': false },
    });

    // #then every link is recorded, not just the conclusion
    expect(evidence.outcome).toBe(RefusalOutcome.CONTRACT_REVERT);
    expect(evidence.isProtocolRefusal).toBe(true);
    expect(evidence.chainId).toBe(10_143);
    expect(evidence.target).toBe(TARGET);
    expect(evidence.caller).toBe(CALLER);
    expect(evidence.calldata).toMatch(/^0x[0-9a-f]+$/);
    expect(evidence.rawRevert).toMatch(/^0x[0-9a-f]+$/);
    expect(evidence.decodedError).toBe('NotTheCashEscrow');
    expect(evidence.decodedArgs).toEqual([CALLER, TARGET]);
    expect(evidence.preState).toEqual({ 'settlement.cashPrepared': false });
  });

  /**
   * The original false pass. `Function "recordCashPrepared" not found on ABI`
   * was reported as the chain rejecting an unauthorized caller, and the
   * assertion would have passed against a contract with no access control at
   * all.
   */
  it('refuses to call a client-side encoding failure a refusal', async () => {
    // #given an ABI that does not describe the function being called
    const wrongAbi = parseAbi(['function somethingElse()']);

    // #when a refusal is claimed
    const attempt = proveContractRefusal(client(), { ...request, abi: wrongAbi });

    // #then it is named for what happened, and it is not a protocol fact
    await expect(attempt).rejects.toThrow(NotARefusalError);
    const evidence = await attempt.catch((error: unknown) => (error as NotARefusalError).evidence);
    expect(evidence.outcome).toBe(RefusalOutcome.CLIENT_ENCODING_FAILURE);
    expect(evidence.isProtocolRefusal).toBe(false);
    expect(evidence.calldata).toBeUndefined();
  });

  it('refuses to call an empty address a refusal', async () => {
    // #given nothing deployed at the target
    const attempt = proveContractRefusal(client({ getCode: () => Promise.resolve('0x') }), request);

    await expect(attempt).rejects.toThrow(NotARefusalError);
    const evidence = await attempt.catch((error: unknown) => (error as NotARefusalError).evidence);
    expect(evidence.outcome).toBe(RefusalOutcome.TARGET_NOT_A_CONTRACT);
    expect(evidence.isProtocolRefusal).toBe(false);
    // The calldata encoded, which is why this is a different finding from the
    // one above rather than the same one.
    expect(evidence.calldata).toMatch(/^0x[0-9a-f]+$/);
  });

  it('refuses to call a node failure a refusal', async () => {
    // #given a transport error carrying no revert data
    const attempt = proveContractRefusal(
      client({
        call: () => Promise.reject(new Error('HTTP request failed: 503 Service Unavailable')),
      }),
      request,
    );

    await expect(attempt).rejects.toThrow(NotARefusalError);
    const evidence = await attempt.catch((error: unknown) => (error as NotARefusalError).evidence);
    expect(evidence.outcome).toBe(RefusalOutcome.RPC_FAILURE);
    expect(evidence.isProtocolRefusal).toBe(false);
    expect(evidence.rawRevert).toBeUndefined();
  });

  it('reports a call that succeeded as a failed proof rather than a refusal', async () => {
    const attempt = proveContractRefusal(
      client({ call: () => Promise.resolve({ data: '0x' }) }),
      request,
    );

    await expect(attempt).rejects.toThrow(NotARefusalError);
    const evidence = await attempt.catch((error: unknown) => (error as NotARefusalError).evidence);
    expect(evidence.outcome).toBe(RefusalOutcome.UNEXPECTED_SUCCESS);
    expect(evidence.isProtocolRefusal).toBe(false);
  });

  /**
   * A revert is not enough on its own. Claiming a settlement was refused for
   * being on the wrong deployment, when it was actually refused for an expired
   * deadline, is a true observation attached to a false conclusion.
   */
  it('refuses a revert that names a different error than the one claimed', async () => {
    const attempt = proveContractRefusal(client(), {
      ...request,
      expectedError: 'SomeOtherError',
    });

    await expect(attempt).rejects.toThrow(NotARefusalError);
    const evidence = await attempt.catch((error: unknown) => (error as NotARefusalError).evidence);
    expect(evidence.isProtocolRefusal).toBe(false);
    expect(evidence.decodedError).toBe('NotTheCashEscrow');
    expect(evidence.detail).toContain('expected SomeOtherError');
  });

  it('records an undecodable revert as a revert without inventing a reason', async () => {
    // #given a selector the target's ABI does not describe
    const evidence = await proveContractRefusal(
      client({ call: () => Promise.reject(revertingWith('0xdeadbeef')) }),
      request,
    );

    // #then the bytes are preserved and no error name is guessed
    expect(evidence.outcome).toBe(RefusalOutcome.CONTRACT_REVERT);
    expect(evidence.rawRevert).toBe('0xdeadbeef');
    expect(evidence.decodedError).toBeUndefined();
    expect(evidence.detail).toContain('undecodable');
  });
});
