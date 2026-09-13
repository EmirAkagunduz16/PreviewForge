---
name: previewforge-milestone-orchestrator
description: Plan, delegate, integrate, and verify PreviewForge milestones with collision-free Luna subagents and independent acceptance evidence. Use for M2-M8 milestone planning or implementation and substantial multi-slice delivery; do not use for a single small edit or status-only request.
---

# PreviewForge milestone orchestrator

Use this skill with `previewforge-delivery` and the domain skill relevant to the milestone. The root agent owns scope, integration, verification, backlog/reporting, and acceptance; subagents own bounded slices.

## Establish the milestone contract

1. Read `AGENTS.md`, MVP scope, system design, roadmap, relevant ADRs/domain skills, and the milestone plan if it exists.
2. Distinguish planning from implementation. During planning, inspect and research but do not edit product implementation unless the user also authorized implementation.
3. Resolve contract choices that would materially change the implementation before delegation. Record unresolved choices as blockers rather than letting separate agents invent incompatible answers.
4. Decompose the milestone into independently verifiable vertical slices with stable IDs, dependency waves, exact next actions, acceptance criteria, and evidence fields. Put unfinished slices in `docs/backlog/active.md` before implementation.
5. Define an acceptance matrix before delegation. Every slice must link a complete risk, stimulus, oracle, fault-sensitivity, and runtime row. For test design, read [real acceptance testing](references/real-acceptance-testing.md).
6. Derive a milestone exit checklist from the roadmap and explicitly exclude later-milestone work.

## Delegate without collisions

- Use Luna subagents for milestone research and implementation unless the user requests a different model. Use parallel read-only research during planning when it shortens discovery.
- Before delegation, record a machine-readable ownership ledger, baseline tree/commit, `git status --short`, and staged/unstaged changed-file lists or hashes. Treat pre-existing dirty paths as protected unless root explicitly reserves them while preserving their baseline. Include generated output, migrations, shared exports, manifests, lockfiles, backlog, and reports. Give each implementation agent an exclusive file/directory ownership set. Keep shared files with the root agent unless one agent receives explicit exclusive ownership.
- Never assign the same writable file to concurrent agents. If two slices require it, sequence those edits or reserve the file for root integration.
- Tell every agent which project and domain instructions to read, which files it may edit, which files are forbidden, and which narrow checks it must run.
- Run agents only when their dependency wave is ready. Read-only researchers must not edit. Implementation agents must stop and notify root if their work requires an unowned path or they observe an unexpected outside-ownership change.
- Root must not edit an active agent's owned paths. Quiesce all slice agents before integration and compare the final changed-file set with the ownership ledger.
- Treat agent completion messages as claims, not evidence. Do not archive work based on a subagent summary.

## Independently verify and repair

For each returned slice, the root agent must:

1. Inspect the actual diff and check it against architecture, security, boundary validation, idempotency, and slice acceptance criteria.
2. Review the tests for observability and failure sensitivity; reject tautological, mock-only, snapshot-only, or implementation-call-count evidence when the acceptance criterion concerns durable behavior.
3. Run a dependency preflight and verify a redacted safe-environment identity: database host/name/schema or container, Kafka broker, Docker context, and Kubernetes context/namespace as applicable. Refuse production/shared targets for destructive or concurrency tests. Missing required runtime evidence is `not-run`/blocked, never a mock substitute or conditional skip.
4. Run the narrowest meaningful checks independently, then exercise the real dependency where the claim depends on PostgreSQL, Kafka, Docker, Kubernetes, or another runtime. Record expected and observed test files/case counts; run each critical acceptance target directly at least once so zero-test or wrong-glob success cannot pass.
5. Run an adversarial case from the acceptance matrix. Critical security, durability, concurrency, raw-boundary, and idempotency claims require fault-sensitivity evidence: reproduce the original defect or demonstrate that the acceptance test fails under a deliberate temporary mutation, fault injection, or disabled guard, then restore the correct tree.
6. If verification fails, do not silently repair or accept the slice. Send the responsible agent the exact failing command, relevant output, expected invariant, and its original file ownership via `followup_task`. Review and rerun after the repair. Stop after three consecutive repair rounds for the same diagnosis or six total repair rounds for that slice in the session; relabeling a symptom does not reset either limit. Keep the slice active with exact evidence and request direction. Reset or recreate disposable runtime state before repeating destructive, concurrency, or fault-injection acceptance tests so residue cannot produce false evidence.

The root may fix integration-only shared files: wiring, exports, generated metadata, or shared configuration. The root must not change domain logic, persistence/security semantics, or slice tests merely to make acceptance pass; return those defects to the owner or leave the slice active if the owner is unavailable. Root sign-off is mandatory for runtime, security, and external-permission evidence.

Subagents may modify only their owned repository paths and disposable local test resources. They must not discover/read secrets, alter production/shared infrastructure, install system-wide software, or perform external mutations. Root retains credentialed/privileged actions and requests authorization when required. Preserve all other safe in-scope autonomy.

## Integrate and close

- Merge work through the shared filesystem only after ownership and baseline-diff checks. Never revert unrelated user or agent changes.
- Run focused tests while iterating and the repository-wide `pnpm check` before completion. Supply the real local PostgreSQL URL explicitly when the integration gate requires it.
- Do not claim Kubernetes behavior without a real test cluster or external integrations without the corresponding sandbox/test environment.
- Keep failed or unverified slices active with the exact next action and evidence. Archive only evidence produced after final integration; any relevant edit invalidates earlier evidence and requires rerunning the affected acceptance.
- Record final evidence with tree/commit identifier, timestamp, exact command, safe runtime identity, expected/observed test count, changed-file set, and adversarial result.
- Record notable verified outcomes under `docs/reports/`, update the project-canonical memory, run `pnpm docs:check`, and sync a distilled VictusOS note only after the canonical report exists.

## Handoff summary

Report the completed slice IDs, root-run test commands/results, repairs triggered by failed verification, remaining blockers, active backlog, and the next milestone action. Mention agent contribution without presenting it as independent proof.
