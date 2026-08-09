# Observed latency

Samples, not a benchmark. Every number below is one measurement of one message
on one day, and they are listed rather than averaged because averaging them
would produce a figure that was never observed and would hide the two things
that actually matter: the spread, and the fact that fast transport and economic
finality are different quantities.

## Economic finality, Base Sepolia → Monad Testnet

Receipt to signed VAA, consistency level 1, classified `FINALIZED`. This is what
a settlement waits for, because a COMMIT is irreversible and the remote state it
rests on has to be too.

| Sample | Message        | Seconds | Run                                                               |
| ------ | -------------- | ------- | ----------------------------------------------------------------- |
| 1      | ASSET_PREPARED | 1485    | attempt 3, `phase-06-dvp-attempt-3.json`                          |
| 2      | ASSET_RELEASED | 1223    | attempt 4, `phase-06-dvp-attempt-4.json`                          |
| 3      | ASSET_PREPARED | 1275    | compliance change (gen 1), local log only — ASM-039               |
| 4      | ASSET_HELD     | 999     | compliance change (gen 1), local log only — ASM-039               |
| 5      | ASSET_PREPARED | 1350    | disposition (gen 2), `phase-07-disposition-summary.md`            |
| 6      | ASSET_HELD     | 1093    | disposition (gen 2), `phase-07-disposition-summary.md`            |
| 7      | ASSET_RELEASED | 1483    | disposition (gen 2), `phase-07-disposition-summary.md`            |
| 8      | ASSET_PREPARED | 1189    | disposition (gen 3), `phase-07-compliance-change-0xdcb9db12.json` |
| 9      | ASSET_HELD     | 1483    | disposition (gen 3), `phase-07-compliance-change-0xdcb9db12.json` |

Nine samples: 999, 1093, 1189, 1223, 1275, 1350, 1483, 1483, 1485 seconds. All
are roughly twenty minutes and none of them is "the" number. The spread is 486
seconds across nine observations, which is the honest thing to say about a
testnet's finality and the reason these are listed rather than reduced to one
figure.

Two waits are deliberately absent, both for the same reason. Attempt 4's
ASSET_PREPARED poll ran 2747 seconds without reaching the guardian API at all
and the VAA existed the whole time. The generation-3 ASSET_RELEASED poll
reported 1482 seconds, but it spent part of that failing to connect —
`UND_ERR_CONNECT_TIMEOUT`, seventeen consecutive attempts between 23:44:20Z and
23:51:09Z — and an independent request for the same sequence returned the signed
VAA before the run's own poll recovered. True finality for that message was
therefore at most 1229 seconds and the recorded 1482 is partly transport
recovery. A number that mixes the two measures neither, so neither is published
as a finality sample.

## Fast transport, both directions

Consistency level 200, classified `INSTANT`. Real, useful, and not permitted to
authorize anything.

| Direction                    | Seconds | Source                        |
| ---------------------------- | ------- | ----------------------------- |
| Monad Testnet → Base Sepolia | 3.5     | `phase-02-wormhole-seam.json` |
| Base Sepolia → Monad Testnet | 2.6     | `phase-02-wormhole-seam.json` |

## Monad Testnet → Base Sepolia, finalized

| Sample | Message | Seconds | Run                 |
| ------ | ------- | ------- | ------------------- |
| 1      | COMMIT  | 0       | attempt 4           |
| 2      | COMMIT  | 1       | disposition (gen 3) |

Zero and one second are honest and slightly misleading on their own: Monad's
finality is roughly a block, so the finalized VAA was already available when it
was first requested. The wait was not skipped. It had already elapsed during the
transaction before it.

## Why both are kept

ADR-0013 settled this. Publishing only the fast figure misrepresents settlement,
because Conduit will not accept a fast VAA for anything that moves value.
Publishing only the slow figure understates the transport, which genuinely does
carry a message across in under four seconds. The architecture is more credible
with both, and less credible with either one alone.

The rule for anything derived from this page: quote a sample and say which run
it came from. Do not average across message classes, do not average across
chains, and do not present a range as a guarantee — nine samples of a testnet's
finality are nine samples.
