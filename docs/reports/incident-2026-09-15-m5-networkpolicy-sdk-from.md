---
id: RPT-2026-09-15-m5-networkpolicy-sdk-from
type: incident
status: verified
date: 2026-09-15
vault_sync: synced
---

# M5 NetworkPolicy ingress source lost at the Kubernetes SDK boundary

## Context

The renderer's preview NetworkPolicy intended to allow HTTP ingress on the
application port only from `envoy-gateway-system`, with egress restricted to
`kube-system` DNS. A strengthened real kind acceptance oracle checked the
live Kubernetes object, not just the rendered manifest.

## Verified finding

The generated `@kubernetes/client-node` 2.0.0
`V1NetworkPolicyIngressRule` maps JSON `from` to its TypeScript `_from`
property. The object patch serializer discarded the plain rendered `from`.
The live ingress rule retained TCP port 8080 but omitted its source selector;
according to the Kubernetes NetworkPolicy rule semantics, an omitted `from`
matches all sources. This was a security policy drift even though the
renderer unit tests and the earlier reachable-preview acceptance passed.

## Resolution

The Kubernetes adapter maps NetworkPolicy ingress rule `from` to `_from`
only at the SDK serialization boundary, without mutating the renderer
resource. Egress `to` was already serialized correctly. Live acceptance now
asserts exact ingress and egress selectors/ports, so this regression would
fail before M5 sign-off.

## Evidence

- `apps/worker/src/kubernetes/resource-renderer.ts` rendered Gateway-only
  ingress and kube-system DNS-only egress.
- The generated `V1NetworkPolicyIngressRule` model declares `_from` as the
  property mapped to wire `from`.
- Disposable kind Namespace `pf-m5-root-policy-smoke`: the old adapter's
  normal `from` apply produced raw API ingress with only TCP 8080 and no
  `from`; a direct `_from` apply produced the intended
  `envoy-gateway-system` selector.
- After the adapter repair, applying the ordinary renderer-style `from`
  again produced raw API selectors
  `envoy-gateway-system/kube-system`. The smoke Namespace was deleted and
  deletion completed.
- Focused client serialization tests passed 3/3. Direct real M5 acceptance
  passed 3/3 in 75.89 seconds with an exact live NetworkPolicy oracle.

## Impact / prevention

Generated SDK renaming of reserved fields must be verified with raw/live
cluster reads for security-sensitive resources. Presence of a NetworkPolicy
object, or non-empty ingress arrays, does not prove source restriction.
Actual CNI enforcement of the policy was not exercised in this disposable
kind acceptance and remains a separate production-environment check.

## Related links

- [M5 execution plan](../plans/m5-kubernetes-preview-reconciliation.md)
- [M5 acceptance report](session-2026-09-15-m5-kind-acceptance.md)
- [client adapter](../../apps/worker/src/kubernetes/client.ts)
- [real acceptance test](../../apps/worker/src/m5.acceptance.test.ts)
