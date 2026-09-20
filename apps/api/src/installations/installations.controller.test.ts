import type { InstallationRecord } from "@previewforge/database";
import { describe, expect, it, vi } from "vitest";
import { InstallationsController } from "./installations.controller.js";

describe("InstallationsController", () => {
  it("returns a safe owner-scoped installation projection", async () => {
    const auth = {
      listInstallations: vi.fn(async () => [installation("42", "octo", "User")]),
    };
    const controller = new InstallationsController(auth as never);
    Object.defineProperty(controller, "request", {
      value: { headers: { cookie: "previewforge_session=session-token" } },
    });

    await expect(controller.list()).resolves.toEqual({
      items: [{ id: "42", accountLogin: "octo", accountType: "User" }],
    });
    expect(auth.listInstallations).toHaveBeenCalledWith("session-token");
  });
});

function installation(
  githubInstallationId: string,
  accountLogin: string,
  accountType: "User" | "Organization",
): InstallationRecord {
  return {
    id: "database-id",
    githubInstallationId,
    githubAccountId: null,
    accountLogin,
    accountType,
    ownerId: "owner-id",
  };
}
