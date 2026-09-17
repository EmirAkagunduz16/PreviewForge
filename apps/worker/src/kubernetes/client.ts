import {
  type Configuration,
  KubeConfig,
  type KubernetesObject,
  KubernetesObjectApi,
  Observable,
  PatchStrategy,
  type RequestContext,
  type ResponseContext,
} from "@kubernetes/client-node";
import type {
  KubernetesNamespaceListOptions,
  KubernetesResourceClient,
  KubernetesResourceIdentity,
} from "./reconciler.js";
import type { KubernetesResource } from "./resource-renderer.js";

const FIELD_MANAGER = "previewforge-reconciler";
export const DEFAULT_KUBERNETES_MUTATION_TIMEOUT_MS = 30_000;
export const DEFAULT_KUBERNETES_READ_TIMEOUT_MS = 30_000;

export class KubernetesMutationTimeoutError extends Error {
  readonly code = "KUBERNETES_API_TIMEOUT";
  readonly retryable = true;

  constructor(operation: "apply" | "delete") {
    super(`Kubernetes ${operation} request timed out`);
    this.name = "KubernetesMutationTimeoutError";
  }
}

export class KubernetesReadTimeoutError extends Error {
  readonly code = "KUBERNETES_API_TIMEOUT";
  readonly retryable = true;

  constructor() {
    super("Kubernetes read request timed out");
    this.name = "KubernetesReadTimeoutError";
  }
}

type MutationOptions = { signal?: AbortSignal };

