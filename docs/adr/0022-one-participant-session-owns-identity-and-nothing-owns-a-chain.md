# ADR-0022: One participant session owns identity, and nothing owns a chain

**Status:** Accepted
**Date:** 2026-08-09
**Phase:** 07
**Supersedes:** —
**Superseded by:** —

## Context

The browser layer grew one component at a time, and each component learned about
the wallet for itself. By the time the participant flow was complete, four
independent surfaces were discovering wallets, restoring accounts, reading
balances and asking Cleanverse:

- the top-bar connect control,
- the sidebar identity strip,
- the composer, which read both token balances directly from two RPCs,
- the settlement workspace, which re-read everything on its own ten-second poll.

Each one was individually correct. Together they were four sources of truth for
one fact. A page carrying the composer and the wallet control made two
`balanceOf` calls for the same number, and a page open while an account changed
in the wallet could render the new address in one place and the old address's
eligibility in another. Nothing in the protocol was ever at risk — every write
still re-read chain state before it acted — but the product read as four
loosely-related tools sharing a stylesheet.

The pressure to fix it the wrong way was specific: give the application an
active chain, put a network switcher next to the account, and let each page read
`state.chainId` to decide what to offer.

## Decision

### One session, and the views subscribe to it

`apps/web/src/client/session.ts` holds a single `ConduitSession`. It owns:
wallet identity, connection status, the Cleanverse verdict per chain, the four
balances, the activity log, notifications, and whether this account has been
oriented. Every surface renders from it and none of them fetches for itself.

It wraps the existing `wallet` singleton rather than replacing it. The wallet
layer stays the authority on the EIP-1193 connection and on `ensureChain`; the
session owns everything _derived_ from it and nothing below it. This is
deliberate: the transaction code in `tx.ts` is the part that has driven real
settlements on two chains, and a session refactor is not a reason to touch it.

Reads are coalesced by key, so three components rendering the same account
produce one eligibility call. Eligibility carries a five-minute TTL, and a
`BroadcastChannel` carries account changes, activity and protocol movement
between tabs.

### Events, not effect chains

The session emits a named event with every state change — `ACCOUNT_CONNECTED`,
`ACCOUNT_CHANGED`, `ELIGIBILITY_REFRESHED`, `TX_CONFIRMED`,
`PROTOCOL_STATE_CHANGED`, and the rest. A subscriber that only cares about one
of them checks the event rather than diffing state it did not ask for.

The overview uses this directly: it repaints the participant's position on any
change, and re-fetches their settlement list only on `ACCOUNT_CHANGED` or
`PROTOCOL_STATE_CHANGED`. That is the difference between a dashboard that
refreshes when something happened and one that refreshes because a timer fired.

### Conduit has no active network

This is the part that would have been easiest to get wrong.

A Conduit settlement uses both chains at once. The cash leg lives on Monad
Testnet and the restricted asset lives on Base Sepolia, and a participant moving
one settlement forward will send transactions to both within the same few
minutes. There is no moment at which "the app is on Base" is a true statement
about anything.

So the session holds no `selectedChain`, the account panel offers no network
picker, and no view branches on which chain the wallet happens to point at. What
the panel does show is both chains, both verdicts, and a marker for where the
wallet currently is — information, not a mode.

The switch belongs to the action. `runWrite` in `tx.ts` compares
`wallet.current.chainId` against the chain the step needs and calls
`ensureChain` when they differ, as its own rung on the ladder, so "your wallet
is on the wrong network" stays a distinct thing from "the transaction reverted".
`settlement.spec.ts` asserts that a Base action asks the wallet to move to Base;
`wallet.spec.ts` asserts that merely opening the account panel asks for nothing.

### The activity log outlives the page

Transaction state used to live in the panel that started it. The central wait in
this protocol is Base finality, observed at 999–1485 seconds, and a participant
who opens the verifier during it should not lose the record of what is in
flight.

Every write now reports each rung to `session.track`, keyed by settlement and
step, and a drawer renders that on every route. The workspace still paints its
own ladder — that is where somebody is looking while a transaction runs — and
the copy in the session is what survives navigation.

It is deliberately not authoritative. The settlement's state is read back from
both chains every time; the log records what this browser sent.

## Consequences

Accepted:

- One `eth_accounts` call per page load instead of one per component.
- An account change repaints every surface from one state, so two parts of one
  screen cannot disagree about who you are.
- A participant can leave a settlement page without losing sight of a pending
  action, and a second tab sees the same session.
- `/app` leads with the participant's own settlements and position, from
  `GET /api/participant`, rather than with the newest rows in the projection.

Costs, stated plainly:

- The session is a singleton with module-level state. In a browser that is
  correct — there is one user per document — but it means tests that need two
  identities need two contexts, which is what the Playwright specs already do.
- Client state is now shared, so a bug in the session is a bug everywhere rather
  than in one panel. This is the trade that was made on purpose: one place that
  can be wrong and inspected, instead of four that can quietly diverge.
- `session.track` records a browser's own claims about its own transactions. It
  authorises nothing and is never read back as evidence. The evidence is the
  chain, and `docs/evidence/` is where the proof of that lives.

## Alternatives considered

**A global selected chain with a network switcher.** Rejected. It is the
convention in wallet-connected apps and it is wrong here: it invents a mode the
protocol does not have, and it would let a participant sit on Monad looking at a
Base action wondering why nothing works. The action asking for its own chain is
both simpler and truthful.

**A reactive framework.** Rejected. The pages are server-rendered and fully
readable with JavaScript disabled, which is a property a proof surface should
keep. A framework would have to own the DOM to be worth its weight.

**Leaving the components independent and deduplicating the RPC calls with a
cache.** Rejected. It would have removed the duplicate reads and left the real
defect in place: four components that can each hold a different answer.
