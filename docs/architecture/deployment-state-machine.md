# Deployment state machine

The executable transition map lives in `packages/contracts/src/deployment.ts`. This document explains its meaning.

```text
QUEUED -> CLONING -> BUILDING -> PUSHING -> DEPLOYING
                                              |
                                              v
                              WAITING_FOR_HEALTHCHECK -> READY

Any active state -> FAILED | SUPERSEDED | CANCELLED
READY -> SUPERSEDED
```

## Rules

- State changes are compare-and-set updates using the expected previous state.
- Every state change records its timestamp and emits an outbox event in the same database transaction.
- `FAILED` requires a stage, stable error code, redacted explanation, and `retryable` flag.
- A retry creates a new deployment attempt. It does not rewind a terminal deployment.
- `SUPERSEDED` means a newer desired commit exists; it is not a failure.
- Environment deletion is modeled separately because it can continue after a deployment reaches READY or FAILED.

## Retry classes

Retry with capped exponential backoff and jitter for transient registry, GitHub, Kafka, Kubernetes API, and network failures. Do not automatically retry Dockerfile syntax errors, compilation failures, invalid configuration, rejected security policy, or a deterministic failed health response.

Timeouts are required for source acquisition, image build, rollout, and health checking. The timeout error remains stage-specific.
