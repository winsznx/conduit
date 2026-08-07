#!/usr/bin/env node
/**
 * Generates the differential-test corpus. PRD 19 phase 04 gate.
 *
 * The gate is "reference model and contracts produce identical outcomes for
 * generated traces". Matching hashes are not enough for that: two
 * implementations can agree on every digest and still disagree on which
 * sequences of events are legal.
 *
 * So this walks pseudo-random command sequences through `packages/domain`, the
 * pure reference model, and records what the model decided — both the accepted
 * transitions and the refusals. `contracts/test/Differential.t.sol` replays the
 * same sequences through the deployed coordinator and asserts it lands in the
 * same state.
 *
 * The generator is deterministic. A seeded PRNG rather than Math.random means a
 * failing trace is reproducible from the fixture alone, and the fixture is
 * committed so CI and a laptop run identical cases.
 *
 *   node scripts/generate-settlement-traces.mjs [count]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { apply, INITIAL_SETTLEMENT, SettlementEvent } from '@conduit-protocol/domain';

import { ROOT } from './lib/run.mjs';

/** Events the coordinator can be driven through. Leg-level disposition is phase 07. */
const DRIVABLE = [
  SettlementEvent.RETURN_CASH,
  SettlementEvent.RETURN_ASSET,
  SettlementEvent.PREPARE_CASH,
  SettlementEvent.PREPARE_ASSET,
  SettlementEvent.ISSUE_COMMIT,
  SettlementEvent.ISSUE_ABORT,
  SettlementEvent.RELEASE_CASH,
  SettlementEvent.HOLD_CASH,
  SettlementEvent.RELEASE_ASSET,
  SettlementEvent.HOLD_ASSET,
];

/**
 * Stable numeric codes for the fixture.
 *
 * Solidity reads the corpus through `vm.parseJsonUintArray`, so the events cross
 * the language boundary as integers. These are positional and must never be
 * renumbered: the fixture is committed, and a reordering would silently replay
 * different traces than the ones the model was run against.
 */
const EVENT_CODE = {
  [SettlementEvent.PREPARE_CASH]: 0,
  [SettlementEvent.PREPARE_ASSET]: 1,
  [SettlementEvent.ISSUE_COMMIT]: 2,
  [SettlementEvent.ISSUE_ABORT]: 3,
  [SettlementEvent.RELEASE_CASH]: 4,
  [SettlementEvent.HOLD_CASH]: 5,
  [SettlementEvent.RELEASE_ASSET]: 6,
  [SettlementEvent.HOLD_ASSET]: 7,
  [SettlementEvent.RETURN_CASH]: 8,
  [SettlementEvent.RETURN_ASSET]: 9,
};

/** Value locked but not yet released, returned, or charged, for the event's leg. */
function outstandingFor(settlement, event) {
  const ledger = event.endsWith('_CASH') ? settlement.cash : settlement.asset;
  return ledger.locked - ledger.released - ledger.returned - ledger.fee;
}

/** mulberry32. Small, deterministic, and adequate for choosing an index. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Skeletons of the journeys PRD 5 describes.
 *
 * Purely random walks almost never reach a terminal state: getting to SETTLED
 * needs four specific events in order, which a uniform choice over eight events
 * finds roughly once in four thousand traces. Without these the corpus would
 * look broad while never exercising the transitions that matter most.
 *
 * Noise is still injected into every skeleton, so these are not just replays of
 * the happy path.
 */
const SKELETONS = [
  // 5.1 happy path
  [
    SettlementEvent.PREPARE_CASH,
    SettlementEvent.PREPARE_ASSET,
    SettlementEvent.ISSUE_COMMIT,
    SettlementEvent.RELEASE_CASH,
    SettlementEvent.RELEASE_ASSET,
  ],
  // 5.2 pre-commit abort, both legs returned
  [
    SettlementEvent.PREPARE_CASH,
    SettlementEvent.PREPARE_ASSET,
    SettlementEvent.ISSUE_ABORT,
    SettlementEvent.RETURN_CASH,
    SettlementEvent.RETURN_ASSET,
  ],
  // 5.3 post-commit compliance failure, one leg held
  [
    SettlementEvent.PREPARE_CASH,
    SettlementEvent.PREPARE_ASSET,
    SettlementEvent.ISSUE_COMMIT,
    SettlementEvent.HOLD_CASH,
    SettlementEvent.RELEASE_ASSET,
  ],
  // both legs held
  [
    SettlementEvent.PREPARE_CASH,
    SettlementEvent.PREPARE_ASSET,
    SettlementEvent.ISSUE_COMMIT,
    SettlementEvent.HOLD_CASH,
    SettlementEvent.HOLD_ASSET,
  ],
];

