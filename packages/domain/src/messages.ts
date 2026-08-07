import { concatHex, type Hex, pad, size, slice, toHex } from 'viem';

import { MessageType, type MessageTypeValue } from './states.js';

/**
 * Cross-chain message header. PRD 7.3.
 *
 * Every payload starts with this header, and every field in it exists to defeat
 * a specific threat rather than to be descriptive:
 *
 *   protocolVersion      a payload from an incompatible version (T-13)
 *   messageType          a COMMIT replayed as a RELEASE
 *   deploymentId         a valid message from a different deployment (T-13)
 *   settlementId         a valid message about a different settlement
 *   intentHash           legs bound to different terms (I7)
 *   sourceChainId        a message replayed onto the chain that sent it (T-12)
 *   destinationChainId   a message accepted by the wrong destination
 *   stateVersion         an out-of-order or stale delivery (T-14)
 *
 * The encoding is fixed-width and positional. There is no length prefix, no
 * optional field, and no variable-size type, so a truncated or extended payload
 * fails to decode rather than decoding into something plausible.
 */

export const PROTOCOL_VERSION = 1;

/** 4 + 1 + 32 + 32 + 32 + 32 + 32 + 8 bytes. */
export const MESSAGE_HEADER_BYTES = 173;

export interface MessageHeader {
  readonly protocolVersion: number;
  readonly messageType: MessageTypeValue;
  readonly deploymentId: Hex;
  readonly settlementId: Hex;
  readonly intentHash: Hex;
  readonly sourceChainId: bigint;
  readonly destinationChainId: bigint;
  readonly stateVersion: bigint;
}

export class MessageDecodeError extends Error {
  public override readonly name = 'MessageDecodeError';
}

function uint(value: bigint | number, bytes: number): Hex {
  const asBigInt = typeof value === 'bigint' ? value : BigInt(value);
  if (asBigInt < 0n) throw new MessageDecodeError('unsigned field cannot be negative');
  const max = (1n << BigInt(bytes * 8)) - 1n;
  if (asBigInt > max) {
    throw new MessageDecodeError(`value does not fit in ${String(bytes)} bytes`);
  }
  return pad(toHex(asBigInt), { size: bytes });
}

function bytes32(value: Hex, field: string): Hex {
  if (size(value) !== 32) {
    throw new MessageDecodeError(`${field} must be exactly 32 bytes`);
  }
  return value;
}

export function encodeHeader(header: MessageHeader): Hex {
  return concatHex([
    uint(header.protocolVersion, 4),
    uint(header.messageType, 1),
    bytes32(header.deploymentId, 'deploymentId'),
    bytes32(header.settlementId, 'settlementId'),
    bytes32(header.intentHash, 'intentHash'),
    uint(header.sourceChainId, 32),
    uint(header.destinationChainId, 32),
    uint(header.stateVersion, 8),
  ]);
}

const MESSAGE_TYPE_VALUES = new Set<number>(Object.values(MessageType));

export function decodeHeader(payload: Hex): MessageHeader {
  if (size(payload) < MESSAGE_HEADER_BYTES) {
    throw new MessageDecodeError(
      `payload is ${String(size(payload))} bytes, header needs ${String(MESSAGE_HEADER_BYTES)}`,
    );
  }

  const messageType = Number(BigInt(slice(payload, 4, 5)));
  if (!MESSAGE_TYPE_VALUES.has(messageType)) {
    // An unknown type is never treated as a no-op. A message the contract cannot
    // classify must not be consumed, or its VAA is burned without effect.
    throw new MessageDecodeError(`unknown message type ${String(messageType)}`);
  }

  return {
    protocolVersion: Number(BigInt(slice(payload, 0, 4))),
    messageType: messageType as MessageTypeValue,
    deploymentId: slice(payload, 5, 37),
    settlementId: slice(payload, 37, 69),
    intentHash: slice(payload, 69, 101),
    sourceChainId: BigInt(slice(payload, 101, 133)),
    destinationChainId: BigInt(slice(payload, 133, 165)),
    stateVersion: BigInt(slice(payload, 165, 173)),
  };
}

export interface HeaderExpectation {
  readonly deploymentId: Hex;
  readonly settlementId: Hex;
  readonly intentHash: Hex;
  readonly destinationChainId: bigint;
  readonly messageType: MessageTypeValue;
  /** Highest stateVersion already consumed for this settlement, if any. */
  readonly lastStateVersion?: bigint;
}

/**
 * PRD 8.4 and FR-009, expressed off-chain so the reference model and the
 * relayer reject the same messages the contracts do.
 *
 * This is a cross-check, never the authority. CLAUDE.md: "Never trust off-chain
 * VAA parsing alone." The contract re-verifies every one of these on-chain, and
 * a disagreement between the two is itself a finding.
 */
export function checkHeader(header: MessageHeader, expected: HeaderExpectation): string[] {
  const problems: string[] = [];

  if (header.protocolVersion !== PROTOCOL_VERSION) {
    problems.push(`protocol version ${String(header.protocolVersion)} is not supported`);
  }
  if (header.messageType !== expected.messageType) {
    problems.push('message type does not match the expected type');
  }
  if (header.deploymentId.toLowerCase() !== expected.deploymentId.toLowerCase()) {
    problems.push('message is for a different deployment');
  }
  if (header.settlementId.toLowerCase() !== expected.settlementId.toLowerCase()) {
    problems.push('message is for a different settlement');
  }
  if (header.intentHash.toLowerCase() !== expected.intentHash.toLowerCase()) {
    problems.push('message binds a different intent hash');
  }
  if (header.destinationChainId !== expected.destinationChainId) {
    problems.push('message is addressed to a different destination chain');
  }
  if (header.sourceChainId === header.destinationChainId) {
    problems.push('source and destination chain are the same');
  }
  if (expected.lastStateVersion !== undefined && header.stateVersion <= expected.lastStateVersion) {
    problems.push('state version is not newer than the last consumed message');
  }

  return problems;
}
