import { describe, expect, it } from "vitest";
import {
  KubernetesReconciler,
  PreviewOwnershipError,
  PreviewSupersededError,
} from "./reconciler.js";
import {
  isPreviewOwned,
  type KubernetesResource,
  previewNamespace,
  renderPreviewResources,
} from "./resource-renderer.js";

const input = {
  projectId: "11111111-1111-4111-8111-111111111111",
  environmentId: "22222222-2222-4222-8222-222222222222",
  deploymentId: "33333333-3333-4333-8333-333333333333",
  desiredCommitSha: "a".repeat(40),
  imageReference: "registry.local/project/deployment:commit",
  imageDigest: `sha256:${"b".repeat(64)}`,
  containerPort: 3000,
  healthPath: "/healthz",
};

describe("preview Kubernetes resources", () => {
  it("renders the approved resource set with restricted policy and digest identity", () => {
    const rendered = renderPreviewResources({ ...input, environment: { NODE_ENV: "test" } });
    const kinds = rendered.resources.map((resource) => resource.kind);
    expect(kinds).toEqual([
      "Namespace",
      "ResourceQuota",
      "LimitRange",
      "NetworkPolicy",
      "ServiceAccount",
      "Secret",
      "Deployment",
      "Service",
      "HTTPRoute",
    ]);
    expect(rendered.resources.some((resource) => resource.kind === "LoadBalancer")).toBe(false);
    expect(
      rendered.resources.every((resource) => isPreviewOwned(resource, input.environmentId)),
    ).toBe(true);

    const deployment = resource(rendered.resources, "Deployment");
    const deploymentSpec = deployment.spec as {
      template: {
        spec: {
          automountServiceAccountToken: boolean;
          containers: Array<{ image: string; securityContext: Record<string, unknown> }>;
        };
      };
    };
    expect(deploymentSpec.template.spec.automountServiceAccountToken).toBe(false);
    expect(deploymentSpec.template.spec.containers[0]?.image).toBe(
      `${input.imageReference}@${input.imageDigest}`,
    );
    expect(deploymentSpec.template.spec.containers[0]?.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
    });

    const service = resource(rendered.resources, "Service");
    expect((service.spec as { type: string }).type).toBe("ClusterIP");
    const route = resource(rendered.resources, "HTTPRoute");
    expect(
      (route.spec as { parentRefs: Array<Record<string, string>> }).parentRefs[0],
    ).toMatchObject({ name: "previewforge", namespace: "default" });
  });

  it("rejects non-Kubernetes env identifiers and values beyond the bounded secret contract", () => {
    expect(() => renderPreviewResources({ ...input, environment: { "bad-name": "x" } })).toThrow(
      "invalid secret key",
    );
    expect(() =>
      renderPreviewResources({ ...input, environment: { TOKEN: "x".repeat(16 * 1024 + 1) } }),
    ).toThrow("oversized secret value");
    expect(() =>
      renderPreviewResources({
        ...input,
        environment: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`KEY_${i}`, "x"])),
      }),
    ).toThrow("too many secret keys");
  });
});

