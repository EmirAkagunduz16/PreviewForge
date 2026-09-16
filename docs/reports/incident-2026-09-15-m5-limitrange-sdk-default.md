---
id: RPT-2026-09-15-m5-limitrange-sdk-default
type: incident
status: verified
date: 2026-09-15
vault_sync: synced
---

# M5 LimitRange default lost at the Kubernetes SDK boundary

## Context

The M5 reconciler rendered a container `LimitRange` with a default CPU limit
of `500m` and memory limit of `512Mi`. Real kind acceptance read back the live
resource instead of relying on the rendered object.

## Verified finding

The generated `@kubernetes/client-node` 2.0.0 model names the wire field
`default` as `_default`. Passing a plain `default` property through its object
patch serializer omitted that setting. Kubernetes filled the absent default
from the configured `max` values, so the live object reported `2` CPU and
`2Gi` memory. This is a runtime security/resource-policy drift, not an
assertion-only mismatch.

## Resolution

`createKubernetesResourceClient().apply` now prepares `LimitRange` items for
the generated SDK by mapping the rendered `default` to `_default` without
mutating the renderer's resource. Other resource kinds are unchanged.

## Evidence

- `apps/worker/src/kubernetes/resource-renderer.ts` renders `500m`/`512Mi`.
- Generated model `V1LimitRangeItem` maps `_default` to JSON `default`.
- In disposable kind Namespace `pf-m5-root-limits-smoke`, the old adapter's
  apply produced raw API `default=2/2Gi`; applying `_default` produced
  `500m/512Mi`.
- After the adapter repair, applying the ordinary rendered `default` again
  produced raw API `500m/512Mi`. The smoke Namespace was deleted and its
  deletion completed.
- Focused client serialization tests passed 2/2; the direct real M5
  acceptance target passed 1/1 and asserted the live `_default` value.

## Impact / prevention

Always compare security and resource-policy manifests with live Kubernetes
objects when a generated client serializes reserved or renamed fields.
Renderer-only unit tests would not have detected this drift.

## Related links

- [M5 execution plan](../plans/m5-kubernetes-preview-reconciliation.md)
- [M5 infrastructure notes](../infrastructure/m5-kubernetes.md)
- [client adapter](../../apps/worker/src/kubernetes/client.ts)
- [real acceptance test](../../apps/worker/src/m5.acceptance.test.ts)