export function createKubernetesResourceClient(): KubernetesResourceClient {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  const api = KubernetesObjectApi.makeApiClient(kubeConfig);

  return {
    async get(
      identity: KubernetesResourceIdentity,
      options?: MutationOptions,
    ): Promise<KubernetesResource | null> {
      try {
        return await runKubernetesReadWithDeadline(
          DEFAULT_KUBERNETES_READ_TIMEOUT_MS,
          (signal) =>
            createRequestScopedApi(api, signal)
              .read(toHeader(identity) as unknown as Parameters<typeof api.read>[0])
              .then((resource) => resource as unknown as KubernetesResource),
          options?.signal,
        );
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async listNamespaces(
      options?: KubernetesNamespaceListOptions,
      mutationOptions?: MutationOptions,
    ) {
      return runKubernetesReadWithDeadline(
        DEFAULT_KUBERNETES_READ_TIMEOUT_MS,
        (signal) =>
          createRequestScopedApi(api, signal)
            .list<KubernetesResource>(
              "v1",
              "Namespace",
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              options?.labelSelector,
              options?.limit,
              options?.continueToken,
            )
            .then((list) => ({
              items: list.items,
              ...(list.metadata?._continue === undefined
                ? {}
                : { continueToken: list.metadata._continue }),
            })),
        mutationOptions?.signal,
      );
    },
    async apply(resource: KubernetesResource, options?: MutationOptions): Promise<void> {
      await runMutationWithDeadline("apply", options?.signal, (signal) => {
        return createRequestScopedApi(api, signal).patch(
          prepareForSdkSerialization(resource) as unknown as KubernetesObject,
          undefined,
          undefined,
          FIELD_MANAGER,
          false,
          PatchStrategy.ServerSideApply,
        );
      });
    },
    async delete(identity: KubernetesResourceIdentity, options?: MutationOptions): Promise<void> {
      try {
        await runMutationWithDeadline("delete", options?.signal, (signal) => {
          return createRequestScopedApi(api, signal).delete(
            toHeader(identity),
            undefined,
            undefined,
            undefined,
            undefined,
            "Background",
            identity.uid === undefined && identity.resourceVersion === undefined
              ? undefined
              : {
                  preconditions: {
                    ...(identity.uid === undefined ? {} : { uid: identity.uid }),
                    ...(identity.resourceVersion === undefined
                      ? {}
                      : { resourceVersion: identity.resourceVersion }),
                  },
                },
          );
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

/**
 * The object API's per-call Configuration is not used for its middleware and
 * HTTP transport in client-node 2.0.0. Clone the configuration and attach a
 * request-local middleware so concurrent mutations never share an AbortSignal.
 */
export function createRequestScopedApi(
  api: KubernetesObjectApi,
  signal: AbortSignal,
): KubernetesObjectApi {
  const configuration = (api as unknown as { configuration: Configuration }).configuration;
  const signalMiddleware = {
    pre: (request: RequestContext) => {
      request.setSignal(signal);
      return new Observable(Promise.resolve(request));
    },
    post: (response: ResponseContext) => new Observable(Promise.resolve(response)),
  };
  return new KubernetesObjectApi({
    ...configuration,
    middleware: [...configuration.middleware, signalMiddleware],
  });
}

/** The generated client renames reserved Kubernetes wire fields. */
export function prepareForSdkSerialization(resource: KubernetesResource): KubernetesResource {
  if (resource.kind === "NetworkPolicy") {
    const spec = resource.spec as { ingress?: Array<Record<string, unknown>> } | undefined;
    if (spec?.ingress === undefined) return resource;
    return {
      ...resource,
      spec: {
        ...spec,
        ingress: spec.ingress.map((rule) => {
          if (rule.from === undefined) return rule;
          const { from: sources, ...rest } = rule;
          return { ...rest, _from: sources };
        }),
      },
    };
  }
  if (resource.kind !== "LimitRange") return resource;
  const spec = resource.spec as { limits?: Array<Record<string, unknown>> } | undefined;
  if (spec?.limits === undefined) return resource;
  return {
    ...resource,
    spec: {
      ...spec,
      limits: spec.limits.map((item) => {
        if (item.default === undefined) return item;
        const { default: defaultLimit, ...rest } = item;
        return { ...rest, _default: defaultLimit };
      }),
    },
  };
}

function toHeader(identity: KubernetesResourceIdentity): KubernetesObject {
  return {
    apiVersion: identity.apiVersion,
    kind: identity.kind,
    metadata: {
      name: identity.name,
      ...(identity.namespace === undefined ? {} : { namespace: identity.namespace }),
    },
  };
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === 404) return true;
  const response = "response" in error ? error.response : undefined;
  if (!response || typeof response !== "object") return false;
  const statusCode = "statusCode" in response ? response.statusCode : undefined;
  return statusCode === 404;
}

async function runMutationWithDeadline<T>(
  operation: "apply" | "delete",
  externalSignal: AbortSignal | undefined,
  mutation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadlineController = new AbortController();
  const deadline = setTimeout(
    () => deadlineController.abort(),
    DEFAULT_KUBERNETES_MUTATION_TIMEOUT_MS,
  );
  let externalAbortListener: (() => void) | undefined;
  if (externalSignal !== undefined) {
    externalAbortListener = () => deadlineController.abort(externalSignal.reason);
    if (externalSignal.aborted) externalAbortListener();
    else externalSignal.addEventListener("abort", externalAbortListener, { once: true });
  }

  try {
    return await mutation(deadlineController.signal);
  } catch (error) {
    if (deadlineController.signal.aborted && !externalSignal?.aborted) {
      throw new KubernetesMutationTimeoutError(operation);
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    if (externalAbortListener !== undefined && externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", externalAbortListener);
    }
  }
}

export async function runKubernetesReadWithDeadline<T>(
  timeoutMs: number,
  read: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const deadlineController = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadlineReached = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      deadlineController.abort();
      reject(new KubernetesReadTimeoutError());
    }, timeoutMs);
  });
  let externalAbortListener: (() => void) | undefined;
  let externalAbort: Promise<never> | undefined;
  if (externalSignal !== undefined) {
    externalAbort = new Promise<never>((_, reject) => {
      externalAbortListener = () => {
        deadlineController.abort(externalSignal.reason);
        reject(externalSignal.reason ?? new Error("Kubernetes read request aborted"));
      };
    });
    if (externalSignal.aborted) externalAbortListener?.();
    else if (externalAbortListener !== undefined) {
      externalSignal.addEventListener("abort", externalAbortListener, { once: true });
    }
  }

  try {
    if (externalSignal?.aborted) {
      throw externalSignal.reason ?? new Error("Kubernetes read request aborted");
    }
    const readPromise = read(deadlineController.signal);
    return await Promise.race(
      externalAbort === undefined
        ? [readPromise, deadlineReached]
        : [readPromise, deadlineReached, externalAbort],
    );
  } catch (error) {
    if (timedOut) throw new KubernetesReadTimeoutError();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (externalAbortListener !== undefined && externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", externalAbortListener);
    }
  }
}
