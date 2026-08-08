import type { Hex } from 'viem';

/**
 * The CLI's command surface, separated from its wiring so it can be tested.
 *
 * PRD 6.x names six commands. What matters more than the list is the boundary:
 * `doctor`, `settlement`, `verify` and `evidence` reach chains and Cleanverse
 * and print what they found; `intent` and `disposition` build and hash
 * structures for a wallet to sign. Nothing here holds a key, and nothing here
 * decides an outcome.
 *
 * `verify` is the one that has to be usable by somebody who does not trust us.
 * It takes a settlement ID and RPC URLs and reads two chains and the guardian
 * set. It does not call Conduit's API, and it must keep not calling it — an
 * independent verifier that phones home is not one.
 */

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  /** Whether the command reaches the network at all. */
  readonly reads: 'nothing' | 'chains' | 'chains-and-cleanverse';
  /** Every command is read-only on chain. A CLI that could send is a CLI that could decide. */
  readonly sendsTransactions: false;
}

export const COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    name: 'doctor',
    summary:
      'Check the environment, both chains, and every Cleanverse capability this build needs.',
    usage: 'conduit doctor',
    reads: 'chains-and-cleanverse',
    sendsTransactions: false,
  },
  {
    name: 'settlement',
    summary:
      'Read a settlement from the chains: canonical state, both legs, messages, disposition.',
    usage: 'conduit settlement <settlementId>',
    reads: 'chains',
    sendsTransactions: false,
  },
  {
    name: 'verify',
    summary:
      'Independently reconstruct a settlement from two RPC URLs and the guardian set, and classify it.',
    usage: 'conduit verify <settlementId> [--from-block <n>] [--json]',
    reads: 'chains',
    sendsTransactions: false,
  },
  {
    name: 'evidence',
    summary: 'Assemble the evidence manifest for a settlement and check every artifact hash.',
    usage: 'conduit evidence <settlementId> [--out <path>]',
    reads: 'chains',
    sendsTransactions: false,
  },
  {
    name: 'intent',
    summary: 'Build a settlement intent and print the EIP-712 digest for a wallet to sign.',
    usage: 'conduit intent --cash <amount> --asset <amount> [--nonce <n>]',
    reads: 'chains',
    sendsTransactions: false,
  },
  {
    name: 'disposition',
    summary: 'Build a disposition order for an authorized role and print its digest.',
    usage: 'conduit disposition <settlementId> --type <TYPE> --leg <CASH|ASSET> --to <address>',
    reads: 'chains',
    sendsTransactions: false,
  },
]);

export function usage(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const lines = COMMANDS.map(
    (command) => `  ${command.name.padEnd(width)}  ${command.summary}`,
  ).join('\n');

  return [
    'conduit — cross-chain delivery-versus-payment for Cleanverse-native assets',
    '',
    'Commands:',
    lines,
    '',
    'Every command is read-only. Conduit never holds a key: `intent` and `disposition`',
    'print a digest for your own wallet to sign, and the resulting transaction is one',
    'anybody may submit.',
    '',
    '`verify` reads two chains and the Wormhole guardian set and consults no Conduit',
    'service. That is deliberate — a verifier that asked us would not be independent.',
  ].join('\n');
}

export interface ParsedCommand {
  readonly name: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

export function parseArgv(argv: readonly string[]): ParsedCommand | undefined {
  const [name, ...rest] = argv;
  if (name === undefined || name.startsWith('-')) return undefined;

  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }

  return { name, positional, flags };
}

/**
 * A settlement ID, or a message saying exactly what was wrong with it.
 *
 * Returning the reason rather than `undefined` because the most common mistake
 * is a truncated copy-paste, and "expected 32 bytes, got 20" is the sentence
 * that fixes it.
 */
export function parseSettlementId(value: string | undefined): { id: Hex } | { error: string } {
  if (value === undefined) return { error: 'no settlement ID given' };
  if (!value.startsWith('0x')) return { error: `expected a 0x-prefixed hash, got "${value}"` };
  const digits = value.length - 2;
  if (digits !== 64) {
    return { error: `expected 32 bytes of hex (64 digits), got ${String(digits)}` };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return { error: 'contains a character that is not hex' };
  }
  return { id: value.toLowerCase() as Hex };
}

/** Exit codes a script can branch on rather than parsing prose. */
export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  /** The command ran and the answer is negative: not settled, not verified. */
  NEGATIVE_RESULT: 3,
  /** The command could not reach something it needed. Says nothing about the settlement. */
  UNREACHABLE: 4,
});

/**
 * How a verification classification maps to an exit code.
 *
 * `SETTLED_PENDING_VERIFICATION` is not success. It means the coordinator says
 * SETTLED and at least one check this verifier ran did not pass, which is the
 * case a caller most needs to notice and the one a naive "did it say SETTLED"
 * grep would miss.
 */
export function exitCodeFor(classification: string): number {
  switch (classification) {
    case 'SETTLED_FINAL':
    case 'DISPOSITION_FINAL':
    case 'RESTRICTED_HOLD_FINAL':
      return EXIT.OK;
    default:
      return EXIT.NEGATIVE_RESULT;
  }
}
