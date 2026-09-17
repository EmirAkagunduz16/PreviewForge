import { describe, expect, it, vi } from "vitest";
import {
  type OrphanReconcilerDependencies,
  reconcileManagedOrphans,
  runOrphanSweeper,
} from "./orphan-reconciler.js";

const missingEnvironmentId = "11111111-1111-4111-8111-111111111111";
const completedEnvironmentId = "22222222-2222-4222-8222-222222222222";
const activeEnvironmentId = "33333333-3333-4333-8333-333333333333";
const wrongOwnerEnvironmentId = "44444444-4444-4444-8444-444444444444";
const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherProjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("managed orphan reconciler", () => {
  it("deletes only valid missing or terminal environments and paginates safely", async () => {
    const deleted: string[] = [];
    const listNamespaces = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          namespace(missingEnvironmentId, projectId),
          namespace(completedEnvironmentId, projectId),
          namespace(activeEnvironmentId, projectId),
          namespace(wrongOwnerEnvironmentId, otherProjectId),
          { ...namespace(missingEnvironmentId, projectId), metadata: { name: "pf-malformed" } },
        ],
        continueToken: "next-page",
      })
      .mockResolvedValueOnce({ items: [] });
    const database = {
      findPreviewEnvironmentCleanupState: vi.fn(async (environmentId: string) => {
        if (environmentId === completedEnvironmentId) {
          return { projectId, environmentStatus: "ACTIVE", deletionStatus: "COMPLETED" };
        }
        if (environmentId === activeEnvironmentId) {
          return { projectId, environmentStatus: "ACTIVE", deletionStatus: "REQUESTED" };
        }
        if (environmentId === wrongOwnerEnvironmentId) {
          return { projectId, environmentStatus: "ACTIVE", deletionStatus: "COMPLETED" };
        }
        return null;
      }),
    };
    const dependencies: OrphanReconcilerDependencies = {
      kubernetes: { listNamespaces },
      database,
      deleteNamespace: async (environmentId) => {
        deleted.push(environmentId);
      },
    };

    await expect(reconcileManagedOrphans(dependencies, { pageSize: 10 })).resolves.toEqual({
      pages: 2,
      scanned: 5,
      deleted: 2,
      skipped: 3,
      failed: 0,
      truncated: false,
    });
    expect(deleted).toEqual([missingEnvironmentId, completedEnvironmentId]);
    expect(listNamespaces).toHaveBeenNthCalledWith(1, {
      labelSelector: "previewforge.dev/managed=true",
      limit: 10,
    });
    expect(listNamespaces).toHaveBeenNthCalledWith(2, {
      labelSelector: "previewforge.dev/managed=true",
      limit: 10,
      continueToken: "next-page",
    });
  });

  it("leaves malformed candidates and treats a disappeared namespace as success", async () => {
    const deleteNamespace = vi
      .fn()
      .mockRejectedValueOnce({ code: 404 })
      .mockRejectedValueOnce({ code: "PREVIEW_OWNERSHIP_CONFLICT" });
    const dependencies: OrphanReconcilerDependencies = {
      kubernetes: {
        listNamespaces: async () => ({
          items: [
            namespace(missingEnvironmentId, projectId),
            { ...namespace(completedEnvironmentId, projectId), metadata: { name: "pf-invalid" } },
            namespace(completedEnvironmentId, projectId),
          ],
        }),
      },
      database: {
        findPreviewEnvironmentCleanupState: async (environmentId) =>
          environmentId === completedEnvironmentId
            ? { projectId, environmentStatus: "ACTIVE", deletionStatus: "COMPLETED" }
            : null,
      },
      deleteNamespace,
    };

    await expect(reconcileManagedOrphans(dependencies)).resolves.toMatchObject({
      deleted: 1,
      skipped: 1,
      failed: 1,
    });
  });

  it("bounds a paginated run and retries on the next interval", async () => {
    const controller = new AbortController();
    const listNamespaces = vi
      .fn()
      .mockResolvedValueOnce({ items: [], continueToken: "more" })
      .mockImplementationOnce(async () => {
        controller.abort();
        return { items: [] };
      });
    const onSweep = vi.fn();
    const onError = vi.fn();

    await runOrphanSweeper(
      {
        kubernetes: { listNamespaces },
        database: { findPreviewEnvironmentCleanupState: vi.fn() },
        deleteNamespace: vi.fn(),
      },
      { intervalMs: 1, signal: controller.signal, reconcile: { maxPages: 1 }, onSweep, onError },
    );

    expect(listNamespaces).toHaveBeenCalledTimes(2);
    expect(onSweep).toHaveBeenNthCalledWith(1, expect.objectContaining({ truncated: true }));
    expect(onSweep).toHaveBeenNthCalledWith(2, expect.objectContaining({ truncated: false }));
    expect(onError).not.toHaveBeenCalled();
  });
});

function namespace(environmentId: string, projectIdValue: string) {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: `pf-${environmentId}`,
      uid: `uid-${environmentId}`,
      resourceVersion: "7",
      labels: {
        "app.kubernetes.io/name": "preview",
        "app.kubernetes.io/managed-by": "previewforge",
        "previewforge.dev/managed": "true",
        "previewforge.dev/project-id": projectIdValue,
        "previewforge.dev/environment-id": environmentId,
      },
    },
  } as const;
}
