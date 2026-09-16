import {
  createConfiguration,
  KubernetesObjectApi,
  Observable,
  ServerConfiguration,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
  createRequestScopedApi,
  prepareForSdkSerialization,
  runKubernetesReadWithDeadline,
} from "./client.js";

describe("Kubernetes client serialization", () => {
  it("preserves LimitRange defaults through the generated SDK field name", () => {
    const resource = {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: { name: "preview-limits", namespace: "pf-test" },
      spec: {
        limits: [
          {
            type: "Container",
            default: { cpu: "500m", memory: "512Mi" },
            defaultRequest: { cpu: "100m", memory: "128Mi" },
            max: { cpu: "2", memory: "2Gi" },
          },
        ],
      },
    };

    const prepared = prepareForSdkSerialization(resource);
    expect((prepared.spec as typeof resource.spec).limits[0]).toMatchObject({
      _default: { cpu: "500m", memory: "512Mi" },
      defaultRequest: { cpu: "100m", memory: "128Mi" },
      max: { cpu: "2", memory: "2Gi" },
    });
    expect((prepared.spec as typeof resource.spec).limits[0]).not.toHaveProperty("default");
    expect(resource.spec.limits[0]?.default).toEqual({ cpu: "500m", memory: "512Mi" });
  });

  it("leaves non-LimitRange resources unchanged", () => {
    const resource = { apiVersion: "v1", kind: "Service", metadata: { name: "preview" } };
    expect(prepareForSdkSerialization(resource)).toBe(resource);
  });

  it("preserves NetworkPolicy ingress sources instead of allowing all sources", () => {
    const resource = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "preview-default-deny", namespace: "pf-test" },
      spec: {
        podSelector: {},
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "envoy-gateway-system" },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 8080 }],
          },
        ],
      },
    };

    const prepared = prepareForSdkSerialization(resource);
    expect((prepared.spec as typeof resource.spec).ingress[0]).toMatchObject({
      _from: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": "envoy-gateway-system" },
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    });
    expect((prepared.spec as typeof resource.spec).ingress[0]).not.toHaveProperty("from");
    expect(resource.spec.ingress[0]?.from).toHaveLength(1);
  });

  it("forwards a request-local abort signal through the generated SDK transport", async () => {
    const controller = new AbortController();
    const observedSignals: Array<AbortSignal | undefined> = [];
    const configuration = createConfiguration({
      baseServer: new ServerConfiguration("https://kubernetes.example", {}),
      httpApi: {
        send(request) {
          observedSignals.push(request.getSignal());
          return new Observable(Promise.reject(new Error("transport sentinel")));
        },
      },
    });
    const api = new KubernetesObjectApi(configuration);

    await expect(
      createRequestScopedApi(api, controller.signal).read({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: "preview" },
      }),
    ).rejects.toThrow("transport sentinel");
    expect(observedSignals).toEqual([controller.signal]);
  });

  it("aborts a hanging ownership read with a stable retryable timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    await expect(
      runKubernetesReadWithDeadline(10, (signal) => {
        observedSignal = signal;
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    ).rejects.toMatchObject({ code: "KUBERNETES_API_TIMEOUT", retryable: true });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("aborts the generated SDK transport when an ownership read never settles", async () => {
    let observedTransportSignal: AbortSignal | undefined;
    const configuration = createConfiguration({
      baseServer: new ServerConfiguration("https://kubernetes.example", {}),
      httpApi: {
        send(request) {
          observedTransportSignal = request.getSignal();
          return new Observable(new Promise<never>(() => {}));
        },
      },
    });
    const api = new KubernetesObjectApi(configuration);

    await expect(
      runKubernetesReadWithDeadline(10, (signal) =>
        createRequestScopedApi(api, signal).read({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: "preview" },
        }),
      ),
    ).rejects.toMatchObject({ code: "KUBERNETES_API_TIMEOUT", retryable: true });
    expect(observedTransportSignal?.aborted).toBe(true);
  });
});
