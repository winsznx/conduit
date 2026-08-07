import {
  CHAIN_KEYS,
  CHAINS,
  credentialPresence,
  loadCleanverseEnv,
  loadRpcEnv,
  type ChainKey,
  type EnvSource,
} from '@conduit-protocol/config';
import {
  aTokensDeployedOn,
  CleanverseApiError,
  CleanverseClient,
  createCipher,
  describeVerifyApassCode,
  NormalizedApassStatus,
  verifyApassAllowsTransfer,
} from '@conduit-protocol/cleanverse';
import { crossCheck, registryFor, WORMHOLE_REGISTRY_PROVENANCE } from '@conduit-protocol/wormhole';

/**
 * The capability doctor. PRD FR-001.
 *
 * Its job is to answer, before any settlement code runs, which of the twelve
 * mandatory unresolved questions in PRD 23 the current credentials and networks
 * can actually answer. Every check is reported with an explicit outcome, and a
 * missing *required* capability exits non-zero.
 *
 * Nothing here prints a secret. Credentials are reported as configured-or-not
 * with a length, which is what the one-shot brief permits.
 */

export type CheckStatus = 'pass' | 'fail' | 'unavailable' | 'skipped';

export interface CapabilityCheck {
  readonly id: string;
  readonly title: string;
  /** A required check that does not pass makes the whole run exit non-zero. */
  readonly required: boolean;
  readonly status: CheckStatus;
  readonly detail: string;
  /** Rows in docs/assumptions.md this check speaks to. */
  readonly assumptions: readonly string[];
}

export interface CapabilityMatrix {
  readonly generatedAt: string;
  readonly ok: boolean;
  readonly checks: readonly CapabilityCheck[];
}

/** Injected so the doctor is testable without a network. */
export interface DoctorDependencies {
  readonly env: EnvSource;
  readonly now: () => Date;
  readonly readChainId: (rpcUrl: string) => Promise<number>;
  readonly readCode: (rpcUrl: string, address: string) => Promise<string>;
  readonly buildClient?: (options: {
    baseUrl: string;
    apiId: string;
    apiKeyBase64: string;
    timeoutMs: number;
    maxReadRetries: number;
  }) => Promise<CleanverseClient>;
}

export interface DoctorOptions {
  /** Wallets to probe with query_apass and verify_apass. */
  readonly testWallets: readonly string[];
  /** Which chain the cash leg lives on. */
  readonly cashChain: ChainKey;
}

function check(
  id: string,
  title: string,
  required: boolean,
  status: CheckStatus,
  detail: string,
  assumptions: readonly string[] = [],
): CapabilityCheck {
  return { id, title, required, status, detail, assumptions };
}

