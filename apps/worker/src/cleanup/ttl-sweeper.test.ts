import { describe, expect, it, vi } from "vitest";
import { runTtlSweep, runTtlSweeper } from "./ttl-sweeper.js";

describe("TTL sweeper", () => {
  it("delegates one bounded sweep to the database intent boundary", async () => {
    const enqueueExpired = vi.fn().mockResolvedValue({ scanned: 2, enqueued: 1, skipped: 1 });

    await expect(runTtlSweep({ enqueueExpired }, 25)).resolves.toEqual({
      scanned: 2,
      enqueued: 1,
      skipped: 1,
    });
    expect(enqueueExpired).toHaveBeenCalledWith({ limit: 25 });
  });

  it("runs immediately, retries after a failed interval, and stops on abort", async () => {
    const controller = new AbortController();
    const enqueueExpired = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient database failure"))
      .mockImplementationOnce(async () => {
        controller.abort();
        return { scanned: 1, enqueued: 1, skipped: 0 };
      });
    const onError = vi.fn();
    const onSweep = vi.fn();

    await runTtlSweeper(
      { enqueueExpired },
      { intervalMs: 1, signal: controller.signal, onError, onSweep },
    );

    expect(enqueueExpired).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSweep).toHaveBeenCalledWith({ scanned: 1, enqueued: 1, skipped: 0 });
  });

  it("rejects an unbounded interval before starting", async () => {
    const controller = new AbortController();
    await expect(
      runTtlSweeper({ enqueueExpired: vi.fn() }, { intervalMs: 0, signal: controller.signal }),
    ).rejects.toThrow("TTL sweep interval is invalid");
  });
});
