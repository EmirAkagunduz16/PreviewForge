import { previewHostname } from "../preview-url.js";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f-]{36}$/iu;
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_ENVIRONMENT_VARIABLES = 32;
const MAX_ENVIRONMENT_VALUE_BYTES = 16 * 1024;
const MAX_ENVIRONMENT_PAYLOAD_BYTES = 512 * 1024;

export const PREVIEW_MANAGED_BY = "previewforge";
export const PREVIEW_GATEWAY_NAME = "previewforge";
export const PREVIEW_GATEWAY_NAMESPACE = "default";

export type KubernetesMetadata = {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};

export type KubernetesResource = {
  apiVersion: string;
  kind: string;
  metadata: KubernetesMetadata;
  [key: string]: unknown;
};

export type PreviewResourceInput = {
  projectId: string;
  environmentId: string;
  deploymentId: string;
  desiredCommitSha: string;
  imageReference: string;
  imageDigest: string;
  containerPort: number;
  healthPath: string;
  previewBaseDomain?: string;
  expiresAt?: Date | null;
  environment?: Record<string, string>;
};

export type PreviewResourceSet = {
  namespace: string;
  hostname: string;
  resources: readonly KubernetesResource[];
};

export function renderPreviewResources(input: PreviewResourceInput): PreviewResourceSet {
  validateInput(input);
  const namespace = previewNamespace(input.environmentId);
  const appLabels = {
    "app.kubernetes.io/name": "preview",
    "app.kubernetes.io/managed-by": PREVIEW_MANAGED_BY,
    "previewforge.dev/managed": "true",
    "previewforge.dev/project-id": input.projectId,
    "previewforge.dev/environment-id": input.environmentId,
    "previewforge.dev/deployment-id": input.deploymentId,
  };
  const labels = {
    ...appLabels,
    "previewforge.dev/commit-sha": input.desiredCommitSha,
  };
  const annotations = {
    "previewforge.dev/expires-at": input.expiresAt?.toISOString() ?? "",
  };
  const hostname = previewHostname(
    input.environmentId,
    input.previewBaseDomain ?? "previewforge.local",
  );
  const serviceName = "preview";

  const resources: KubernetesResource[] = [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        labels: {
          ...labels,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/audit": "restricted",
          "pod-security.kubernetes.io/warn": "restricted",
        },
        annotations,
      },
    },
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "preview-quota", namespace, labels, annotations },
      spec: {
        hard: {
          pods: "10",
          "requests.cpu": "2",
          "requests.memory": "2Gi",
          "limits.cpu": "4",
          "limits.memory": "4Gi",
          "requests.ephemeral-storage": "2Gi",
          "limits.ephemeral-storage": "4Gi",
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: { name: "preview-limits", namespace, labels, annotations },
      spec: {
        limits: [
          {
            type: "Container",
            default: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "1Gi" },
            defaultRequest: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "256Mi" },
            max: { cpu: "2", memory: "2Gi", "ephemeral-storage": "2Gi" },
          },
        ],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "preview-default-deny", namespace, labels, annotations },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "envoy-gateway-system" },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: input.containerPort }],
          },
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ],
      },
    },
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "preview", namespace, labels, annotations },
      automountServiceAccountToken: false,
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "preview", namespace, labels, annotations },
      spec: {
        replicas: 1,
        selector: { matchLabels: { "app.kubernetes.io/name": "preview" } },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            serviceAccountName: "preview",
            securityContext: {
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "preview",
                image: `${input.imageReference}@${input.imageDigest}`,
                imagePullPolicy: "IfNotPresent",
                ports: [{ name: "http", containerPort: input.containerPort, protocol: "TCP" }],
                envFrom:
                  input.environment && Object.keys(input.environment).length > 0
                    ? [{ secretRef: { name: "preview-env" } }]
                    : undefined,
                resources: {
                  requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "256Mi" },
                  limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "1Gi" },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                  readOnlyRootFilesystem: false,
                  runAsNonRoot: true,
                  runAsUser: 10001,
                },
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: serviceName, namespace, labels, annotations },
      spec: {
        type: "ClusterIP",
        selector: { "app.kubernetes.io/name": "preview" },
        ports: [{ name: "http", port: 80, targetPort: input.containerPort, protocol: "TCP" }],
      },
    },
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name: "preview", namespace, labels, annotations },
      spec: {
        parentRefs: [
          {
            name: PREVIEW_GATEWAY_NAME,
            namespace: PREVIEW_GATEWAY_NAMESPACE,
            sectionName: "http",
          },
        ],
        hostnames: [hostname],
        rules: [
          {
            matches: [{ path: { type: "PathPrefix", value: "/" } }],
            backendRefs: [{ name: serviceName, port: 80 }],
          },
        ],
      },
    },
  ];

  if (input.environment && Object.keys(input.environment).length > 0) {
    resources.splice(5, 0, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "preview-env", namespace, labels, annotations },
      type: "Opaque",
      stringData: input.environment,
    });
  }

  return { namespace, hostname, resources };
}

export function previewNamespace(environmentId: string): string {
  if (!UUID.test(environmentId)) throw new Error("environmentId must be a UUID");
  return `pf-${environmentId.toLowerCase()}`;
}

export function isPreviewOwned(resource: KubernetesResource, environmentId: string): boolean {
  return (
    resource.metadata.labels?.["app.kubernetes.io/managed-by"] === PREVIEW_MANAGED_BY &&
    resource.metadata.labels?.["previewforge.dev/managed"] === "true" &&
    resource.metadata.labels?.["previewforge.dev/environment-id"] === environmentId
  );
}

function validateInput(input: PreviewResourceInput): void {
  if (
    !UUID.test(input.projectId) ||
    !UUID.test(input.environmentId) ||
    !UUID.test(input.deploymentId)
  ) {
    throw new Error("preview resource identifiers must be UUIDs");
  }
  if (!/^[0-9a-f]{40}$/iu.test(input.desiredCommitSha)) {
    throw new Error("desiredCommitSha must be a Git commit SHA");
  }
  if (!SHA256_DIGEST.test(input.imageDigest)) throw new Error("imageDigest must be an OCI digest");
  if (!/^[A-Za-z0-9_.:/-]+$/u.test(input.imageReference)) {
    throw new Error("imageReference is invalid");
  }
  if (
    !Number.isInteger(input.containerPort) ||
    input.containerPort < 1 ||
    input.containerPort > 65535
  ) {
    throw new Error("containerPort must be a valid TCP port");
  }
  if (!input.healthPath.startsWith("/")) throw new Error("healthPath must be an absolute path");
  const environment = input.environment ?? {};
  if (Object.keys(environment).length > MAX_ENVIRONMENT_VARIABLES) {
    throw new Error("environment contains too many secret keys");
  }
  let payloadBytes = 0;
  for (const [key, value] of Object.entries(environment)) {
    if (!SECRET_KEY.test(key)) throw new Error("environment contains an invalid secret key");
    if (typeof value !== "string" || value.includes("\0"))
      throw new Error("environment contains an invalid secret value");
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_ENVIRONMENT_VALUE_BYTES)
      throw new Error("environment contains an oversized secret value");
    payloadBytes += bytes;
  }
  if (payloadBytes > MAX_ENVIRONMENT_PAYLOAD_BYTES)
    throw new Error("environment secret payload is too large");
}
