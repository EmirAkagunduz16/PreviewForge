export type PreviewUrlConfig = {
  baseDomain: string;
  scheme: "http" | "https";
};

const DEFAULT_PREVIEW_BASE_DOMAIN = "previewforge.local";

export function loadPreviewUrlConfig(
  environment: NodeJS.ProcessEnv,
  nodeEnv: string,
): PreviewUrlConfig {
  const baseDomain = environment.PREVIEW_BASE_DOMAIN?.trim() || DEFAULT_PREVIEW_BASE_DOMAIN;
  const schemeValue =
    environment.PREVIEW_URL_SCHEME?.trim() || (nodeEnv === "production" ? "https" : "http");
  if (schemeValue !== "http" && schemeValue !== "https") {
    throw new Error("Invalid worker configuration: PREVIEW_URL_SCHEME is invalid");
  }
  validateBaseDomain(baseDomain);
  if (nodeEnv === "production" && (schemeValue !== "https" || isLocalDomain(baseDomain))) {
    throw new Error(
      "Invalid worker configuration: production preview URLs require a public HTTPS domain",
    );
  }
  return { baseDomain: baseDomain.toLowerCase(), scheme: schemeValue };
}

export function previewHostname(environmentId: string, baseDomain: string): string {
  if (!isUuid(environmentId)) throw new Error("environmentId must be a UUID");
  validateBaseDomain(baseDomain);
  return `preview-${environmentId.toLowerCase()}.${baseDomain.toLowerCase()}`;
}

export function previewUrl(environmentId: string, config: PreviewUrlConfig): string {
  return `${config.scheme}://${previewHostname(environmentId, config.baseDomain)}/`;
}

function validateBaseDomain(value: string): void {
  if (
    value.length === 0 ||
    value.length > 253 ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.includes("..") ||
    !/^[A-Za-z0-9.-]+$/.test(value) ||
    value
      .split(".")
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
      )
  ) {
    throw new Error("Invalid worker configuration: PREVIEW_BASE_DOMAIN is invalid");
  }
}

function isLocalDomain(value: string): boolean {
  return value === "localhost" || value.endsWith(".localhost") || value === "127.0.0.1";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
