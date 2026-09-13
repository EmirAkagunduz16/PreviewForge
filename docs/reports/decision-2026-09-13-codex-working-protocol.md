---
id: RPT-2026-09-13-codex-working-protocol
type: decision
status: verified
date: 2026-09-13
vault_sync: synced
---

# Apply the Codex working protocol to PreviewForge

## Context

PreviewForge now adopts the user's Codex Working Protocol as a repository-local development rule. The protocol defines scope control, validation, review, uncertainty handling, documentation, reporting, and Git authorization boundaries.

## Verified finding

- The full protocol is available at [`docs/process/codex-calisma-protokolu.md`](../process/codex-calisma-protokolu.md).
- [`AGENTS.md`](../../AGENTS.md) points every repository task to that protocol and requires its core behavior.
- A verified, scope-clean completed task may be committed by the agent on its own initiative, with the commit hash reported to the user.
- Push remains an explicit user-authorized action and is never inferred from permission to commit.
- The protocol does not replace PreviewForge's existing MVP, architecture, security, delivery, control-plane, or Kubernetes rules.

## Evidence

- User-provided source: `/home/emir/Desktop/Codex Çalışma Protokolü.md`, reviewed on 2026-09-13.
- Repository files: `AGENTS.md` and `docs/process/codex-calisma-protokolu.md`.
- `pnpm docs:check`: 62 local Markdown links verified across 33 files on 2026-09-13 before this policy revision.
- Current user instruction on 2026-09-13: allow agent-initiated local commits for this project; keep push explicit.

## Impact / consequences

Future work must stay within the requested scope, state completion criteria, run proportionate verification, perform a second review for high-impact changes, report assumptions and risks, and may leave a clean local commit when the task is verified. No remote push is allowed without explicit user authorization.

## Prevention / next action

At the start of each task, identify the relevant files and acceptance conditions. At the end, report changes, verification, result, risks, and assumptions. Report unrelated problems separately instead of fixing them opportunistically.

## Related links

- [Repository protocol](../process/codex-calisma-protokolu.md)
- [Repository agent guide](../../AGENTS.md)
- [VictusOS distillation](../../../../Documents/VictusOS/Reports/PreviewForge/2026-09-13%20Codex%20Calisma%20Protokolu.md)
