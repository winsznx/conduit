/**
 * @conduit-protocol/cli
 *
 * The `conduit` command line. PRD FR-015.
 *
 * Phase 01 ships `doctor`. The remaining verbs — create-intent, inspect, relay,
 * verify, export-audit — arrive with the subsystems they drive, and each is
 * registered as it lands rather than stubbed now.
 */

export const PACKAGE_ID = '@conduit-protocol/cli';

export const IMPLEMENTATION_PHASE = '01';

export {
  formatMatrix,
  runDoctor,
  type CapabilityCheck,
  type CapabilityMatrix,
  type CheckStatus,
  type DoctorDependencies,
  type DoctorOptions,
} from './doctor.js';

export { readChainId, readCode } from './rpc.js';
