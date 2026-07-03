# 0006. Convergence over checkpointing (checkpoints as substrate accelerators)

- Status: Accepted

## Decision

Warm state is maintained **live and layered** (fingerprint ledger, machine-global
package stores, baked data templates, compiler incrementality) and each bind
**converges** the environment to the requested source/data state — backlot never
freezes or restores opaque machine images itself. Where a substrate offers true
checkpointing (Morph, Sprites), the driver uses it as a provisioning accelerator:
checkpoint for the base, convergence for the delta.

## Rationale

Restoration can only reproduce states that were snapshotted; the primary request —
"my current dirty worktree" — has never existed before. Convergence handles arbitrary
targets, invalidates layers selectively (lockfile hash ≠ seed hash), and requires no
hypervisor — true process checkpointing does not exist on macOS, the primary consumer
platform. A checkpoint is a photograph; a warm environment is a kitchen already
mise-en-place.
