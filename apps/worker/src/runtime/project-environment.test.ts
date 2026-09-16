import { CredentialCipher, projectEnvironmentAssociatedData } from "@previewforge/security";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentDecryptionError, loadProjectEnvironment } from "./project-environment.js";

describe("loadProjectEnvironment", () => {
  it("loads project-shared encrypted values with project/key AAD", async () => {
    const cipher = new CredentialCipher(Buffer.alloc(32, 3));
    const projectId = "project-a";
    const repository = {
      listEncryptedByProjectId: vi.fn(async (id: string) =>
        id === projectId
          ? [
              {
                key: "TOKEN",
                encryptedValue: cipher.encrypt(
                  "value",
                  projectEnvironmentAssociatedData(projectId, "TOKEN"),
                ),
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]
          : [],
      ),
    };
    await expect(loadProjectEnvironment(repository, cipher, projectId)).resolves.toEqual({
      TOKEN: "value",
    });
    await expect(loadProjectEnvironment(repository, cipher, "project-b")).resolves.toEqual({});
  });

  it("fails closed with a redacted error on ciphertext/AAD mismatch", async () => {
    const cipher = new CredentialCipher(Buffer.alloc(32, 3));
    const secret = "value-that-must-not-be-reported";
    const repository = {
      listEncryptedByProjectId: async () => [
        {
          key: "TOKEN",
          encryptedValue: cipher.encrypt(
            secret,
            projectEnvironmentAssociatedData("project-a", "TOKEN"),
          ),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };
    await expect(loadProjectEnvironment(repository, cipher, "project-b")).rejects.toBeInstanceOf(
      EnvironmentDecryptionError,
    );
    await expect(loadProjectEnvironment(repository, cipher, "project-b")).rejects.not.toThrow(
      secret,
    );
  });

  it("keeps valid special env names as own data properties", async () => {
    const cipher = new CredentialCipher(Buffer.alloc(32, 4));
    const key = "__proto__";
    const projectId = "project-safe-map";
    const repository = {
      listEncryptedByProjectId: async () => [
        {
          key,
          encryptedValue: cipher.encrypt(
            "plain-value",
            projectEnvironmentAssociatedData(projectId, key),
          ),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };
    const values = await loadProjectEnvironment(repository, cipher, projectId);
    expect(Object.hasOwn(values, key)).toBe(true);
    expect(values[key]).toBe("plain-value");
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
  });
});