// Read the count from the first numeric argument, not from argv[2]: passing
// `--check` used to parse as NaN and silently generate zero traces, which the
// corpus-width guard then reported as "too narrow".
const countArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const count = countArg === undefined ? 400 : Number.parseInt(countArg, 10);
const random = prng(0xc0ffee);
const traces = [];

for (let i = 0; i < count; i += 1) {
  // Half guided, half free. The free half finds orderings nobody thought of;
  // the guided half guarantees the interesting states are actually reached.
  const guided = i % 2 === 0;
  const skeleton = SKELETONS[Math.floor(random() * SKELETONS.length)];
  const length = guided ? skeleton.length + Math.floor(random() * 3) : 3 + Math.floor(random() * 7);

  let settlement = INITIAL_SETTLEMENT;
  const steps = [];

  for (let step = 0; step < length; step += 1) {
    const event =
      guided && step < skeleton.length && random() > 0.15
        ? skeleton[step]
        : DRIVABLE[Math.floor(random() * DRIVABLE.length)];
    // Release, return, and hold must move the exact outstanding balance, so the
    // amount is derived from the ledger rather than guessed. Passing 0 made
    // every one of them fail as "amount must be positive", which is why an
    // earlier corpus reached COMMIT_ISSUED 101 times and SETTLED never.
    const amount = event.startsWith('PREPARE') ? 1_000n : outstandingFor(settlement, event);

    const result = apply(settlement, { event, amount });

    // Refusals are recorded, not skipped. A contract that *accepts* something
    // the model refuses is exactly the divergence this corpus exists to find,
    // and it is invisible if only the happy steps are replayed.
    steps.push({ event, accepted: result.ok });
    if (result.ok) settlement = result.settlement;
  }

  traces.push({
    seed: i,
    codes: steps.map((s) => EVENT_CODE[s.event]),
    accepted: steps.map((s) => (s.accepted ? 1 : 0)),
    expectedState: settlement.state,
    expectedDecision: settlement.decision,
    steps,
  });
}

const outcomes = new Map();
for (const trace of traces) {
  outcomes.set(trace.expectedState, (outcomes.get(trace.expectedState) ?? 0) + 1);
}

const path = join(ROOT, 'contracts', 'test', 'fixtures', 'settlement-traces.json');
// `count` is emitted explicitly: Foundry's JSON path support has no working
// wildcard for array length, and deriving it in Solidity would mean guessing.
const serialized = `${JSON.stringify({ count: traces.length, traces }, null, 2)}\n`;

// `--check` is what the gate runs. The corpus is committed so CI and a laptop
// replay identical cases, which only holds while the file still matches the
// model it was generated from. A drifted fixture would let the differential
// test pass against a reference model that no longer exists.
if (process.argv.includes('--check')) {
  const committed = readFileSync(path, 'utf8');
  if (committed !== serialized) {
    console.error('the committed trace corpus does not match the current reference model');
    console.error('regenerate it: node scripts/generate-settlement-traces.mjs');
    process.exit(1);
  }
  console.log(`trace corpus matches the reference model (${String(traces.length)} traces)`);
  process.exit(0);
}

writeFileSync(path, serialized);

console.log(`generated ${String(traces.length)} traces`);
for (const [state, n] of [...outcomes].sort()) {
  console.log(`  ${state.padEnd(16)} ${String(n)}`);
}
console.log(`\nwritten ${path}`);

// A corpus that only ever reaches one state proves nothing. Fail loudly rather
// than shipping a differential test that cannot distinguish two implementations.
if (outcomes.size < 4) {
  console.error(
    `\nonly ${String(outcomes.size)} distinct terminal states reached; corpus is too narrow`,
  );
  process.exit(1);
}
