/**
 * Configuration failures are always fatal and always safe to print.
 *
 * Every message here is built from variable *names* and constraint descriptions,
 * never from values. CLAUDE.md forbids a secret reaching a log, and a config
 * error is the most likely place for one to leak: the natural phrasing of
 * "expected X, got Y" prints the credential that was almost right.
 *
 * Fields are declared explicitly rather than as constructor parameter
 * properties, because `erasableSyntaxOnly` keeps this source runnable under
 * type stripping with no build step.
 */
export class ConfigError extends Error {
  public override readonly name = 'ConfigError';
  public readonly problems: readonly string[];

  public constructor(message: string, problems: readonly string[] = []) {
    super(problems.length === 0 ? message : `${message}\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

export class ChainMismatchError extends Error {
  public override readonly name = 'ChainMismatchError';
  public readonly chain: string;
  public readonly expectedChainId: number;
  public readonly actualChainId: number;

  public constructor(chain: string, expectedChainId: number, actualChainId: number) {
    super(
      `RPC for ${chain} reports chain ID ${String(actualChainId)}, expected ${String(
        expectedChainId,
      )}. Refusing to start against the wrong network.`,
    );
    this.chain = chain;
    this.expectedChainId = expectedChainId;
    this.actualChainId = actualChainId;
  }
}
