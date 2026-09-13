---
id: RPT-2026-09-12-delivery-knowledge-pipeline
type: decision
status: verified
date: 2026-09-12
vault_sync: synced
---

# Separate delivery state from durable knowledge

## Context

The roadmap identified M1 as the next milestone, but it did not provide item-level execution state, resumable handoff details, incident history, or a second-brain synchronization contract.

## Decision

PreviewForge uses a linked five-layer delivery knowledge pipeline:

1. `docs/delivery/roadmap.md` defines milestone direction.
2. `docs/plans/` defines ordered, acceptance-driven execution slices.
3. `docs/backlog/active.md` contains only unfinished work; verified completions move to `archive.md`.
4. `docs/reports/` stores verified incidents, decisions, research, lessons, and session digests.
5. VictusOS receives a concise distillation only after the project-canonical report exists, with backlinks in both directions.

The `.agents/skills/previewforge-delivery` skill enforces the repeated backlog, handoff, report, and sync workflow.

## Alternatives rejected

- A roadmap-only workflow does not preserve exact next actions or blockers.
- Keeping completed and unfinished work in one active list makes handoff state ambiguous.
- Writing directly to VictusOS before the repository report would split authority and lose implementation evidence.
- Saving raw chat would add noise and risk retaining secrets or unverified claims.

## Consequences

- Every unfinished item must have a stable ID, exact next action, acceptance criterion, and evidence state before handoff.
- Completion requires observable evidence and removal from the active backlog.
- Reports are selective and verified; VictusOS is distilled, not a transcript mirror.
- The project repository remains the canonical technical record.

## Evidence

- [M1 plan](../plans/m1-durable-control-plane.md)
- [Backlog workflow](../backlog/README.md)
- [Report workflow](README.md)
- [Delivery skill](../../.agents/skills/previewforge-delivery/SKILL.md)

## Related links

- [Session report](session-2026-09-12.md)
- [VictusOS session distillation](../../../../Documents/VictusOS/Reports/PreviewForge/2026-09-12%20Foundation%20to%20M1.md)
