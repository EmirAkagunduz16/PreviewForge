# M5 local Kubernetes bootstrap

The local M5 topology is a disposable [kind](https://kind.sigs.k8s.io/) cluster with the
conformant [Envoy Gateway](https://gateway.envoyproxy.io/) controller. PreviewForge owns the
`default/previewforge` Gateway; preview workloads add namespaced `HTTPRoute` objects that attach to
that Gateway.

## Prerequisites

- Docker daemon reachable through the project Docker context
- `kubectl`
- `kind`

The bootstrap script fails closed when a prerequisite is missing. It does not change Docker
contexts or install host binaries. It uses the `default` Docker context unless
`PREVIEWFORGE_DOCKER_CONTEXT` is set explicitly.

## Create or reuse the cluster

```sh
PREVIEWFORGE_KIND_CLUSTER=previewforge ./scripts/kubernetes/bootstrap-kind.sh
```

The script creates the cluster from
[`infrastructure/kubernetes/kind-config.yaml`](../../infrastructure/kubernetes/kind-config.yaml),
installs Envoy Gateway `v1.9.1` from its published installation manifest, waits for the controller,
and applies the platform Gateway from
[`infrastructure/kubernetes/platform-gateway.yaml`](../../infrastructure/kubernetes/platform-gateway.yaml).
It is safe to run again for an existing cluster.

The cluster is disposable. Remove it explicitly after acceptance with:

```sh
kind delete cluster --name previewforge
```

Do not treat this local topology as production cluster provisioning or hostile-tenant isolation.

## Pulling from the local PreviewForge registry

The local registry is the Compose container `previewforge-registry-1` on the
`previewforge_default` Docker network and is published to the host as HTTP
`localhost:55000`. The disposable kind config enables the registry hosts
directory (`/etc/containerd/certs.d`) through kind's legacy CRI plugin path;
the current kind node image generates a version-2 containerd config even when
the containerd runtime is 2.x. This follows the [kind local
registry guidance](https://kind.sigs.k8s.io/docs/user/local-registry/) and
[containerd hosts configuration](https://github.com/containerd/containerd/blob/main/docs/hosts.md).
After recreating the kind cluster, connect that exact registry container to the
kind network and install the per-host containerd mapping:

```sh
kind delete cluster --name previewforge
PREVIEWFORGE_KIND_CLUSTER=previewforge ./scripts/kubernetes/bootstrap-kind.sh
PREVIEWFORGE_KIND_CLUSTER=previewforge ./scripts/kubernetes/connect-local-registry.sh
```

`connect-local-registry.sh` fails closed unless the named kind cluster, running
`previewforge-registry-1` container, `previewforge_default` network, and `kind`
network all exist. It is idempotent: an existing network attachment and matching
`hosts.toml` are reused. The script is for the disposable local cluster only;
it does not create a registry, alter production registry configuration, or
change image references. Preview Deployments may continue to use immutable
images such as `localhost:55000/project/image@sha256:...`.

After pushing the fixture digest to the host registry, root-owned acceptance
must confirm that a restricted Pod reaches `Running`/`Ready` and that its image
was pulled by digest. A failed pull showing `127.0.0.1` or `localhost:55000`
inside a kind node means this adapter was not applied to the recreated cluster.

## Route access through the Envoy data plane

In kind, Envoy creates a data-plane `LoadBalancer` Service without an external address. Select it
by the Gateway ownership labels and forward its HTTP listener to loopback with:

```sh
PREVIEWFORGE_GATEWAY_LOCAL_PORT=18080 \
  ./scripts/kubernetes/gateway-port-forward.sh
```

The helper waits for exactly one Service owned by `default/previewforge`, then runs a local-only
`kubectl port-forward`. It does not change the cluster and stays attached until interrupted. Set
`KUBE_CONTEXT` when the active context is not the kind cluster, or override
`PREVIEWFORGE_GATEWAY_NAME`, `PREVIEWFORGE_GATEWAY_NAMESPACE`, and
`PREVIEWFORGE_ENVOY_NAMESPACE` for another platform Gateway.

To prove HTTPRoute hostname routing, use the hostname rendered by the reconciler (for environment
ID `ENVIRONMENT_ID`, it is `preview-ENVIRONMENT_ID.preview.localhost`) in the request's `Host`
header. The clickable browser URL adds `:18080`; the HTTPRoute identity stays portless. In a
second terminal, replace `ENVIRONMENT_ID` and the health path with the fixture values:

```sh
curl --fail --silent --show-error \
  --header 'Host: preview-ENVIRONMENT_ID.preview.localhost' \
  http://127.0.0.1:18080/health
```

Before treating a response as routing evidence, verify the route accepted and resolved its Gateway
reference, for example:

```sh
kubectl -n PREVIEW_NAMESPACE get httproute PREVIEW_ROUTE \
  -o jsonpath='{.status.parents[0].conditions}'
```

The expected result is an HTTP response from the fixture through the Gateway listener, with the
hostname-specific route status accepted/resolved. A request without the matching `Host` header is
an intentional negative check and must not be used as proof of preview routing.

## Direct M5 acceptance target

Run `pnpm test:acceptance:m5` only against a migrated, disposable PostgreSQL
database and the disposable kind cluster. Keep the Envoy port-forward above
running in another terminal. The target fails closed unless all four inputs
are supplied:

- `DATABASE_URL`: connection string for the dedicated test database, never a
  shared application database.
- `M5_IMAGE_REFERENCE`: non-root HTTP fixture already published to the local
  registry, for example `localhost:55000/m5-fixture/nginx-unprivileged:acceptance`.
- `M5_IMAGE_DIGEST`: the matching immutable OCI `sha256:` digest from the
  registry manifest, not the mutable tag.
- `M5_GATEWAY_URL`: loopback data-plane listener, for example
  `http://127.0.0.1:18080`.

The test exercises actual PostgreSQL transitions, Kubernetes resource apply,
Gateway hostname routing, retry/failure/supersession, and guarded cleanup. It
creates disposable database and namespace fixtures and checks for residue.
This M5 target consumes a published digest; it is not proof that the fixture
was built by local rootless BuildKit. The M4 hosted rootless-build acceptance
is recorded separately.

The local worker uses the active kubeconfig identity, which may be an
administrative kind context. A successful local acceptance does not prove a
least-privilege production worker identity. Do not reuse the admin context in
production; verify the actual reconciler identity and RBAC before deployment.
