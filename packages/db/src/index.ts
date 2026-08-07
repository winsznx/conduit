/**
 * @conduit-protocol/db
 *
 * PostgreSQL schema, forward-only migrations, and transactional outbox.
 *
 * Phase 00 delivers this workspace as structure only. PRD 11.6, PRD 11.7 defines the
 * behaviour, which lands in phase 06. Nothing here may encode product
 * logic, protocol constants, or external-capability assumptions.
 */

export const PACKAGE_ID = '@conduit-protocol/db';

export const IMPLEMENTATION_PHASE = '06';
