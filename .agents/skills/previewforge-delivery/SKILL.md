---
name: previewforge-delivery
description: Plan and hand off PreviewForge milestones with linked acceptance criteria, active backlog hygiene, and evidence-backed completion records.
---

# PreviewForge delivery

Use this skill for milestone planning, backlog grooming, session handoffs, and completion archival in this repository. It complements the control-plane and Kubernetes skills; it does not replace their domain invariants.

## Read first

- `AGENTS.md`
- `docs/product/mvp-scope.md`
- `docs/architecture/system-design.md`
- relevant ADRs
- `docs/delivery/roadmap.md`
- relevant plan under `docs/plans/`

## Workflow

1. Identify the milestone and preserve its MVP boundary.
2. Give each independently verifiable slice a stable ID and explicit dependency, owner, next action, acceptance criterion, and evidence.
3. Add it to `docs/backlog/active.md` before editing implementation files.
4. Keep active entries limited to unfinished work. Before a session, token budget, or handoff ends, update every unfinished item with its exact next action, blocker, and evidence (or `not-run`).
5. When acceptance is proven, remove the item from `active.md` and append its ID, completion date, evidence, and changed files to `docs/backlog/archive.md`.
6. Link plan, backlog item, ADR, implementation files, tests, and knowledge notes so a later agent can resume without reconstructing context.

## Durable reports and VictusOS sync

For notable work, use `docs/reports/README.md` and its templates. Record only verified incidents, decisions, dated research findings with sources, architecture lessons, or concise session digests; never copy raw chat, credentials, or unverified speculation.

At handoff/end of day, verify evidence first, update the project-canonical report and `docs/reports/index.md`, then distill it into VictusOS with a backlink. Record `vault_sync: pending` when the vault step has not happened; do not claim synchronization. Keep report filenames date-prefixed and type-specific.

Run `pnpm docs:check` after adding or changing report, plan, backlog, knowledge, or vault backlinks. Cross-boundary relative links must resolve from the directory containing the source Markdown file.

## Quality gates

- Do not mark work complete because code exists; cite a command, test, review, or explicit external verification.
- Never hide a blocker by moving an item to a future milestone; keep it active with the smallest unblock action.
- Do not duplicate domain rules owned by `previewforge-control-plane` or `previewforge-kubernetes`; link to them.
- Keep plan and backlog changes scoped to the requested milestone.

## Handoff template

```yaml
id: M1-EXAMPLE
status: in-progress | blocked | needs-review
acceptance_ref: docs/plans/mx-plan.md#SLICE-ID
owned_paths: [path/owned/by/slice]
verification_command: exact command or not-run
next_action: one concrete action and target file/module
blocker: none | exact blocker
acceptance: observable criterion still outstanding
evidence: command/test/link or not-run reason
evidence_commit: commit/tree identifier or not-run until root verification
```
