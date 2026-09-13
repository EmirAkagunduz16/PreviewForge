# ADR 0005: Server-Sent Events for live output

Status: Accepted

## Decision

Use Server-Sent Events for deployment status and log streaming to the dashboard. Store bounded log chunks and support cursor-based reconnection.

## Rationale

The MVP stream is one-way from server to browser. SSE provides the required behavior with ordinary HTTP semantics and less protocol state than WebSockets.

## Consequences

Bidirectional interactive terminals are out of scope. If they become a product requirement, replace or complement SSE through a new ADR.
