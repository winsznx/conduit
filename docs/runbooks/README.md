# Runbooks

Operational procedures. PRD 17.4 requires a key-rotation runbook and an emergency-revocation
runbook; PRD 19 phase 09 requires the full set tested in a staging incident drill.

| Runbook                                              | Covers                                          | Required by               |
| ---------------------------------------------------- | ----------------------------------------------- | ------------------------- |
| [key-rotation.md](./key-rotation.md)                 | Scheduled rotation of every key class           | PRD 17.4                  |
| [emergency-revocation.md](./emergency-revocation.md) | Suspected compromise of a key or API credential | PRD 17.4                  |
| [incident-response.md](./incident-response.md)       | Alert triage, held value, stuck settlements     | PRD 16.3, PRD 19 phase 09 |

## Status

Skeletons. Each file states its trigger, its decision points, and what must never be done during
the procedure — the parts that are already fixed by the PRD and the invariants. Concrete
commands, addresses, and dashboards are filled in by the phase that creates the thing being
operated, and the whole set is exercised in a staging drill before phase 09 can pass.

A skeleton runbook is useful now for one reason: it records the constraints while there is no
pressure. During an incident nobody re-derives from the PRD that a refund after COMMIT is
impossible.
