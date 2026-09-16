import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import type { DeploymentRequested } from "@previewforge/contracts";
import {
  createPrismaClient,
  DeploymentRepository,
  type PrismaClient,
} from "@previewforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKubernetesResourceClient } from "./kubernetes/client.js";
import {
  createKubernetesReconciler,
  reconcilePreviewDeployment,
} from "./kubernetes/deployment-reconciler.js";
import { persistKubernetesFailure } from "./kubernetes/failure-persistence.js";
import { PreviewOwnershipError } from "./kubernetes/reconciler.js";
import {
  isPreviewOwned,
  type KubernetesResource,
  previewNamespace,
  renderPreviewResources,
} from "./kubernetes/resource-renderer.js";
import type { HealthCheckResult } from "./kubernetes/rollout.js";

const databaseUrl = process.env.DATABASE_URL;
const imageReference = process.env.M5_IMAGE_REFERENCE;
const imageDigest = process.env.M5_IMAGE_DIGEST;
const gatewayUrl = process.env.M5_GATEWAY_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required for M5 acceptance");
if (!imageReference) throw new Error("M5_IMAGE_REFERENCE is required for M5 acceptance");
if (!imageDigest) throw new Error("M5_IMAGE_DIGEST is required for M5 acceptance");
if (!gatewayUrl) throw new Error("M5_GATEWAY_URL is required for M5 acceptance");
if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest)) {
  throw new Error("M5_IMAGE_DIGEST must be an OCI sha256 digest");
}

const configuredDatabaseUrl = databaseUrl;
const configuredImageReference = imageReference;
const configuredImageDigest = imageDigest;
const configuredGatewayUrl = gatewayUrl.replace(/\/$/u, "");
const kube = createKubernetesResourceClient();
const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();
const coreApi = kubeConfig.makeApiClient(CoreV1Api);
const kubernetes = createKubernetesReconciler(kube);
const fixtures: Fixture[] = [];
const gatewayObservations: string[] = [];
let prisma: PrismaClient;

type Fixture = {
  userId: string;
  environmentId: string;
  deploymentId: string;
  commitSha: string;
  projectId: string;
};

type DeploymentStatus = "QUEUED" | "CLONING" | "BUILDING" | "PUSHING" | "DEPLOYING";

