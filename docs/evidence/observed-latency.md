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

| Sample | Message        | Seconds | Run                                      |
| ------ | -------------- | ------- | ---------------------------------------- |
| 1      | ASSET_PREPARED | 1485    | attempt 3, `phase-06-dvp-attempt-3.json` |
| 2      | ASSET_RELEASED | 1223    | attempt 4, `phase-06-dvp-attempt-4.json` |

Two samples, 1223 and 1485 seconds. Both are roughly twenty minutes and neither
is "the" number. Attempt 4's ASSET_PREPARED wait is deliberately absent: that
poll ran 2747 seconds without reaching the guardian API at all and the VAA
existed the whole time, so it measures a transport outage rather than finality
and reporting it as either would be wrong.

## Fast transport, both directions

Consistency level 200, classified `INSTANT`. Real, useful, and not permitted to
authorize anything.

| Direction                    | Seconds | Source                        |
| ---------------------------- | ------- | ----------------------------- |
| Monad Testnet → Base Sepolia | 3.5     | `phase-02-wormhole-seam.json` |
| Base Sepolia → Monad Testnet | 2.6     | `phase-02-wormhole-seam.json` |

## Monad Testnet → Base Sepolia, finalized

| Sample | Message | Seconds | Run       |
| ------ | ------- | ------- | --------- |
| 1      | COMMIT  | 0       | attempt 4 |

Zero is honest and slightly misleading on its own: Monad's finality is roughly a
block, so the finalized VAA was already available when it was first requested.
It is not that the wait was skipped — it is that the wait had already elapsed
during the transaction before it.

## Why both are kept

ADR-0013 settled this. Publishing only the fast figure misrepresents settlement,
because Conduit will not accept a fast VAA for anything that moves value.
Publishing only the slow figure understates the transport, which genuinely does
carry a message across in under four seconds. The architecture is more credible
with both, and less credible with either one alone.

The rule for anything derived from this page: quote a sample and say which run
it came from. Do not average across message classes, do not average across
chains, and do not present a range as a guarantee — two samples of a testnet's
finality are two samples.
