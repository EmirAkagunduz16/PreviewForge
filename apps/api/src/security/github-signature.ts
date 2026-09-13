import { createHmac, timingSafeEqual } from "node:crypto";

export function computeGitHubSignature(rawBody: Uint8Array, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** Verify a GitHub signature over the exact bytes received on the wire. */
export function verifyGitHubSignature(
  rawBody: Uint8Array,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=") || secret.length === 0) {
    return false;
  }
  const supplied = Buffer.from(signature.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
