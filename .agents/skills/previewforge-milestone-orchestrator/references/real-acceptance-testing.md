# Real acceptance testing

Use this reference when building a milestone acceptance matrix or judging subagent tests.

## Evidence standard

A meaningful test observes the contract at the boundary where failure matters. Prefer durable state, emitted messages, HTTP responses, persisted redaction, external resource identity, or idempotent side effects over private method calls.

For every slice, identify:

| Field | Question |
|---|---|
| Risk | What user-visible, security, durability, or concurrency failure would invalidate the slice? |
| Stimulus | What realistic input, duplicate, race, crash point, stale token, or malformed boundary triggers it? |
| Oracle | What externally observable state proves correctness? |
| Fault sensitivity | What plausible broken implementation would this test catch? |
| Runtime | Which real dependency is required to make the claim? |

All five fields are mandatory for every implementation slice. Critical security, durability, concurrency, raw-boundary, and idempotency rows must include executed fault-sensitivity evidence, not only a claim that a broken implementation would fail.

## Required patterns by risk

- Boundary/authentication: use raw bytes and real cryptographic verification; include valid, invalid, missing, and malformed headers without logging secrets.
- Idempotency: deliver the same stable identity repeatedly and concurrently; assert durable row/event counts and identical observable results.
- Transactions: force a failure after the first intended write and prove no partial state remains.
- Desired-state races: change the authoritative desired SHA between stages and prove stale work cannot publish or mutate the next boundary.
- External API adapters: use contract fixtures or a controlled sandbox and assert pagination, permission failures, retries, and safe error mapping. Mocks may isolate transport but cannot be the only evidence for the adapter contract.
- Kubernetes/build behavior: use a real disposable cluster or runtime. Static manifest assertions alone do not verify admission, reconciliation, routing, or workload security.

## Rejection signals

Reject tests that only assert that a mock was called, reproduce the implementation algorithm inside the assertion, snapshot unstable internals, skip silently when a required service is absent, or pass while the behavior under test is deliberately disabled. Also reject commands that allow zero tests, skip the target file/case, or use broad filters without recording expected discovery and observed counts.

Tests may use mocks for rare failures or external cost control, but pair them with a real boundary/integration test whenever the milestone acceptance claim depends on that boundary.

## Repair packet

When returning a failed slice to its agent, include:

```yaml
slice: Mx-ID
failed_command: exact command
observed: concise failure and relevant output
expected: violated observable invariant
ownership: files the agent may change
must_preserve: adjacent passing behavior and security constraints
```

## Final proof packet

```yaml
slice: Mx-ID
tree: final commit or tree identifier
timestamp: ISO-8601
changed_files: exact owned and integration files
runtime_identity: redacted database/broker/context/namespace identity
commands: exact root-run commands
discovery: expected and observed test files/cases
adversarial_result: temporary mutation or injected-fault result and restoration proof
result: pass | blocked
```
