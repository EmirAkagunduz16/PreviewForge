import type {
  EnvironmentDeletionRepository,
  PreviewEnvironmentCleanupState,
} from "@previewforge/database";
import type { KubernetesResourceClient } from "../kubernetes/reconciler.js";
import {
  isPreviewOwned,
  type KubernetesResource,
  PREVIEW_MANAGED_BY,
  previewNamespace,
} from "../kubernetes/resource-renderer.js";

const MANAGED_LABEL_SELECTOR = "previewforge.dev/managed=true";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;
const MAX_MAX_PAGES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TERMINAL_ENVIRONMENT_STATUSES = new Set(["DELETED", "CLEANED", "TERMINAL"]);

export type OrphanReconcilerDatabase = Pick<
  EnvironmentDeletionRepository,
  "findPreviewEnvironmentCleanupState"
>;

export type OrphanReconcilerDependencies = {
  kubernetes: Pick<KubernetesResourceClient, "listNamespaces">;
  database: OrphanReconcilerDatabase;
  deleteNamespace: (environmentId: string) => Promise<void>;
};

export type OrphanReconcileOptions = {
  pageSize?: number;
  maxPages?: number;
};

export type OrphanReconcileResult = {
  pages: number;
  scanned: number;
  deleted: number;
  skipped: number;
  failed: number;
  truncated: boolean;
};

export type OrphanSweeperOptions = {
  intervalMs: number;
  signal: AbortSignal;
  reconcile?: OrphanReconcileOptions;
  onSweep?: (result: OrphanReconcileResult) => void;
  onError?: () => void;
};

export async function reconcileManagedOrphans(
  dependencies: OrphanReconcilerDependencies,
  options: OrphanReconcileOptions = {},
): Promise<OrphanReconcileResult> {
  const pageSize = boundedPageSize(options.pageSize);
  const maxPages = boundedMaxPages(options.maxPages);
  let continueToken: string | undefined;
  let pages = 0;
  let scanned = 0;
  let deleted = 0;
  let skipped = 0;
  let failed = 0;

  do {
    const page = await dependencies.kubernetes.listNamespaces({
      labelSelector: MANAGED_LABEL_SELECTOR,
      limit: pageSize,
      ...(continueToken === undefined ? {} : { continueToken }),
    });
    pages += 1;
    for (const resource of page.items) {
      scanned += 1;
      const candidate = validateCandidate(resource);
      if (candidate === undefined) {
        skipped += 1;
        continue;
      }

      let state: PreviewEnvironmentCleanupState | null;
      try {
        state = await dependencies.database.findPreviewEnvironmentCleanupState(
          candidate.environmentId,
        );
      } catch {
        failed += 1;
        continue;
      }

      if (state !== null && state.projectId !== candidate.projectId) {
        skipped += 1;
        continue;
      }
      if (state !== null && !isTerminalCleanupState(state)) {
        skipped += 1;
        continue;
      }

      try {
        await dependencies.deleteNamespace(candidate.environmentId);
        deleted += 1;
      } catch (error) {
        if (isNotFound(error)) deleted += 1;
        else failed += 1;
      }
    }
    continueToken = page.continueToken;
  } while (continueToken !== undefined && pages < maxPages);

  return {
    pages,
    scanned,
    deleted,
    skipped,
    failed,
    truncated: continueToken !== undefined,
  };
}

export async function runOrphanSweeper(
  dependencies: OrphanReconcilerDependencies,
  options: OrphanSweeperOptions,
): Promise<void> {
  validateInterval(options.intervalMs);
  while (!options.signal.aborted) {
    try {
      const result = await reconcileManagedOrphans(dependencies, options.reconcile);
      options.onSweep?.(result);
    } catch {
      options.onError?.();
    }
    if (await waitForInterval(options.signal, options.intervalMs)) return;
  }
}

function validateCandidate(resource: KubernetesResource):
  | {
      environmentId: string;
      projectId: string;
    }
  | undefined {
  const labels = resource.metadata.labels;
  const environmentId = labels?.["previewforge.dev/environment-id"];
  const projectId = labels?.["previewforge.dev/project-id"];
  if (
    labels?.["app.kubernetes.io/managed-by"] !== PREVIEW_MANAGED_BY ||
    labels["previewforge.dev/managed"] !== "true" ||
    labels["app.kubernetes.io/name"] !== "preview" ||
    environmentId === undefined ||
    projectId === undefined ||
    !UUID.test(environmentId) ||
    !UUID.test(projectId) ||
    resource.metadata.name !== previewNamespace(environmentId) ||
    !isPreviewOwned(resource, environmentId)
  ) {
    return undefined;
  }
  return { environmentId: environmentId.toLowerCase(), projectId: projectId.toLowerCase() };
}

function isTerminalCleanupState(state: PreviewEnvironmentCleanupState): boolean {
  return (
    state.deletionStatus === "COMPLETED" ||
    TERMINAL_ENVIRONMENT_STATUSES.has(state.environmentStatus)
  );
}

function boundedPageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error("orphan reconciliation page size is invalid");
  }
  return pageSize;
}

function boundedMaxPages(value: number | undefined): number {
  const maxPages = value ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_MAX_PAGES) {
    throw new Error("orphan reconciliation page count is invalid");
  }
  return maxPages;
}

function validateInterval(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 24 * 60 * 60 * 1_000) {
    throw new Error("orphan sweep interval is invalid");
  }
}

function waitForInterval(signal: AbortSignal, intervalMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, intervalMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === 404) return true;
  const response = "response" in error ? error.response : undefined;
  return Boolean(
    response &&
      typeof response === "object" &&
      "statusCode" in response &&
      response.statusCode === 404,
  );
}