function describeError(error: unknown): string {
  if (error instanceof CleanverseApiError) {
    return `code ${error.code}: ${error.apiMessage}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

async function defaultBuildClient(options: {
  baseUrl: string;
  apiId: string;
  apiKeyBase64: string;
  timeoutMs: number;
  maxReadRetries: number;
}): Promise<CleanverseClient> {
  return new CleanverseClient({
    baseUrl: options.baseUrl,
    apiId: options.apiId,
    cipher: await createCipher(options.apiKeyBase64),
    timeoutMs: options.timeoutMs,
    maxReadRetries: options.maxReadRetries,
  });
}

export async function runDoctor(
  deps: DoctorDependencies,
  options: DoctorOptions,
): Promise<CapabilityMatrix> {
  const checks: CapabilityCheck[] = [];

  // ── Credentials ───────────────────────────────────────────────────────────
  // Presence only. A doctor that printed the key to prove it was set would be
  // the single worst place in the repository to leak one.
  const presence = credentialPresence(deps.env);
  // Only variables with no default block the run. The tuning values fall back to
  // documented defaults, and listing them as missing buries the real gap.
  const missing = presence
    .filter((entry) => entry.required && !entry.configured)
    .map((entry) => entry.name);

  checks.push(
    check(
      'env.cleanverse',
      'Cleanverse credentials configured',
      true,
      missing.length === 0 ? 'pass' : 'fail',
      missing.length === 0
        ? presence
            .filter((e) => e.configured)
            .map((e) => `${e.name}=set(${String(e.length)} chars)`)
            .join(', ')
        : `missing: ${missing.join(', ')}`,
      ['ASM-004'],
    ),
  );

  // ── Wormhole registry ─────────────────────────────────────────────────────
  // Offline checks first: they need no network and they catch a corrupted or
  // hand-edited snapshot before anything else is attempted.
  const registryProblems = crossCheck({
    monadTestnet: CHAINS.monadTestnet,
    arbitrumSepolia: CHAINS.arbitrumSepolia,
  });

  checks.push(
    check(
      'wormhole.registry',
      'pinned Wormhole registry agrees with chain configuration',
      true,
      registryProblems.length === 0 ? 'pass' : 'fail',
      registryProblems.length === 0
        ? `${WORMHOLE_REGISTRY_PROVENANCE.source}@${WORMHOLE_REGISTRY_PROVENANCE.version} (${WORMHOLE_REGISTRY_PROVENANCE.network}), retrieved ${WORMHOLE_REGISTRY_PROVENANCE.retrievedAt}`
        : registryProblems.join('; '),
      ['ASM-016'],
    ),
  );

  for (const key of CHAIN_KEYS) {
    const registry = registryFor(key);
    checks.push(
      check(
        `wormhole.core.${key}`,
        `Wormhole core address for ${key}`,
        true,
        'pass',
        `${registry.coreBridgeAddress} — wormhole chain ${String(registry.wormholeChainId)}, native chain ${String(registry.nativeChainId)}`,
        ['ASM-016'],
      ),
    );
  }

  // ── RPC identity and Wormhole core bytecode ───────────────────────────────
  const rpc = (() => {
    try {
      return loadRpcEnv(deps.env);
    } catch {
      return undefined;
    }
  })();

  for (const key of CHAIN_KEYS) {
    const chain = CHAINS[key];
    const rpcUrl = rpc?.[chain.rpcUrlEnvVar as keyof typeof rpc];

    if (rpcUrl === undefined) {
      checks.push(
        check(
          `rpc.${key}`,
          `${key} RPC reachable and reports the expected chain ID`,
          true,
          'unavailable',
          `${chain.rpcUrlEnvVar} is not set`,
          ['ASM-013'],
        ),
      );
      continue;
    }

    try {
      const actual = await deps.readChainId(rpcUrl);
      const matches = actual === chain.nativeChainId;
      checks.push(
        check(
          `rpc.${key}`,
          `${key} RPC reachable and reports the expected chain ID`,
          true,
          matches ? 'pass' : 'fail',
          matches
            ? `chain ID ${String(actual)}`
            : `chain ID ${String(actual)}, expected ${String(chain.nativeChainId)}`,
          ['ASM-013'],
        ),
      );

      // PRD FR-001: "verify contract bytecode at configured Wormhole core
      // addresses". A registry entry proves what the registry says; only this
      // proves something is deployed there.
      const code = await deps.readCode(rpcUrl, registryFor(key).coreBridgeAddress);
      const deployed = code.length > 2;
      checks.push(
        check(
          `wormhole.bytecode.${key}`,
          `Wormhole core contract deployed on ${key}`,
          true,
          deployed ? 'pass' : 'fail',
          deployed
            ? `${String((code.length - 2) / 2)} bytes at ${registryFor(key).coreBridgeAddress}`
            : `no bytecode at ${registryFor(key).coreBridgeAddress}`,
          ['ASM-011', 'ASM-016'],
        ),
      );
    } catch (error) {
      checks.push(
        check(
          `rpc.${key}`,
          `${key} RPC reachable and reports the expected chain ID`,
          true,
          'unavailable',
          describeError(error),
          ['ASM-013'],
        ),
      );
    }
  }

  // ── Cleanverse capabilities ───────────────────────────────────────────────
  if (missing.length > 0) {
    for (const id of [
      'cleanverse.atokenList',
      'cleanverse.queryApass',
      'cleanverse.verifyApass',
      'cleanverse.validatorReads',
    ]) {
      checks.push(
        check(id, id, true, 'skipped', 'skipped because credentials are not configured', [
          'ASM-004',
        ]),
      );
    }
    return finish(checks, deps.now());
  }

  const env = loadCleanverseEnv(deps.env);
  const buildClient = deps.buildClient ?? defaultBuildClient;
  const client = await buildClient({
    baseUrl: env.CLEANVERSE_BASE_URL,
    apiId: env.CLEANVERSE_API_ID,
    apiKeyBase64: env.CLEANVERSE_API_KEY_BASE64,
    timeoutMs: env.CLEANVERSE_REQUEST_TIMEOUT_MS,
    maxReadRetries: env.CLEANVERSE_MAX_READ_RETRIES,
  });

  const cashChain = CHAINS[options.cashChain];

  // PRD 2.4: the A-Token is discovered, never hardcoded. Everything downstream
  // depends on this answer, so it runs first and gates the rest.
  let atokenAddress: string | undefined;
  try {
    const list = await client.queryDepositATokenList(cashChain.cleanverseChain);

    // The endpoint ignores its `chain` argument and returns every token across
    // every chain it supports, with no chain field on any entry. Attribution
    // comes from chain state instead: a token is on this chain when this
    // chain's RPC reports bytecode at its address.
    const rpcUrl = rpc?.[cashChain.rpcUrlEnvVar as keyof typeof rpc];
    const onChain =
      rpcUrl === undefined
        ? []
        : await aTokensDeployedOn(list.data.tokens, (address) => deps.readCode(rpcUrl, address));

    atokenAddress = onChain[0]?.aTokenAddress;

    checks.push(
      check(
        'cleanverse.atokenList',
        `A-Token discovery on ${options.cashChain}`,
        true,
        onChain.length > 0 ? 'pass' : 'fail',
        onChain.length > 0
          ? `${String(onChain.length)} of ${String(list.data.tokens.length)} discovered entries are deployed on ${options.cashChain}: ` +
              onChain
                .map(
                  (t) =>
                    `${t.symbol} ${t.aTokenAddress} (${String(t.decimals)} decimals, ${String(t.originTokens.length)} origin token(s))`,
                )
                .join('; ')
          : rpcUrl === undefined
            ? `cannot attribute tokens to a chain without ${cashChain.rpcUrlEnvVar}`
            : `none of the ${String(list.data.tokens.length)} discovered tokens are deployed on ${options.cashChain}`,
        ['ASM-001'],
      ),
    );
  } catch (error) {
    checks.push(
      check(
        'cleanverse.atokenList',
        'A-Token discovery on the cash chain',
        true,
        'fail',
        describeError(error),
        ['ASM-001'],
      ),
    );
  }

  for (const wallet of options.testWallets) {
    try {
      const { normalized } = await client.queryApass(cashChain.cleanverseChain, wallet, {
        now: Math.floor(deps.now().getTime() / 1000),
        warningWindowSeconds: 86_400,
      });
      checks.push(
        check(
          `cleanverse.queryApass.${wallet}`,
          `A-Pass state for ${wallet}`,
          true,
          normalized.status === NormalizedApassStatus.UNKNOWN ? 'fail' : 'pass',
          `${normalized.status}${normalized.restricted ? ' (restricted)' : ''}`,
          ['ASM-004'],
        ),
      );
    } catch (error) {
      checks.push(
        check(
          `cleanverse.queryApass.${wallet}`,
          `A-Pass state for ${wallet}`,
          true,
          'fail',
          describeError(error),
          ['ASM-004'],
        ),
      );
    }

    if (atokenAddress === undefined) continue;

    try {
      const verify = await client.verifyApass(cashChain.cleanverseChain, wallet, atokenAddress);
      const allowed = verifyApassAllowsTransfer(verify.data.code);
      checks.push(
        check(
          `cleanverse.verifyApass.${wallet}`,
          `A-Token transfer eligibility for ${wallet}`,
          // Not required to be *allowed*: a deliberate negative wallet proving
          // code 3 is as valuable as a positive proving code 4.
          false,
          'pass',
          `code ${String(verify.data.code)} — ${describeVerifyApassCode(verify.data.code)}${allowed ? '' : ' (not eligible)'}`,
          ['ASM-007'],
        ),
      );
    } catch (error) {
      checks.push(
        check(
          `cleanverse.verifyApass.${wallet}`,
          `A-Token transfer eligibility for ${wallet}`,
          true,
          'fail',
          describeError(error),
          ['ASM-007'],
        ),
      );
    }
  }

  return finish(checks, deps.now());
}

function finish(checks: readonly CapabilityCheck[], now: Date): CapabilityMatrix {
  const ok = !checks.some((c) => c.required && c.status !== 'pass');
  return { generatedAt: now.toISOString(), ok, checks };
}

/** Human-readable rendering. The machine-readable form is the matrix itself. */
export function formatMatrix(matrix: CapabilityMatrix): string {
  const symbol: Record<CheckStatus, string> = {
    pass: 'ok  ',
    fail: 'FAIL',
    unavailable: 'n/a ',
    skipped: 'skip',
  };

  const lines = matrix.checks.map((c) => {
    const required = c.required ? 'required' : 'optional';
    const assumptions = c.assumptions.length > 0 ? `  [${c.assumptions.join(', ')}]` : '';
    return `${symbol[c.status]}  ${c.id}  (${required})${assumptions}\n        ${c.detail}`;
  });

  const failures = matrix.checks.filter((c) => c.required && c.status !== 'pass').length;

  return [
    `conduit doctor — ${matrix.generatedAt}`,
    '',
    ...lines,
    '',
    matrix.ok
      ? `all ${String(matrix.checks.length)} checks satisfied`
      : `${String(failures)} required capability check(s) not satisfied`,
  ].join('\n');
}
