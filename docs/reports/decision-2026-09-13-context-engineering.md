---
id: RPT-2026-09-13-context-engineering
type: decision
status: verified
date: 2026-09-13
vault_sync: synced
---

# Keep task context bounded and status sources explicit

## Context

The repository had separate delivery and knowledge artifacts, but README, milestone plans, and project memory could drift from the roadmap and active backlog.

## Decision

`README.md` points to the active roadmap, plan, and backlog. `AGENTS.md` defines progressive context loading and names each source of truth. Project memory is a discovery index rather than a progress tracker. Sub-agent handoffs use a bounded context packet. Completed M2 planning now links directly to its evidence report, and M3 backlog entries distinguish implementation from root verification. `pnpm docs:check` also validates backlog acceptance references, owned paths, verification commands, evidence fields, plan status, and active/archive IDs.

## Evidence

- `pnpm docs:check` passed after the documentation changes.
- `pnpm docs:check` passed after adding the consistency gate: 86 local links, 4 roadmap milestones, 3 plans, and 6 active backlog entries.
- Updated files: `README.md`, `AGENTS.md`, `docs/plans/`, `docs/knowledge/previewforge-memory.md`, `docs/backlog/`, `scripts/check-context-consistency.mjs`, and the milestone orchestrator/delivery skills.

## Impact / consequences

Agents can discover current work from the roadmap and backlog without loading all historical reports. Historical evidence remains available through reports and memory links.

## Prevention / next action

Keep milestone status authoritative in the roadmap and unfinished work authoritative in `docs/backlog/active.md`. Record future context-policy changes here rather than duplicating them in session reports.

## Related links

- [README](../../README.md)
- [Agent guide](../../AGENTS.md)
- [Delivery roadmap](../delivery/roadmap.md)
- [Active backlog](../backlog/active.md)
- [Project memory](../knowledge/previewforge-memory.md)
- [VictusOS distillation](../../../../Documents/VictusOS/Reports/PreviewForge/2026-09-13%20Context%20Engineering.md)
