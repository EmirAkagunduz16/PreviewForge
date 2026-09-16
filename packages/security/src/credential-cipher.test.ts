import { describe, expect, it } from "vitest";
import { CredentialCipher } from "./credential-cipher.js";

describe("CredentialCipher", () => {
  it("encrypts and decrypts with authenticated associated data", () => {
    const cipher = new CredentialCipher(Buffer.alloc(32, 7));
    const encrypted = cipher.encrypt("value", "project:key");
    expect(cipher.decrypt(encrypted, "project:key")).toBe("value");
    expect(() => cipher.decrypt(encrypted, "other:key")).toThrow("authentication failed");
  });
  it("preserves the versioned envelope and no-AAD compatibility", () => {
    const cipher = new CredentialCipher(Buffer.alloc(32));
    const encrypted = cipher.encrypt("value");
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(cipher.decrypt(encrypted)).toBe("value");
  });
});
