---
id: RPT-2026-09-16-m6-sse-api
type: session
status: verified
date: 2026-09-16
vault_sync: synced
---

# M6 SSE API completion evidence

## State

`M6-SSE-API` is complete on 2026-09-16. Its implementation commit is
`ef365b0113545a61cd87ebc66705590e54a5373b`. This closes only the authenticated live
output API slice: M6 remains active, with M6-DASHBOARD and integrated acceptance next.
The separate M5 health acceptance drift was later verified resolved.

The API serves `GET /api/deployments/:deploymentId/events` as native HTTP SSE. Each
connection authenticates and owner-scopes the deployment before SSE headers are sent,
preflights numeric `Last-Event-ID`, emits a safe status snapshot, replays ordered durable
chunks, rereads PostgreSQL status/logs, signals retention loss with `gap`, sends comment
heartbeats, and releases timers/listeners on disconnect. Log event IDs remain durable
deployment-local sequence numbers.

## Verification evidence

- Fresh disposable database `previewforge_m6_sse_20260916`: all eight migrations applied;
  real HTTP acceptance `vitest run src/live-output.integration.test.ts --no-file-parallelism`
  passed **1/1**.
- Acceptance proved unauthenticated 401; foreign/absent indistinguishable 404; status
  snapshot; replay after cursor 1; new sequence 3 and `BUILDING -> PUSHING` transition;
  reconnect from cursor 2; explicit gap at sequence 2; heartbeat; and client cancellation.
  Cleanup counts were users/projects/deployments/log chunks/outbox **0/0/0/0/0** and the
  dedicated database was dropped.
- Final `pnpm check` passed: Biome **173 files**; docs **182 links across 56 files**;
  Turbo **18/18**; API unit **59/59**; database integration **87/87**; API integration
  **4/4**; worker unit **170/170**; worker Kafka/PostgreSQL integration **5/5**.
- Fault sensitivity: temporarily removing `Last-Event-ID` forwarding made the real
  HTTP/PostgreSQL test receive sequence 1 instead of expected 2 and fail; restoring the
  forwarding returned it to green. The faulted run left no fixture rows.
- Root independently reviewed implementation, module wiring, and HTTP/PostgreSQL
  acceptance; no schema change was needed because existing owner-scoped status and
  durable-log read repositories covered the contract.

## Next action

Proceed sequentially to M6-DASHBOARD and integrated acceptance. The full M5 health
acceptance drift was later resolved and verified; it does not invalidate this isolated
evidence.

## Related links

- [M6 plan](../plans/m6-dashboard-live-logs.md#M6-SSE-API)
- [Active backlog](../backlog/active.md)
- [Completed backlog](../backlog/archive.md)
- [SSE ADR](../architecture/decisions/0005-sse-for-live-output.md)
- [HTTP/PostgreSQL acceptance test](../../apps/api/src/live-output.integration.test.ts)
