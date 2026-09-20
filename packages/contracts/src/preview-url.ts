export type PreviewUrlConfig = {
  baseDomain: string;
  scheme: "http" | "https";
  localPort?: number;
};

const DEFAULT_PREVIEW_BASE_DOMAIN = "preview.localhost";
const MAX_PREVIEW_BASE_DOMAIN_LENGTH = 208;

/**
 * Load the URL contract shared by the worker, API, dashboard, and GitHub
 * feedback path. The port is a local loopback Gateway detail; it never
 * changes the hostname used by the Kubernetes HTTPRoute.
 */
export function loadPreviewUrlConfig(
  environment: NodeJS.ProcessEnv,
  nodeEnv: string,
): PreviewUrlConfig {
  const baseDomain = environment.PREVIEW_BASE_DOMAIN?.trim() || DEFAULT_PREVIEW_BASE_DOMAIN;
  const schemeValue =
    environment.PREVIEW_URL_SCHEME?.trim() || (nodeEnv === "production" ? "https" : "http");
  if (schemeValue !== "http" && schemeValue !== "https") {
    throw new Error("Invalid preview URL configuration: PREVIEW_URL_SCHEME is invalid");
  }
  validateBaseDomain(baseDomain);

  const localPort = parseLocalPort(environment.PREVIEWFORGE_GATEWAY_LOCAL_PORT);
  if (nodeEnv === "production") {
    if (schemeValue !== "https" || isLocalDomain(baseDomain) || localPort !== undefined) {
      throw new Error(
        "Invalid preview URL configuration: production preview URLs require a public HTTPS domain without a local port",
      );
    }
  } else if (localPort !== undefined && schemeValue !== "http") {
    throw new Error(
      "Invalid preview URL configuration: a local Gateway port requires HTTP preview URLs",
    );
  }

  return {
    baseDomain: baseDomain.toLowerCase(),
    scheme: schemeValue,
    ...(localPort === undefined ? {} : { localPort }),
  };
}

export function previewHostname(environmentId: string, baseDomain: string): string {
  if (!isUuid(environmentId)) throw new Error("environmentId must be a UUID");
  validateBaseDomain(baseDomain);
  return `preview-${environmentId.toLowerCase()}.${baseDomain.toLowerCase()}`;
}

export function previewUrl(environmentId: string, config: PreviewUrlConfig): string {
  const port = config.localPort === undefined ? "" : `:${config.localPort}`;
  return `${config.scheme}://${previewHostname(environmentId, config.baseDomain)}${port}/`;
}

function parseLocalPort(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(
      "Invalid preview URL configuration: PREVIEWFORGE_GATEWAY_LOCAL_PORT is invalid",
    );
  }
  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "Invalid preview URL configuration: PREVIEWFORGE_GATEWAY_LOCAL_PORT is invalid",
    );
  }
  return port;
}

function validateBaseDomain(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_PREVIEW_BASE_DOMAIN_LENGTH ||
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
    throw new Error("Invalid preview URL configuration: PREVIEW_BASE_DOMAIN is invalid");
  }
}

function isLocalDomain(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "127.0.0.1"
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
