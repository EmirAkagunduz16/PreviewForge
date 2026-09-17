import type {
  EnvironmentDeletionRepository,
  ExpiredEnvironmentSweepResult,
} from "@previewforge/database";

export type TtlSweepRepository = Pick<EnvironmentDeletionRepository, "enqueueExpired">;

export type TtlSweeperOptions = {
  intervalMs: number;
  limit?: number;
  signal: AbortSignal;
  onSweep?: (result: ExpiredEnvironmentSweepResult) => void;
  onError?: () => void;
};

export async function runTtlSweep(
  repository: TtlSweepRepository,
  limit?: number,
): Promise<ExpiredEnvironmentSweepResult> {
  return repository.enqueueExpired(limit === undefined ? {} : { limit });
}

/** Run one sweep immediately, then continue until the worker aborts. */
export async function runTtlSweeper(
  repository: TtlSweepRepository,
  options: TtlSweeperOptions,
): Promise<void> {
  validateInterval(options.intervalMs);

  while (!options.signal.aborted) {
    try {
      const result = await runTtlSweep(repository, options.limit);
      options.onSweep?.(result);
    } catch {
      // A failed sweep is retryable on the next interval. The caller records
      // only a safe event name and counters; database or broker details never
      // enter the worker log line.
      options.onError?.();
    }

    if (await waitForInterval(options.signal, options.intervalMs)) return;
  }
}

function validateInterval(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 24 * 60 * 60 * 1_000) {
    throw new Error("TTL sweep interval is invalid");
  }
}

function waitForInterval(signal: AbortSignal, intervalMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, intervalMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
