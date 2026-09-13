---
id: RPT-2026-09-12-cross-boundary-relative-links
type: incident
status: verified
date: 2026-09-12
vault_sync: synced
---

# Cross-boundary relative links resolved from the wrong depth

## Context

The project memory and VictusOS project note were created in different directory trees and linked to one another with relative Markdown paths.

## Symptom

The displayed link text was correct, but the targets resolved under `PreviewForge/vaults` and `vaults/PreviewForge` instead of their actual locations beneath `/home/emir/Desktop`.

## Root cause

The paths were reasoned about from the repository and vault roots rather than from each containing Markdown file. Both links were one parent traversal short.

## Resolution

The project-to-vault link was changed to start with `../../../vaults/…`; vault project links were changed to start with `../../../PreviewForge/…`. The session report's deeper vault link uses its own containing-file depth.

## Prevention

- Resolve every relative link from the directory containing the source Markdown file.
- For repository-to-vault links, verify the target with a filesystem existence check during integration review.
- Keep cross-boundary links in durable indexes so broken paths are easy to audit.

## Evidence

- [Project memory](../knowledge/previewforge-memory.md)
- [VictusOS project index](../../../vaults/second_brain/Projects/PreviewForge.md)
- [VictusOS session distillation](../../../vaults/second_brain/Reports/PreviewForge/2026-09-12%20Foundation%20to%20M1.md)

## Related links

- [Session report](session-2026-09-12.md)
- [Report workflow](README.md)
