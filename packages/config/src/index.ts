/**
 * @conduit-protocol/config
 *
 * Environment and chain configuration with fail-closed startup validation.
 *
 * PRD 11.1 and CLAUDE.md: validation happens at process start, chain IDs are
 * checked against the RPC before anything else runs, and no error message ever
 * carries a credential value.
 */

export const PACKAGE_ID = '@conduit-protocol/config';

export const IMPLEMENTATION_PHASE = '01';

export { ChainMismatchError, ConfigError } from './errors.js';

export {
  assertAllChainIds,
  assertChainId,
  CHAIN_KEYS,
  chainByNativeId,
  chainByWormholeId,
  CHAINS,
  type ChainDefinition,
  type ChainIdReader,
  type ChainKey,
} from './chains.js';

export {
  credentialPresence,
  REQUIRED_CLEANVERSE_VARS,
  loadCleanverseEnv,
  loadRpcEnv,
  loadRuntimeEnv,
  type CleanverseEnv,
  type CredentialPresence,
  type EnvSource,
  type RpcEnv,
  type RuntimeEnv,
} from './env.js';