describe("M5 real Kubernetes preview acceptance", () => {
  beforeAll(async () => {
    prisma = createPrismaClient(configuredDatabaseUrl);
    await prisma.$connect();
  });

  afterAll(async () => {
    let firstCleanupError: unknown;
    await Promise.all(
      fixtures.map(async (fixture) => {
        try {
          const namespaceIdentity = {
            apiVersion: "v1",
            kind: "Namespace",
            name: previewNamespace(fixture.environmentId),
          } as const;
          const existing = await kube.get(namespaceIdentity);
          if (existing !== null) {
            if (!isPreviewOwned(existing, fixture.environmentId)) {
              throw new Error(
                `refusing acceptance cleanup of non-owned namespace ${namespaceIdentity.name}`,
              );
            }
            await kubernetes.deletePreviewNamespace(fixture.environmentId);
            await waitForAbsent(namespaceIdentity);
          }
        } catch (error) {
          firstCleanupError ??= error;
        }
        try {
          await prisma.outboxEvent.deleteMany({ where: { aggregateId: fixture.deploymentId } });
          await prisma.user.delete({ where: { id: fixture.userId } });
          const [user, project, environment, deployment, outbox] = await Promise.all([
            prisma.user.findUnique({ where: { id: fixture.userId } }),
            prisma.project.findUnique({ where: { id: fixture.projectId } }),
            prisma.previewEnvironment.findUnique({ where: { id: fixture.environmentId } }),
            prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
            prisma.outboxEvent.count({ where: { aggregateId: fixture.deploymentId } }),
          ]);
          expect({ user, project, environment, deployment, outbox }).toEqual({
            user: null,
            project: null,
            environment: null,
            deployment: null,
            outbox: 0,
          });
        } catch (error) {
          firstCleanupError ??= error;
        }
      }),
    );
    try {
      await prisma.$disconnect();
    } catch (error) {
      firstCleanupError ??= error;
    }
    if (firstCleanupError !== undefined) throw firstCleanupError;
  }, 180_000);

  it("proves digest deployment, routing, idempotency, failures, supersession, and safe delete", async () => {
    const healthy = await createFixture("a".repeat(40));
    await moveToDeploying(healthy);
    const healthyEvent = eventFor(healthy);
    const healthyResult = await reconcilePreviewDeployment(
      reconcileInput(healthyEvent, "/"),
      rolloutDependencies(healthyEvent, "/"),
    );
    if (healthyResult.kind !== "READY") {
      const failedRecord = await prisma.deployment.findUnique({
        where: { id: healthy.deploymentId },
      });
      throw new Error(
        `healthy preview did not become READY: result=${healthyResult.kind} status=${failedRecord?.status} failureStage=${failedRecord?.failureStage} failureCode=${failedRecord?.failureCode} failureMessage=${failedRecord?.failureMessage} gatewayUrl=${configuredGatewayUrl} expectedHost=${renderedHostname(healthyEvent)} observations=${gatewayObservations.join(" | ")} routeParents=${await routeParentSummary(previewNamespace(healthy.environmentId))}`,
      );
    }
    expect(
      await prisma.deployment.findUnique({ where: { id: healthy.deploymentId } }),
    ).toMatchObject({
      status: "READY",
      imageDigest: configuredImageDigest,
      failureStage: null,
    });

    const rendered = renderPreviewResources({
      projectId: healthy.projectId,
      environmentId: healthy.environmentId,
      deploymentId: healthy.deploymentId,
      desiredCommitSha: healthy.commitSha,
      imageReference: configuredImageReference,
      imageDigest: configuredImageDigest,
      containerPort: 8080,
      healthPath: "/",
    });
    await assertLivePreviewResources(rendered, healthy.environmentId, configuredImageDigest);
    const beforeUids = await resourceUids(rendered.resources);
    const repeated = await kubernetes.reconcile({
      projectId: healthy.projectId,
      environmentId: healthy.environmentId,
      deploymentId: healthy.deploymentId,
      desiredCommitSha: healthy.commitSha,
      imageReference: configuredImageReference,
      imageDigest: configuredImageDigest,
      containerPort: 8080,
      healthPath: "/",
      isDesired: () => deployments.isDesired(healthy.deploymentId, healthy.commitSha),
    });
    expect(repeated.resources.map((resource) => resource.kind)).toEqual(
      rendered.resources.map((resource) => resource.kind),
    );
    expect(await resourceUids(repeated.resources)).toEqual(beforeUids);
    await waitForRoute(rendered.namespace, rendered.hostname);
    const response = await gatewayRequest(rendered.hostname, "/");
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/nginx/i);
    const wrongHostResponse = await gatewayRequest(`wrong-${rendered.hostname}`, "/");
    expect(wrongHostResponse.status).toBe(404);

    const failedHealth = await createFixture("b".repeat(40));
    await moveToDeploying(failedHealth);
    const failedHealthEvent = eventFor(failedHealth);
    // Establish that the Gateway is serving this preview before entering the
    // bounded rollout health window. A 404 for an unknown path alone is weak:
    // Envoy can return it before the backend route is actually serving.
    await prewarmPreviewRoute(failedHealthEvent);
    await waitForRouteAccepted(previewNamespace(failedHealth.environmentId), 120_000);
    await waitUntil(async () => {
      const hostname = eventHostname(failedHealthEvent);
      const healthyResponse = await gatewayRequest(hostname, "/");
      if (healthyResponse.status !== 200 || !/nginx/i.test(await healthyResponse.text())) {
        return false;
      }
      return (await gatewayRequest(hostname, "/m5-does-not-exist")).status === 404;
    }, 120_000);
    const failedHealthResult = await reconcilePreviewDeployment(
      reconcileInput(failedHealthEvent, "/m5-does-not-exist", 30_000),
      rolloutDependencies(failedHealthEvent, "/m5-does-not-exist"),
    );
    expect(failedHealthResult.kind).toBe("FAILED");
    expect(
      await prisma.deployment.findUnique({ where: { id: failedHealth.deploymentId } }),
    ).toMatchObject({
      status: "FAILED",
      failureStage: "HEALTHCHECK",
      failureCode: "HEALTHCHECK_FAILED",
      failureRetryable: false,
    });

    const failedRollout = await createFixture("c".repeat(40));
    const missingDigest = `sha256:${"0".repeat(64)}`;
    await moveToDeploying(failedRollout, missingDigest);
    const failedRolloutEvent = eventFor(failedRollout);
    const failedRolloutResult = await reconcilePreviewDeployment(
      reconcileInput(failedRolloutEvent, "/", 8_000, missingDigest),
      rolloutDependencies(failedRolloutEvent, "/"),
    );
    expect(failedRolloutResult.kind).toBe("FAILED");
    expect(
      await prisma.deployment.findUnique({ where: { id: failedRollout.deploymentId } }),
    ).toMatchObject({
      status: "FAILED",
      failureStage: "ROLLOUT",
      failureCode: "ROLLOUT_TIMEOUT",
      failureRetryable: true,
    });

    const stale = await createFixture("d".repeat(40));
    await moveToDeploying(stale);
    const staleEvent = eventFor(stale);
    const replacementSha = "e".repeat(40);
    const staleResult = await reconcilePreviewDeployment(
      reconcileInput(staleEvent, "/"),
      rolloutDependencies(staleEvent, "/", async () => {
        await prisma.previewEnvironment.update({
          where: { id: stale.environmentId },
          data: { desiredCommitSha: replacementSha },
        });
      }),
    );
    expect(staleResult.kind).toBe("SUPERSEDED");
    expect(await prisma.deployment.findUnique({ where: { id: stale.deploymentId } })).toMatchObject(
      {
        status: "SUPERSEDED",
      },
    );

    const wrongOwner = await createFixture("f".repeat(40));
    const wrongOwnerNamespace = previewNamespace(wrongOwner.environmentId);
    await kube.apply({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: wrongOwnerNamespace,
        labels: {
          "app.kubernetes.io/managed-by": "another-controller",
          "previewforge.dev/managed": "true",
          "previewforge.dev/environment-id": randomUUID(),
        },
      },
    });
    await expect(
      kubernetes.deletePreviewNamespace(wrongOwner.environmentId),
    ).rejects.toBeInstanceOf(PreviewOwnershipError);
    const wrongOwnerBeforeDelete = await kube.get({
      apiVersion: "v1",
      kind: "Namespace",
      name: wrongOwnerNamespace,
    });
    expect(wrongOwnerBeforeDelete).not.toBeNull();
    const wrongOwnerIdentity = resourceVersionIdentity(wrongOwnerBeforeDelete);
    const wrongOwnerRecheck = await kube.get({
      apiVersion: "v1",
      kind: "Namespace",
      name: wrongOwnerNamespace,
    });
    if (resourceVersionIdentity(wrongOwnerRecheck) !== wrongOwnerIdentity) {
      throw new Error("wrong-owner fixture changed before exact cleanup; refusing deletion");
    }

    await kubernetes.deletePreviewNamespace(healthy.environmentId);
    await kubernetes.deletePreviewNamespace(healthy.environmentId);
    await waitForAbsent({
      apiVersion: "v1",
      kind: "Namespace",
      name: previewNamespace(healthy.environmentId),
    });
    const wrongOwnerMetadata =
      wrongOwnerBeforeDelete?.metadata as KubernetesResource["metadata"] & {
        uid?: string;
        resourceVersion?: string;
      };
    if (!wrongOwnerMetadata.uid || !wrongOwnerMetadata.resourceVersion) {
      throw new Error("wrong-owner fixture lacks UID/resourceVersion for preconditioned cleanup");
    }
    await coreApi.deleteNamespace({
      name: wrongOwnerNamespace,
      body: {
        preconditions: {
          uid: wrongOwnerMetadata.uid,
          resourceVersion: wrongOwnerMetadata.resourceVersion,
        },
      },
    });
    await waitForAbsent({ apiVersion: "v1", kind: "Namespace", name: wrongOwnerNamespace });
  }, 300_000);

  it("persists an injected post-WAITING failure through PostgreSQL and emits its durable event", async () => {
    const fixture = await createFixture("1".repeat(40));
    await moveToDeploying(fixture);
    const event = eventFor(fixture);

    const waitingResult = await reconcilePreviewDeployment(reconcileInput(event, "/"), {
      kubernetes,
      deployments,
    });
    expect(waitingResult.kind).toBe("WAITING_FOR_HEALTHCHECK");
    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({ status: "WAITING_FOR_HEALTHCHECK" });

    const injectedError = new Error("m5 injected unexpected post-waiting fault");
    await expect(
      persistKubernetesFailure({
        deployments: new DeploymentRepository(prisma),
        deploymentId: fixture.deploymentId,
        commitSha: fixture.commitSha,
        error: injectedError,
      }),
    ).resolves.toBe("FAILED");

    expect(
      await prisma.deployment.findUnique({ where: { id: fixture.deploymentId } }),
    ).toMatchObject({
      status: "FAILED",
      failureStage: "KUBERNETES",
      failureCode: "KUBERNETES_RECONCILIATION_FAILED",
      failureMessage: "Kubernetes preview reconciliation failed",
      failureRetryable: true,
    });

    const failureEvents = await prisma.outboxEvent.findMany({
      where: { aggregateId: fixture.deploymentId, eventType: "deployment.failed.v1" },
    });
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]?.payload).toMatchObject({
      deploymentId: fixture.deploymentId,
      fromStatus: "WAITING_FOR_HEALTHCHECK",
      toStatus: "FAILED",
      failure: {
        stage: "KUBERNETES",
        code: "KUBERNETES_RECONCILIATION_FAILED",
        message: "Kubernetes preview reconciliation failed",
        retryable: true,
      },
    });
    expect(JSON.stringify(failureEvents[0]?.payload)).not.toContain(injectedError.message);
  }, 180_000);

  it("reconciles an owned environment Secret into a restricted pod without leaking its value", async () => {
    const fixture = await createFixture("2".repeat(40));
    const secretKey = "M5_TEST_ONLY_VALUE";
    const secretValue = `m5-test-only-${randomUUID()}`;
    await moveToDeploying(fixture);
    const event = eventFor(fixture);
    const environment = { [secretKey]: secretValue };

    const result = await reconcilePreviewDeployment(
      reconcileInput(event, "/", 120_000, configuredImageDigest, environment),
      { kubernetes, deployments },
    );
    expect(result.kind).toBe("WAITING_FOR_HEALTHCHECK");

    const rendered = renderPreviewResources({
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
      deploymentId: fixture.deploymentId,
      desiredCommitSha: fixture.commitSha,
      imageReference: configuredImageReference,
      imageDigest: configuredImageDigest,
      containerPort: 8080,
      healthPath: "/",
      environment,
    });
    await waitForPreviewPodReady(rendered.namespace, fixture.environmentId);
    await assertLivePreviewSecret(
      rendered.namespace,
      fixture.environmentId,
      secretKey,
      secretValue,
    );

    const withoutEnvironment = {
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
      deploymentId: fixture.deploymentId,
      desiredCommitSha: fixture.commitSha,
      imageReference: configuredImageReference,
      imageDigest: configuredImageDigest,
      containerPort: 8080,
      healthPath: "/",
      isDesired: () => deployments.isDesired(fixture.deploymentId, fixture.commitSha),
    };
    await kubernetes.reconcile(withoutEnvironment);
    await kubernetes.reconcile(withoutEnvironment);
    await waitUntil(
      async () =>
        (await kube.get({
          apiVersion: "v1",
          kind: "Secret",
          name: "preview-env",
          namespace: rendered.namespace,
        })) === null,
      30_000,
    );
    const noEnvDeployment = await kube.get({
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: "preview",
      namespace: rendered.namespace,
    });
    if (noEnvDeployment === null) throw new Error("missing live preview Deployment after prune");
    const noEnvContainers = (
      noEnvDeployment.spec as {
        template?: { spec?: { containers?: Array<{ envFrom?: unknown }> } };
      }
    ).template?.spec?.containers;
    expect(noEnvContainers?.[0]?.envFrom).toBeUndefined();

    await waitUntil(async () => {
      const podList = (await coreApi.listNamespacedPod({ namespace: rendered.namespace })) as {
        items?: Array<{
          metadata?: { labels?: Record<string, string> };
          spec?: { containers?: Array<{ envFrom?: unknown }> };
          status?: { containerStatuses?: Array<{ ready?: boolean }> };
        }>;
      };
      return (podList.items ?? []).some(
        (pod) =>
          pod.metadata?.labels?.["previewforge.dev/environment-id"] === fixture.environmentId &&
          pod.spec?.containers?.[0]?.envFrom === undefined &&
          pod.status?.containerStatuses?.some((container) => container.ready === true),
      );
    }, 120_000);
  }, 180_000);
});