describe("KubernetesReconciler", () => {
  it("rejects wrong-owner resources before applying them", async () => {
    const applied: KubernetesResource[] = [];
    const client = {
      async get(identity: { apiVersion: string; kind: string; name: string; namespace?: string }) {
        if (identity.kind !== "Namespace") return null;
        return {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: identity.name, labels: { "previewforge.dev/environment-id": "other" } },
        };
      },
      async apply(resource: KubernetesResource) {
        applied.push(resource);
      },
    };
    await expect(
      new KubernetesReconciler(client).reconcile({ ...input, isDesired: async () => true }),
    ).rejects.toBeInstanceOf(PreviewOwnershipError);
    expect(applied).toHaveLength(0);
  });

  it("checks desired SHA before each mutation and after the resource set", async () => {
    const applied: KubernetesResource[] = [];
    let checks = 0;
    const client = {
      async get() {
        return null;
      },
      async apply(resource: KubernetesResource) {
        applied.push(resource);
      },
    };
    await expect(
      new KubernetesReconciler(client).reconcile({
        ...input,
        isDesired: async () => {
          checks += 1;
          return checks < 3;
        },
      }),
    ).rejects.toBeInstanceOf(PreviewSupersededError);
    expect(applied).toHaveLength(1);
  });

  it("aborts a hanging apply at its deadline before mutating the next resource", async () => {
    const applied: KubernetesResource[] = [];
    const client = {
      async get() {
        return null;
      },
      async apply(resource: KubernetesResource, options?: { signal?: AbortSignal }) {
        applied.push(resource);
        await new Promise<never>((_, reject) => {
          const signal = options?.signal;
          if (signal === undefined) throw new Error("missing mutation abort signal");
          if (signal.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        });
      },
    };

    await expect(
      new KubernetesReconciler(client).reconcile({
        ...input,
        mutationTimeoutMs: 10,
        isDesired: async () => true,
      }),
    ).rejects.toMatchObject({ code: "KUBERNETES_API_TIMEOUT", retryable: true });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.kind).toBe("Namespace");
  });

  it("aborts a hanging ownership read before the first apply", async () => {
    let observedSignal: AbortSignal | undefined;
    let applied = 0;
    const client = {
      async get(
        _identity: { apiVersion: string; kind: string; name: string },
        options?: { signal?: AbortSignal },
      ) {
        observedSignal = options?.signal;
        return await new Promise<null>((_, reject) => {
          if (observedSignal === undefined) {
            reject(new Error("missing read abort signal"));
            return;
          }
          observedSignal.addEventListener(
            "abort",
            () => reject(observedSignal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
      async apply() {
        applied += 1;
      },
    };

    await expect(
      new KubernetesReconciler(client).reconcile({
        ...input,
        mutationTimeoutMs: 10,
        isDesired: async () => true,
      }),
    ).rejects.toMatchObject({ code: "KUBERNETES_API_TIMEOUT", retryable: true });
    expect(observedSignal?.aborted).toBe(true);
    expect(applied).toBe(0);
  });

  it("bounds a never-settling ownership read before the first apply", async () => {
    let applied = 0;
    const client = {
      async get() {
        return await new Promise<null>(() => {});
      },
      async apply() {
        applied += 1;
      },
    };

    await expect(
      new KubernetesReconciler(client).reconcile({
        ...input,
        mutationTimeoutMs: 10,
        isDesired: async () => true,
      }),
    ).rejects.toMatchObject({ code: "KUBERNETES_API_TIMEOUT", retryable: true });
    expect(applied).toBe(0);
  });

  it("prunes an owned environment Secret on an empty environment and treats 404 as idempotent", async () => {
    let secret: KubernetesResource | null = environmentSecret();
    const events: string[] = [];
    const deleted: Array<{
      apiVersion: string;
      kind: string;
      name: string;
      namespace?: string;
      uid?: string;
      resourceVersion?: string;
    }> = [];
    const client = {
      async get(identity: { kind: string }) {
        return identity.kind === "Secret" ? secret : null;
      },
      async apply(resource: KubernetesResource) {
        events.push(`apply:${resource.kind}`);
        return undefined;
      },
      async delete(identity: {
        apiVersion: string;
        kind: string;
        name: string;
        namespace?: string;
        uid?: string;
        resourceVersion?: string;
      }) {
        events.push("delete:Secret");
        deleted.push(identity);
        secret = null;
        throw { code: 404 };
      },
    };
    const reconciler = new KubernetesReconciler(client);

    await reconciler.reconcile({ ...input, isDesired: async () => true });
    await reconciler.reconcile({ ...input, isDesired: async () => true });

    expect(deleted).toEqual([
      {
        apiVersion: "v1",
        kind: "Secret",
        name: "preview-env",
        namespace: previewNamespace(input.environmentId),
        uid: "secret-uid-1",
        resourceVersion: "secret-rv-1",
      },
    ]);
    expect(events.indexOf("apply:Deployment")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("apply:Deployment")).toBeLessThan(events.indexOf("delete:Secret"));
    expect(secret).toBeNull();
  });

  it("refuses to prune an environment Secret owned by another environment", async () => {
    const deleted: unknown[] = [];
    const client = {
      async get(identity: { kind: string }) {
        if (identity.kind !== "Secret") return null;
        return environmentSecret({
          labels: { "previewforge.dev/environment-id": "other-environment" },
        });
      },
      async apply() {
        return undefined;
      },
      async delete(identity: { apiVersion: string; kind: string; name: string }) {
        deleted.push(identity);
      },
    };

    await expect(
      new KubernetesReconciler(client).reconcile({ ...input, isDesired: async () => true }),
    ).rejects.toBeInstanceOf(PreviewOwnershipError);
    expect(deleted).toHaveLength(0);
  });

  it("does not prune an environment Secret after desired SHA supersession", async () => {
    let checks = 0;
    let deleteAttempts = 0;
    let applied = 0;
    const resourceCount = renderPreviewResources(input).resources.length;
    const client = {
      async get(identity: { kind: string }) {
        return identity.kind === "Secret" ? environmentSecret() : null;
      },
      async apply() {
        applied += 1;
        return undefined;
      },
      async delete() {
        deleteAttempts += 1;
      },
    };

    await expect(
      new KubernetesReconciler(client).reconcile({
        ...input,
        isDesired: async () => {
          checks += 1;
          return checks <= resourceCount + 1;
        },
      }),
    ).rejects.toBeInstanceOf(PreviewSupersededError);
    expect(applied).toBe(resourceCount);
    expect(deleteAttempts).toBe(0);
  });

  it("does not prune a Secret after its ownership read times out", async () => {
    let observedSignal: AbortSignal | undefined;
    let applied = 0;
    let deleteAttempts = 0;
    const resourceCount = renderPreviewResources(input).resources.length;
    const client = {
      async get(identity: { kind: string }, options?: { signal?: AbortSignal }) {
        if (identity.kind !== "Secret") return null;
        observedSignal = options?.signal;
        return await new Promise<null>((_, reject) => {
          if (observedSignal === undefined) {
            reject(new Error("missing read abort signal"));
            return;
          }
          observedSignal.addEventListener(
            "abort",
            () => reject(observedSignal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
      async apply() {
        applied += 1;
      },
      async delete() {
        deleteAttempts += 1;
      },
    };

    await expect(
      new KubernetesReconciler(client).reconcile({
        ...input,
        mutationTimeoutMs: 10,
        isDesired: async () => true,
      }),
    ).rejects.toMatchObject({ code: "KUBERNETES_API_TIMEOUT", retryable: true });
    expect(observedSignal?.aborted).toBe(true);
    expect(applied).toBe(resourceCount);
    expect(deleteAttempts).toBe(0);
  });

  it("rejects an environment Secret replacement through UID and resourceVersion preconditions", async () => {
    let secret: SecretResource = environmentSecret();
    const client = {
      async get(identity: { kind: string }) {
        return identity.kind === "Secret" ? secret : null;
      },
      async apply() {
        return undefined;
      },
      async delete(identity: { uid?: string; resourceVersion?: string }) {
        secret = environmentSecret({
          uid: "secret-uid-replacement",
          resourceVersion: "secret-rv-replacement",
        });
        if (
          identity.uid !== secret.metadata.uid ||
          identity.resourceVersion !== secret.metadata.resourceVersion
        ) {
          throw new Error("Kubernetes delete precondition failed");
        }
      },
    };

    await expect(
      new KubernetesReconciler(client).reconcile({ ...input, isDesired: async () => true }),
    ).rejects.toThrow("Kubernetes delete precondition failed");
    expect(secret.metadata.uid).toBe("secret-uid-replacement");
  });

  it("deletes an owned namespace safely on repeated delivery", async () => {
    let namespace: NamespaceResource | null = {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: previewNamespace(input.environmentId),
        uid: "namespace-uid-1",
        resourceVersion: "namespace-rv-1",
        labels: {
          "app.kubernetes.io/managed-by": "previewforge",
          "previewforge.dev/managed": "true",
          "previewforge.dev/environment-id": input.environmentId,
        },
      },
    };
    const deleted: Array<{
      apiVersion: string;
      kind: string;
      name: string;
      uid?: string;
      resourceVersion?: string;
    }> = [];
    const client = {
      async get(identity: { apiVersion: string; kind: string; name: string }) {
        if (identity.kind !== "Namespace") return null;
        return namespace;
      },
      async apply() {
        return undefined;
      },
      async delete(identity: {
        apiVersion: string;
        kind: string;
        name: string;
        uid?: string;
        resourceVersion?: string;
      }) {
        deleted.push(identity);
        namespace = null;
      },
    };
    const reconciler = new KubernetesReconciler(client);

    await reconciler.deletePreviewNamespace(input.environmentId);
    await reconciler.deletePreviewNamespace(input.environmentId);

    expect(deleted).toEqual([
      {
        apiVersion: "v1",
        kind: "Namespace",
        name: previewNamespace(input.environmentId),
        uid: "namespace-uid-1",
        resourceVersion: "namespace-rv-1",
      },
    ]);
    expect(namespace).toBeNull();
  });

  it("refuses to delete a namespace owned by another environment", async () => {
    const deleted: Array<{ apiVersion: string; kind: string; name: string }> = [];
    const client = {
      async get(identity: { apiVersion: string; kind: string; name: string }) {
        return {
          apiVersion: identity.apiVersion,
          kind: identity.kind,
          metadata: {
            name: identity.name,
            labels: {
              "app.kubernetes.io/managed-by": "previewforge",
              "previewforge.dev/managed": "true",
              "previewforge.dev/environment-id": "other-environment",
            },
          },
        };
      },
      async apply() {
        return undefined;
      },
      async delete(resource: { apiVersion: string; kind: string; name: string }) {
        deleted.push(resource);
      },
    };

    await expect(
      new KubernetesReconciler(client).deletePreviewNamespace(input.environmentId),
    ).rejects.toBeInstanceOf(PreviewOwnershipError);
    expect(deleted).toHaveLength(0);
  });

  it("does not delete a namespace replaced after the ownership read", async () => {
    let namespace: NamespaceResource = {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: previewNamespace(input.environmentId),
        uid: "namespace-uid-1",
        resourceVersion: "namespace-rv-1",
        labels: {
          "app.kubernetes.io/managed-by": "previewforge",
          "previewforge.dev/managed": "true",
          "previewforge.dev/environment-id": input.environmentId,
        },
      },
    };
    let deleteAttempts = 0;
    const client = {
      async get() {
        return namespace;
      },
      async apply() {
        return undefined;
      },
      async delete(identity: {
        apiVersion: string;
        kind: string;
        name: string;
        uid?: string;
        resourceVersion?: string;
      }) {
        deleteAttempts += 1;
        namespace = {
          ...namespace,
          metadata: {
            ...namespace.metadata,
            uid: "namespace-uid-replacement",
            resourceVersion: "namespace-rv-replacement",
          },
        };
        if (
          identity.uid !== namespace.metadata.uid ||
          identity.resourceVersion !== namespace.metadata.resourceVersion
        ) {
          throw new Error("Kubernetes delete precondition failed");
        }
        throw new Error("unreachable");
      },
    };

    await expect(
      new KubernetesReconciler(client).deletePreviewNamespace(input.environmentId),
    ).rejects.toThrow("Kubernetes delete precondition failed");
    expect(deleteAttempts).toBe(1);
    expect(namespace.metadata.uid).toBe("namespace-uid-replacement");
  });

  it("does not delete a namespace after its ownership read times out", async () => {
    let observedSignal: AbortSignal | undefined;
    let deleteAttempts = 0;
    const client = {
      async get(
        _identity: { apiVersion: string; kind: string; name: string },
        options?: { signal?: AbortSignal },
      ) {
        observedSignal = options?.signal;
        return await new Promise<null>((_, reject) => {
          if (observedSignal === undefined) {
            reject(new Error("missing read abort signal"));
            return;
          }
          observedSignal.addEventListener(
            "abort",
            () => reject(observedSignal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
      async apply() {
        return undefined;
      },
      async delete() {
        deleteAttempts += 1;
      },
    };

    await expect(
      new KubernetesReconciler(client).deletePreviewNamespace(input.environmentId, 10),
    ).rejects.toMatchObject({ code: "KUBERNETES_API_TIMEOUT", retryable: true });
    expect(observedSignal?.aborted).toBe(true);
    expect(deleteAttempts).toBe(0);
  });
});

type NamespaceResource = KubernetesResource & {
  metadata: KubernetesResource["metadata"] & {
    uid: string;
    resourceVersion: string;
  };
};

type SecretResource = KubernetesResource & {
  metadata: KubernetesResource["metadata"] & {
    uid: string;
    resourceVersion: string;
  };
};

function resource(
  resources: readonly KubernetesResource[],
  kind: string,
): KubernetesResource & {
  spec: Record<string, unknown>;
} {
  const found = resources.find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`missing ${kind}`);
  return found as KubernetesResource & { spec: Record<string, unknown> };
}

function environmentSecret(metadataOverrides: Record<string, unknown> = {}): SecretResource {
  const { labels: overrideLabels, ...otherMetadata } = metadataOverrides;
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "preview-env",
      namespace: previewNamespace(input.environmentId),
      uid: "secret-uid-1",
      resourceVersion: "secret-rv-1",
      ...otherMetadata,
      labels: {
        "app.kubernetes.io/managed-by": "previewforge",
        "previewforge.dev/managed": "true",
        "previewforge.dev/environment-id": input.environmentId,
        ...((overrideLabels as Record<string, string> | undefined) ?? {}),
      },
    },
    type: "Opaque",
  };
}
