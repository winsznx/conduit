# Terraform CLI is pinned exactly, per PRD 11.1: no floating Terraform provider
# and no floating toolchain. The version is mirrored in toolchain.json and
# asserted by tests/toolchain.test.ts.
#
# No `required_providers` block exists yet, and that is deliberate. PRD 17.2
# lists what infrastructure must be provisioned but does not name a cloud, and
# CLAUDE.md forbids turning an unresolved assumption into a fact. The target is
# tracked as ASM-014 in docs/assumptions.md and decided by an ADR before the
# first resource lands in phase 09. Adding a provider now would encode a choice
# nobody has made.

terraform {
  required_version = "1.15.8"
}
