/**
 * @conduit-protocol/db
 *
 * PostgreSQL schema, forward-only migrations, and the transactional outbox.
 *
 * Everything here is a projection. PRD 11.6 and 11.7 define the tables;
 * CLAUDE.md defines what they may never be: application database state never
 * authorizes value movement. A row records what a chain or Cleanverse said, and
 * a contract is still the only thing that decides.
 *
 * Identity is a pair throughout, and `schema.test.ts` fails the build if a
 * unique key on a bare address appears (ADR-0018). The deployed system has
 * produced that collision twice, on two different generations.
 */

export const PACKAGE_ID = '@conduit-protocol/db';

/** PRD 11.6 and 11.7 place the projection in phase 06. */
export const IMPLEMENTATION_PHASE = '06';

export {
  connectionStringFrom,
  createDatabase,
  type Database,
  type DatabaseOptions,
} from './client.js';

export {
  backoffSeconds,
  claim,
  dispatch,
  fail,
  publish,
  succeed,
  type ClaimedJob,
  type OutboxRecord,
} from './outbox.js';

export {
  authorityPolicies,
  complianceAttestations,
  deploymentContracts,
  deployments,
  dispositionCases,
  dispositionOrders,
  evidenceArtifacts,
  indexedEvents,
  indexerCursors,
  indexerGaps,
  intents,
  messages,
  outbox,
  schema,
  settlementLegs,
  settlements,
  vaas,
  verificationRuns,
  workerJobs,
} from './schema.js';
