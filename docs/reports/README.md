# PreviewForge reports

This directory stores durable, verified project knowledge distilled from implementation sessions. It is not a chat transcript and must not contain secrets, tokens, raw payloads, or speculative claims.

## Report types

- incident-YYYY-MM-DD-slug.md — error/incident, root cause, resolution, and prevention.
- decision-YYYY-MM-DD-slug.md — durable technical or process decision, alternatives, and consequences.
- research-YYYY-MM-DD-slug.md — a finding with source links and research date.
- lesson-YYYY-MM-DD-slug.md — an architecture or repository-structure lesson.
- session-YYYY-MM-DD.md — concise session digest linking to durable reports.

## Naming and indexing

Names are lowercase, date-prefixed, and stable. Add every report to index.md with type, status, and links. A report is eligible for VictusOS synchronization only when claims have command, test, file, or source evidence recorded.

## End-of-day distillation and VictusOS sync

1. During work, record candidate facts in the relevant report using templates/report.md.
2. Before handoff/end of day, verify each claim against files, command output, tests, or a dated source. Remove uncertain claims and secrets.
3. Update the project-canonical report first and add it to index.md.
4. Only after the project copy is durable, create or update a concise VictusOS vault note. Preserve the report ID and a backlink to the project report; add the vault note path back to the report index.
5. Keep vault notes distilled: context, durable insight, evidence/backlink, and related links. Never copy raw chat or credentials.
6. If the vault is unavailable or out of scope, leave vault_sync: pending in the index and backlog it; do not pretend synchronization happened.

## Evidence rules

- Incident: symptom, root cause, resolution, prevention, and evidence.
- Decision: context, decision, rejected alternatives, consequences, and evidence.
- Research: source URL/title, publisher or repository, research date, and learned finding.
- Lesson: invariant, why it matters, and links to affected architecture/code.
- Use not-run explicitly when verification was not performed.
