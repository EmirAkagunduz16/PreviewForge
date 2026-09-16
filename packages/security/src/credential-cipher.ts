import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type EncryptedCredential = `${typeof VERSION}.${string}.${string}.${string}`;

/** A versioned, authenticated ciphertext suitable for database storage. */
export class CredentialCipher {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== KEY_BYTES) throw new Error("Credential encryption key must be 32 bytes");
    this.key = Buffer.from(key);
  }

  encrypt(plaintext: string, associatedData?: string): EncryptedCredential {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    if (associatedData !== undefined) cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, encode(iv), encode(cipher.getAuthTag()), encode(ciphertext)].join(
      ".",
    ) as EncryptedCredential;
  }

  decrypt(encoded: string, associatedData?: string): string {
    const parts = encoded.split(".");
    const [version, ivEncoded, tagEncoded, ciphertextEncoded] = parts;
    if (
      parts.length !== 4 ||
      version !== VERSION ||
      !ivEncoded ||
      !tagEncoded ||
      ciphertextEncoded === undefined
    ) {
      throw new Error("Unsupported credential ciphertext version");
    }
    const iv = decode(ivEncoded);
    const tag = decode(tagEncoded);
    const ciphertext = decode(ciphertextEncoded);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
      throw new Error("Invalid credential ciphertext");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      if (associatedData !== undefined) decipher.setAAD(Buffer.from(associatedData, "utf8"));
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Credential ciphertext authentication failed");
    }
  }
}

export function createCredentialCipher(key: Uint8Array): CredentialCipher {
  return new CredentialCipher(key);
}
export function projectEnvironmentAssociatedData(projectId: string, key: string): string {
  return `previewforge:project-environment:v1:${projectId}:${key}`;
}
/** Preserve the API's existing accepted hex/base64/base64url key encodings. */
export function decodeCredentialEncryptionKey(value: string): Buffer {
  const isHex = /^[0-9a-fA-F]{64}$/.test(value);
  const isBase64 = /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 !== 1;
  const isBase64Url = /^[A-Za-z0-9_-]*={0,2}$/.test(value) && value.length % 4 !== 1;
  if (!isHex && !isBase64 && !isBase64Url)
    throw new Error("ENCRYPTION_KEY must decode to 32 bytes");
  const key = isHex
    ? Buffer.from(value, "hex")
    : Buffer.from(value, isBase64 ? "base64" : "base64url");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}
function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}
function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid credential ciphertext");
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new Error("Invalid credential ciphertext");
  }
}
