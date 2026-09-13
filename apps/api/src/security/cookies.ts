export type CookieOptions = {
  httpOnly: boolean;
  maxAge: number;
  path: string;
  sameSite: "lax";
  secure: boolean;
};

export function bindingCookieOptions(ttlSeconds: number, publicBaseUrl: string): CookieOptions {
  return {
    httpOnly: true,
    maxAge: ttlSeconds,
    path: "/",
    sameSite: "lax",
    secure: new URL(publicBaseUrl).protocol === "https:",
  };
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const safeName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name);
  if (!safeName || /[\r\n]/.test(value)) {
    throw new Error("Invalid cookie");
  }
  const encodedValue = encodeURIComponent(value);
  return [
    `${name}=${encodedValue}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    `Path=${options.path}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name && rest.length > 0) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return undefined;
}