const deployments = {
  isDesired: (deploymentId: string, commitSha: string) =>
    new DeploymentRepository(prisma).isDesired(deploymentId, commitSha),
  supersedeIfStale: (input: Parameters<DeploymentRepository["supersedeIfStale"]>[0]) =>
    new DeploymentRepository(prisma).supersedeIfStale(input),
  transition: (input: Parameters<DeploymentRepository["transition"]>[0]) =>
    new DeploymentRepository(prisma).transition(input),
};

function reconcileInput(
  event: DeploymentRequested,
  healthPath: string,
  rolloutTimeoutMs = 120_000,
  digest = configuredImageDigest,
  environment?: Record<string, string>,
) {
  return {
    event,
    imageReference: configuredImageReference,
    imageDigest: digest,
    containerPort: 8080,
    healthPath,
    healthCheckUrl: `${configuredGatewayUrl}${healthPath}`,
    rolloutTimeoutMs,
    pollIntervalMs: 250,
    healthCheckTimeoutMs: 5_000,
    ...(environment === undefined ? {} : { environment }),
  };
}

function rolloutDependencies(
  event: DeploymentRequested,
  path: string,
  afterHealthyResponse?: () => Promise<void>,
) {
  return {
    kubernetes,
    deployments,
    rollout: {
      kubernetes: kube,
      healthCheck: async (_url: string, timeoutMs: number): Promise<HealthCheckResult> => {
        await waitForRouteAccepted(previewNamespace(event.environmentId), timeoutMs);
        let response: GatewayResponse;
        try {
          response = await gatewayRequest(eventHostname(event), path, timeoutMs);
        } catch (error) {
          gatewayObservations.push(
            `health url=${configuredGatewayUrl}${path} host=${eventHostname(event)} exception=${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
        gatewayObservations.push(
          `health url=${configuredGatewayUrl}${path} host=${eventHostname(event)} status=${response.status}`,
        );
        if (response.ok) await afterHealthyResponse?.();
        return response.ok
          ? { ok: true, statusCode: response.status }
          : { ok: false, code: "HEALTHCHECK_FAILED" };
      },
    },
  };
}

async function prewarmPreviewRoute(event: DeploymentRequested): Promise<void> {
  await kubernetes.reconcile({
    projectId: event.projectId,
    environmentId: event.environmentId,
    deploymentId: event.deploymentId,
    desiredCommitSha: event.commitSha,
    imageReference: configuredImageReference,
    imageDigest: configuredImageDigest,
    containerPort: 8080,
    healthPath: "/m5-does-not-exist",
    isDesired: () => deployments.isDesired(event.deploymentId, event.commitSha),
  });
}

function eventHostname(event: DeploymentRequested): string {
  return `preview-${event.environmentId}.previewforge.local`;
}

function renderedHostname(event: DeploymentRequested): string {
  return eventHostname(event);
}

async function gatewayRequest(
  hostname: string,
  path: string,
  timeoutMs = 10_000,
): Promise<GatewayResponse> {
  const url = new URL(`${configuredGatewayUrl}${path}`);
  if (url.protocol !== "http:") throw new Error("M5_GATEWAY_URL must be an HTTP loopback URL");
  return new Promise((resolve, reject) => {
    const clientRequest = request(url, { headers: { host: hostname } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status, ok: status >= 200 && status < 300, text: async () => body });
      });
    });
    const timer = setTimeout(
      () => clientRequest.destroy(new Error("M5 Gateway request timed out")),
      timeoutMs,
    );
    clientRequest.on("error", reject);
    clientRequest.on("close", () => clearTimeout(timer));
    clientRequest.end();
  });
}

type GatewayResponse = {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
};

async function createFixture(commitSha: string): Promise<Fixture> {
  const userId = randomUUID();
  const installationId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const deploymentId = randomUUID();
  await prisma.user.create({
    data: { id: userId, githubUserId: `m5-${userId}`, githubLogin: `m5-${userId}` },
  });
  await prisma.installation.create({
    data: {
      id: installationId,
      githubInstallationId: BigInt(Date.now()) + BigInt(fixtures.length),
      accountLogin: `m5-${userId}`,
      accountType: "User",
      ownerId: userId,
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      installationId,
      ownerId: userId,
      githubRepositoryId: BigInt(`${Date.now()}${fixtures.length}`),
      repositoryFullName: `previewforge/m5-${userId}`,
      containerPort: 8080,
      healthPath: "/",
    },
  });
  await prisma.previewEnvironment.create({
    data: { id: environmentId, projectId, previewKey: `m5-${userId}`, desiredCommitSha: commitSha },
  });
  await prisma.deployment.create({ data: { id: deploymentId, environmentId, commitSha } });
  const fixture = { userId, environmentId, deploymentId, commitSha, projectId };
  fixtures.push(fixture);
  return fixture;
}

async function moveToDeploying(fixture: Fixture, digest = configuredImageDigest): Promise<void> {
  const repository = new DeploymentRepository(prisma);
  let status: DeploymentStatus = "QUEUED";
  for (const next of ["CLONING", "BUILDING", "PUSHING", "DEPLOYING"] as const) {
    await expect(
      repository.transition({
        deploymentId: fixture.deploymentId,
        expectedStatus: status,
        to: next,
        expectedDesiredSha: fixture.commitSha,
        ...(next === "DEPLOYING" ? { imageDigest: digest } : {}),
      }),
    ).resolves.toMatchObject({ applied: true });
    status = next;
  }
}

function eventFor(fixture: Fixture): DeploymentRequested {
  return {
    eventId: randomUUID(),
    eventType: "deployment.requested.v1",
    occurredAt: new Date().toISOString(),
    deploymentId: fixture.deploymentId,
    environmentId: fixture.environmentId,
    projectId: fixture.projectId,
    installationId: randomUUID(),
    repositoryFullName: `previewforge/m5-${fixture.userId}`,
    pullRequestNumber: 1,
    commitSha: fixture.commitSha,
  };
}

async function assertLivePreviewResources(
  rendered: ReturnType<typeof renderPreviewResources>,
  environmentId: string,
  digest: string,
): Promise<void> {
  const live = new Map<string, KubernetesResource>();
  for (const resource of rendered.resources) {
    const current = await kube.get({
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      name: resource.metadata.name,
      ...(resource.metadata.namespace === undefined
        ? {}
        : { namespace: resource.metadata.namespace }),
    });
    if (current === null)
      throw new Error(`missing live ${resource.kind}/${resource.metadata.name}`);
    expect(isPreviewOwned(current, environmentId)).toBe(true);
    live.set(resource.kind, current);
  }
  expect([...live.keys()].sort()).toEqual(
    [
      "Deployment",
      "HTTPRoute",
      "LimitRange",
      "Namespace",
      "NetworkPolicy",
      "ResourceQuota",
      "Service",
      "ServiceAccount",
    ].sort(),
  );

  const namespace = live.get("Namespace");
  expect(namespace?.metadata.labels).toMatchObject({
    "pod-security.kubernetes.io/enforce": "restricted",
    "pod-security.kubernetes.io/audit": "restricted",
    "pod-security.kubernetes.io/warn": "restricted",
  });
  const quota = live.get("ResourceQuota")?.spec as { hard?: Record<string, string> } | undefined;
  expect(quota?.hard).toMatchObject({ "requests.cpu": "2", "limits.memory": "4Gi" });
  const limits = live.get("LimitRange")?.spec as
    | { limits?: Array<Record<string, unknown> & { _default?: Record<string, string> }> }
    | undefined;
  expect(limits?.limits?.[0]).toMatchObject({
    type: "Container",
    defaultRequest: { cpu: "100m", memory: "128Mi" },
  });
  expect(limits?.limits?.[0]?._default).toMatchObject({ cpu: "500m", memory: "512Mi" });
  const networkPolicy = live.get("NetworkPolicy")?.spec as
    | {
        policyTypes?: string[];
        ingress?: Array<Record<string, unknown>>;
        egress?: Array<Record<string, unknown>>;
      }
    | undefined;
  expect(networkPolicy).toMatchObject({ policyTypes: ["Ingress", "Egress"] });
  expect(networkPolicy?.ingress).toEqual([
    {
      _from: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": "envoy-gateway-system" },
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    },
  ]);
  expect(networkPolicy?.egress).toEqual([
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
  ]);
  expect(live.get("ServiceAccount")?.automountServiceAccountToken).toBe(false);

  const deploymentSpec = live.get("Deployment")?.spec as
    | {
        template?: {
          spec?: {
            automountServiceAccountToken?: boolean;
            securityContext?: Record<string, unknown>;
            containers?: Array<Record<string, unknown>>;
          };
        };
      }
    | undefined;
  const podSpec = deploymentSpec?.template?.spec;
  const container = podSpec?.containers?.[0];
  expect(podSpec?.automountServiceAccountToken).toBe(false);
  expect(podSpec?.securityContext).toMatchObject({
    runAsNonRoot: true,
    seccompProfile: { type: "RuntimeDefault" },
  });
  expect(container).toMatchObject({
    image: `${configuredImageReference}@${digest}`,
    resources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    },
    securityContext: {
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser: 10001,
      capabilities: { drop: ["ALL"] },
    },
  });
  expect(live.get("Service")?.spec).toMatchObject({ type: "ClusterIP" });
  expect(live.get("HTTPRoute")?.spec).toMatchObject({
    parentRefs: [{ name: "previewforge", namespace: "default", sectionName: "http" }],
  });

  const podList = (await coreApi.listNamespacedPod({
    namespace: rendered.namespace,
  })) as unknown as {
    items?: Array<{
      metadata?: { labels?: Record<string, string> };
      status?: { containerStatuses?: Array<{ imageID?: string }> };
    }>;
  };
  const previewPods = (podList.items ?? []).filter(
    (pod) => pod.metadata?.labels?.["previewforge.dev/environment-id"] === environmentId,
  );
  expect(previewPods.length).toBeGreaterThan(0);
  const imageIds = previewPods.flatMap(
    (pod) => pod.status?.containerStatuses?.map((container) => container.imageID ?? "") ?? [],
  );
  expect(imageIds.some((imageId) => imageId.includes(digest))).toBe(true);
}

async function assertLivePreviewSecret(
  namespace: string,
  environmentId: string,
  secretKey: string,
  expectedValue: string,
): Promise<void> {
  const secret = await kube.get({
    apiVersion: "v1",
    kind: "Secret",
    name: "preview-env",
    namespace,
  });
  if (secret === null) throw new Error("missing live preview Secret");
  expect(isPreviewOwned(secret, environmentId)).toBe(true);
  expect(secret.type).toBe("Opaque");
  expect(secret.stringData).toBeUndefined();
  const data = secret.data as Record<string, string> | undefined;
  expect(Object.keys(data ?? {})).toEqual([secretKey]);
  const encodedValue = data?.[secretKey];
  if (encodedValue === undefined) throw new Error("preview Secret key is missing");
  expect(Buffer.from(encodedValue, "base64").toString("utf8") === expectedValue).toBe(true);

  const deployment = await kube.get({
    apiVersion: "apps/v1",
    kind: "Deployment",
    name: "preview",
    namespace,
  });
  if (deployment === null) throw new Error("missing live preview Deployment");
  const deploymentSpec = deployment.spec as
    | {
        template?: {
          spec?: {
            containers?: Array<{ envFrom?: Array<Record<string, unknown>> }>;
          };
        };
      }
    | undefined;
  expect(deploymentSpec?.template?.spec?.containers?.[0]?.envFrom).toEqual([
    { secretRef: { name: "preview-env" } },
  ]);

  const apiResponses = JSON.stringify({ secret, deployment });
  expect(apiResponses).not.toContain(expectedValue);

  const podName = await waitForPreviewPodReady(namespace, environmentId);
  const logs = await coreApi.readNamespacedPodLog({
    name: podName,
    namespace,
    container: "preview",
    tailLines: 100,
  });
  expect(logs).not.toContain(expectedValue);
}

async function waitForPreviewPodReady(namespace: string, environmentId: string): Promise<string> {
  let readyPodName: string | undefined;
  await waitUntil(async () => {
    const podList = (await coreApi.listNamespacedPod({ namespace })) as unknown as {
      items?: Array<{
        metadata?: { name?: string; labels?: Record<string, string> };
        status?: { containerStatuses?: Array<{ ready?: boolean }> };
      }>;
    };
    const readyPod = (podList.items ?? []).find(
      (pod) =>
        pod.metadata?.labels?.["previewforge.dev/environment-id"] === environmentId &&
        pod.metadata.name !== undefined &&
        pod.status?.containerStatuses?.some((container) => container.ready === true),
    );
    if (readyPod?.metadata?.name !== undefined) readyPodName = readyPod.metadata.name;
    return readyPodName !== undefined;
  }, 120_000);
  if (readyPodName === undefined) throw new Error("preview pod did not become ready");
  return readyPodName;
}

function resourceVersionIdentity(resource: KubernetesResource | null): string {
  if (resource === null) return "missing";
  const metadata = resource.metadata as KubernetesResource["metadata"] & {
    uid?: string;
    resourceVersion?: string;
  };
  return `${metadata.uid ?? "missing-uid"}/${metadata.resourceVersion ?? "missing-resource-version"}`;
}

async function resourceUids(
  resources: readonly KubernetesResource[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const resource of resources) {
    const current = await kube.get({
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      name: resource.metadata.name,
      ...(resource.metadata.namespace === undefined
        ? {}
        : { namespace: resource.metadata.namespace }),
    });
    const uid = (
      current?.metadata as (KubernetesResource["metadata"] & { uid?: string }) | undefined
    )?.uid;
    if (!uid) throw new Error(`resource ${resource.kind}/${resource.metadata.name} has no UID`);
    result[`${resource.kind}/${resource.metadata.namespace ?? ""}/${resource.metadata.name}`] = uid;
  }
  return result;
}

async function waitForRoute(namespace: string, hostname: string): Promise<void> {
  await waitForRouteAccepted(namespace, 120_000);
  await waitUntil(async () => (await gatewayRequest(hostname, "/")).status < 500, 120_000);
}

async function waitForRouteAccepted(namespace: string, timeoutMs: number): Promise<void> {
  await waitUntil(async () => {
    const route = await kube.get({
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      name: "preview",
      namespace,
    });
    const parents =
      (
        route?.status as
          | { parents?: Array<{ conditions?: Array<{ type?: string; status?: string }> }> }
          | undefined
      )?.parents ?? [];
    return parents.some((parent) =>
      ["Accepted", "ResolvedRefs"].every((type) =>
        parent.conditions?.some(
          (condition) => condition.type === type && condition.status === "True",
        ),
      ),
    );
  }, timeoutMs);
}

async function routeParentSummary(namespace: string): Promise<string> {
  try {
    const route = await kube.get({
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      name: "preview",
      namespace,
    });
    const parents =
      (
        route?.status as
          | { parents?: Array<{ parentRef?: unknown; conditions?: unknown }> }
          | undefined
      )?.parents ?? [];
    return JSON.stringify(parents);
  } catch (error) {
    return `route-observation-error=${error instanceof Error ? error.message : String(error)}`;
  }
}

async function waitForAbsent(identity: {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}): Promise<void> {
  await waitUntil(async () => (await kube.get(identity)) === null, 60_000);
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("M5 acceptance wait timed out");
}
