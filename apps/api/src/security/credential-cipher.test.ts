import { describe, expect, it } from "vitest";
import { CredentialCipher } from "./credential-cipher.js";

describe("CredentialCipher", () => {
  it("round-trips credentials in a versioned AES-256-GCM envelope", () => {
    const cipher = new CredentialCipher(Buffer.alloc(32, 7));
    const encoded = cipher.encrypt("ghu_example_token", "user:42");

    expect(encoded.startsWith("v1.")).toBe(true);
    expect(cipher.decrypt(encoded, "user:42")).toBe("ghu_example_token");
  });

  it("matches a known AES-256-GCM fixture", () => {
    const cipher = new CredentialCipher(Buffer.alloc(32));
    const encode = (hex: string) => Buffer.from(hex, "hex").toString("base64url");
    const fixture = [
      "v1",
      encode("000000000000000000000000"),
      encode("d0d1c8a799996bf0265b98b5d48ab919"),
      encode("cea7403d4d606b6e074ec5d3baf39d18"),
    ].join(".");

    expect(cipher.decrypt(fixture)).toBe("\0".repeat(16));
  });

  it("does not decrypt tampered or malformed ciphertext", () => {
    const cipher = new CredentialCipher(Buffer.alloc(32, 1));
    const encoded = cipher.encrypt("secret");
    expect(() => cipher.decrypt(encoded.replace("v1", "v2"))).toThrow(
      "Unsupported credential ciphertext version",
    );
    expect(() => cipher.decrypt(encoded.replace(/\.[^.]+$/, ".bad!"))).toThrow(
      "Invalid credential ciphertext",
    );
  });
});
