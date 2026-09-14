# PreviewForge backlog

This backlog is the durable handoff surface for unfinished work. The active list contains only queued, in-progress, blocked, or review-pending items.

## Files and IDs

- `active.md` — source of truth for unfinished work; remove an item as soon as it is complete.
- `archive.md` — append-only completion history with evidence and completion date.
- IDs use milestone prefixes (`M1-DB`, `M1-OBS`, `M2-WEBHOOK`) and remain stable; never reuse an ID.
- Detailed plans live under `docs/plans/` and link each execution item to a backlog ID.

## Lifecycle

1. Add a focused item to `active.md` before starting it, with dependencies and an acceptance test.
2. Update status as work progresses; preserve next action and evidence.
3. Before tokens, time, or a session end, add a handoff entry for every unfinished item. A missing handoff is a process failure.
4. When acceptance is proven, remove the item from `active.md` and append it to `archive.md` with completion date, evidence, and changed-file links.
5. If blocked, keep it active with the exact blocker and smallest unblock action; never silently defer it.

## Required item shape

```yaml
id: M1-EXAMPLE
status: queued | in-progress | blocked | needs-review
title: short imperative title
owner: agent or role
depends_on: []
acceptance_ref: docs/plans/mx-plan.md#SLICE-ID
owned_paths: [path/owned/by/slice]
verification_command: exact command or `not-run` when dependencies are not ready
next_action: concrete next edit or command
acceptance: observable proof of completion
evidence: command, test, link, or not-run reason
evidence_commit: commit/tree identifier or `not-run` until root verification
```

Archive entries keep the same ID plus `completed_on`, `evidence`, and `changed_files`. Completed entries do not belong in `active.md`.
