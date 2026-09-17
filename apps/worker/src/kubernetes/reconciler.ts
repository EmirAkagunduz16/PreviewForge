import {
  DEFAULT_KUBERNETES_MUTATION_TIMEOUT_MS,
  DEFAULT_KUBERNETES_READ_TIMEOUT_MS,
  KubernetesMutationTimeoutError,
  runKubernetesReadWithDeadline,
} from "./client.js";
import {
  isPreviewOwned,
  type KubernetesResource,
  type PreviewResourceInput,
  type PreviewResourceSet,
  previewNamespace,
  renderPreviewResources,
} from "./resource-renderer.js";

export type KubernetesResourceIdentity = {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
};

export type KubernetesNamespaceListOptions = {
  labelSelector?: string;
  limit?: number;
  continueToken?: string;
};

export type KubernetesNamespaceList = {
  items: KubernetesResource[];
  continueToken?: string;
};

export type KubernetesResourceClient = {
  get(
    identity: KubernetesResourceIdentity,
    options?: { signal?: AbortSignal },
  ): Promise<KubernetesResource | null>;
  listNamespaces(
    input?: KubernetesNamespaceListOptions,
    options?: { signal?: AbortSignal },
  ): Promise<KubernetesNamespaceList>;
  apply(resource: KubernetesResource, options?: { signal?: AbortSignal }): Promise<void>;
  delete?(identity: KubernetesResourceIdentity, options?: { signal?: AbortSignal }): Promise<void>;
};

export type KubernetesReconcilerClient = Pick<KubernetesResourceClient, "get" | "apply" | "delete">;

export type PreviewReconcileInput = PreviewResourceInput & {
  isDesired: () => Promise<boolean>;
  mutationTimeoutMs?: number;
};

export class PreviewSupersededError extends Error {
  readonly code = "PREVIEW_SUPERSEDED";

  constructor() {
    super("preview deployment is no longer the desired deployment");
    this.name = "PreviewSupersededError";
  }
}

export class PreviewOwnershipError extends Error {
  readonly code = "PREVIEW_OWNERSHIP_CONFLICT";

  constructor(resource: KubernetesResource) {
    super(`refusing to mutate non-owned ${resource.kind}/${resource.metadata.name}`);
    this.name = "PreviewOwnershipError";
  }
}

export class KubernetesReconciler {
  constructor(private readonly client: KubernetesReconcilerClient) {}

  async reconcile(input: PreviewReconcileInput): Promise<PreviewResourceSet> {
    const rendered = renderPreviewResources(input);
    await assertDesired(input);

    for (const resource of rendered.resources) {
      const existing = await runKubernetesReadWithDeadline(
        input.mutationTimeoutMs ?? DEFAULT_KUBERNETES_READ_TIMEOUT_MS,
        (signal) =>
          this.client.get(
            {
              apiVersion: resource.apiVersion,
              kind: resource.kind,
              name: resource.metadata.name,
              ...(resource.metadata.namespace === undefined
                ? {}
                : { namespace: resource.metadata.namespace }),
            },
            { signal },
          ),
      );
      if (existing !== null && !isPreviewOwned(existing, input.environmentId)) {
        throw new PreviewOwnershipError(resource);
      }
      await assertDesired(input);
      await runMutationWithDeadline(
        "apply",
        input.mutationTimeoutMs ?? DEFAULT_KUBERNETES_MUTATION_TIMEOUT_MS,
        (signal) => this.client.apply(resource, { signal }),
      );
    }

    if (input.environment === undefined || Object.keys(input.environment).length === 0) {
      await this.pruneEnvironmentSecret(input);
    }
    await assertDesired(input);
    return rendered;
  }

  private async pruneEnvironmentSecret(input: PreviewReconcileInput): Promise<void> {
    const identity: KubernetesResourceIdentity = {
      apiVersion: "v1",
      kind: "Secret",
      name: "preview-env",
      namespace: previewNamespace(input.environmentId),
    };
    const existing = await runKubernetesReadWithDeadline(
      input.mutationTimeoutMs ?? DEFAULT_KUBERNETES_READ_TIMEOUT_MS,
      (signal) => this.client.get(identity, { signal }),
    );
    if (existing === null) return;

    if (
      existing.apiVersion !== identity.apiVersion ||
      existing.kind !== identity.kind ||
      existing.metadata.name !== identity.name ||
      existing.metadata.namespace !== identity.namespace ||
      !isPreviewOwned(existing, input.environmentId)
    ) {
      throw new PreviewOwnershipError(existing);
    }
    const metadata = existing.metadata as KubernetesResource["metadata"] & {
      uid?: string;
      resourceVersion?: string;
    };
    if (metadata.uid === undefined || metadata.resourceVersion === undefined) {
      throw new PreviewOwnershipError(existing);
    }
    await assertDesired(input);
    const deleteResource = this.client.delete;
    if (deleteResource === undefined) {
      throw new Error("Kubernetes resource client does not support deletion");
    }
    const deleteIdentity: KubernetesResourceIdentity = {
      ...identity,
      uid: metadata.uid,
      resourceVersion: metadata.resourceVersion,
    };
    try {
      await runMutationWithDeadline(
        "delete",
        input.mutationTimeoutMs ?? DEFAULT_KUBERNETES_MUTATION_TIMEOUT_MS,
        (signal) => deleteResource(deleteIdentity, { signal }),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async deletePreviewNamespace(
    environmentId: string,
    timeoutMs = DEFAULT_KUBERNETES_READ_TIMEOUT_MS,
  ): Promise<void> {
    const identity: KubernetesResourceIdentity = {
      apiVersion: "v1",
      kind: "Namespace",
      name: previewNamespace(environmentId),
    };
    const existing = await runKubernetesReadWithDeadline(timeoutMs, (signal) =>
      this.client.get(identity, { signal }),
    );
    if (existing === null) return;

    if (
      existing.apiVersion !== identity.apiVersion ||
      existing.kind !== identity.kind ||
      existing.metadata.name !== identity.name ||
      !isPreviewOwned(existing, environmentId)
    ) {
      throw new PreviewOwnershipError(existing);
    }
    const metadata = existing.metadata as KubernetesResource["metadata"] & {
      uid?: string;
      resourceVersion?: string;
    };
    if (metadata.uid === undefined || metadata.resourceVersion === undefined) {
      throw new PreviewOwnershipError(existing);
    }
    const deleteResource = this.client.delete;
    if (deleteResource === undefined) {
      throw new Error("Kubernetes resource client does not support deletion");
    }
    const deleteIdentity: KubernetesResourceIdentity = {
      ...identity,
      uid: metadata.uid,
      resourceVersion: metadata.resourceVersion,
    };
    await runMutationWithDeadline("delete", DEFAULT_KUBERNETES_MUTATION_TIMEOUT_MS, (signal) =>
      deleteResource(deleteIdentity, { signal }),
    );
  }
}

async function assertDesired(input: PreviewReconcileInput): Promise<void> {
  if (!(await input.isDesired())) throw new PreviewSupersededError();
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === 404) return true;
  const response = "response" in error ? error.response : undefined;
  if (!response || typeof response !== "object") return false;
  return "statusCode" in response && response.statusCode === 404;
}

async function runMutationWithDeadline<T>(
  operation: "apply" | "delete",
  timeoutMs: number,
  mutation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await mutation(controller.signal);
  } catch (error) {
    if (timedOut) throw new KubernetesMutationTimeoutError(operation);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
