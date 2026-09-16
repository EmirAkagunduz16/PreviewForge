import { NotFoundException } from "@nestjs/common";
import { CredentialCipher, projectEnvironmentAssociatedData } from "@previewforge/security";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentVariablesService } from "./environment-variables.service.js";

const projectId = "123e4567-e89b-42d3-a456-426614174000";

describe("EnvironmentVariablesService", () => {
  it("returns exact key-only projections, writes ciphertext, replaces atomically, and deletes", async () => {
    const auth = { authenticate: vi.fn(async () => ({ userId: "owner" })) };
    const cipher = new CredentialCipher(Buffer.alloc(32, 9));
    let encrypted = "";
    const repository = {
      hasOwnedProject: vi.fn(async () => true),
      listNames: vi.fn(async () => [{ key: "TOKEN" }]),
      upsert: vi.fn(async (_owner: string, _project: string, key: string, value: string) => {
        encrypted = value;
        return { key };
      }),
      delete: vi.fn(async () => true),
    };
    const service = new EnvironmentVariablesService(
      auth,
      repository as never,
      cipher,
      "https://previewforge.test",
    );
    expect(await service.list("session", projectId)).toEqual({ items: [{ key: "TOKEN" }] });
    const result = await service.put("session", "https://previewforge.test", projectId, "TOKEN", {
      value: "secret",
    });
    expect(result).toEqual({ key: "TOKEN" });
    expect(cipher.decrypt(encrypted, projectEnvironmentAssociatedData(projectId, "TOKEN"))).toBe(
      "secret",
    );
    await expect(
      service.delete("session", "https://previewforge.test", projectId, "TOKEN"),
    ).resolves.toEqual({ deleted: true });
  });

  it("normalizes foreign/missing and blocks cross-origin or invalid bounded input", async () => {
    const repository = {
      hasOwnedProject: vi.fn(async () => false),
      listNames: vi.fn(async () => []),
      upsert: vi.fn(),
      delete: vi.fn(),
    };
    const service = new EnvironmentVariablesService(
      { authenticate: vi.fn(async () => ({ userId: "owner" })) },
      repository as never,
      new CredentialCipher(Buffer.alloc(32)),
      "https://previewforge.test",
    );
    await expect(service.list("session", projectId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.put("session", "https://evil.test", projectId, "TOKEN", { value: "x" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.put("session", "https://previewforge.test", projectId, "bad-key", { value: "x" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.put("session", "https://previewforge.test", projectId, "TOKEN", {
        value: "é".repeat(8193),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
