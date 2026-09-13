---
name: previewforge-control-plane
description: Implement or review PreviewForge GitHub webhooks, deployment lifecycle, Kafka events, outbox processing, retries, live logs, and control-plane APIs. Do not use for unrelated frontend-only styling or generic TypeScript work.
---

# PreviewForge control plane

Preserve the product boundaries in `docs/product/mvp-scope.md`. Read `docs/architecture/system-design.md` and `docs/architecture/deployment-state-machine.md` before changing workflow behavior.

## Required invariants

- PostgreSQL is authoritative; Kafka is at-least-once transport.
- Verify GitHub HMAC against raw bytes before parsing. Dedupe with `X-GitHub-Delivery` in durable storage.
- Write domain state and the outbox row atomically.
- Validate every external payload and versioned event at its boundary.
- Use an event ID for consumer dedupe and make side effects retry-safe.
- Before cloning, pushing, Kubernetes mutation, or READY publication, atomically confirm the deployment SHA is still the environment's desired SHA. Mark stale work `SUPERSEDED`.
- Change states only through the shared transition contract. A terminal attempt is never rewound; retry creates a new attempt.
- Store durable, redacted failure stage, code, message, and retryability. Never log tokens or environment-variable values.
- Stream browser updates with SSE and a resume cursor; keep bounded durable log chunks.

## Testing focus

Use realistic duplicates, reordered events, worker crashes between side effects and acknowledgements, newer commits arriving mid-build, and repeated cleanup. Assert domain state and externally observable idempotency rather than implementation call counts alone.

If a requested change conflicts with an accepted ADR, surface the conflict and update the ADR only when the user intends to change the architecture.
