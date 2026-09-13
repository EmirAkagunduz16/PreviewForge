import { createHash } from "node:crypto";
import type { IHeaders, KafkaMessage } from "kafkajs";

export type HeaderReadResult =
  | { ok: true; value: string }
  | { ok: false; reason: "missing" | "invalid-utf8" | "empty" | "multiple" };

export type KafkaValueResult =
  | { ok: true; value: unknown; payloadSha256: string }
  | {
      ok: false;
      payloadSha256: string;
      reason: "missing-value" | "invalid-utf8" | "invalid-json";
    };

export type SafeKafkaRecord = {
  key: HeaderReadResult;
  eventId: HeaderReadResult;
  eventType: HeaderReadResult;
  value: KafkaValueResult;
};

export const KAFKA_EVENT_ID_HEADER = "event-id";
export const KAFKA_EVENT_TYPE_HEADER = "event-type";
const MISSING_VALUE_SENTINEL = Buffer.from("<missing-kafka-value>", "utf8");

/**
 * Decode a Kafka header with fatal UTF-8 semantics. Invalid bytes are never
 * returned to callers, which prevents accidental logging or persistence of
 * untrusted raw data.
 */
export function readKafkaHeader(headers: IHeaders | undefined, name: string): HeaderReadResult {
  if (headers === undefined || !(name in headers)) {
    return { ok: false, reason: "missing" };
  }

  const raw = headers[name];
  if (raw === undefined) return { ok: false, reason: "missing" };
  if (Array.isArray(raw) && raw.length !== 1) {
    return { ok: false, reason: "multiple" };
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return { ok: false, reason: "missing" };

  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "invalid-utf8" };
  }

  return decoded.length > 0 ? { ok: true, value: decoded } : { ok: false, reason: "empty" };
}

export function decodeKafkaValue(value: Buffer | null): KafkaValueResult {
  if (value === null) {
    return {
      ok: false,
      payloadSha256: sha256(MISSING_VALUE_SENTINEL),
      reason: "missing-value",
    };
  }

  const payloadSha256 = sha256(value);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return { ok: false, payloadSha256, reason: "invalid-utf8" };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown, payloadSha256 };
  } catch {
    return { ok: false, payloadSha256, reason: "invalid-json" };
  }
}

/** Extract only stable, safe boundary metadata; never return raw invalid data. */
export function inspectKafkaRecord(
  record: Pick<KafkaMessage, "key" | "headers" | "value">,
): SafeKafkaRecord {
  return {
    key: readKafkaBytes(record.key),
    eventId: readKafkaHeader(record.headers, KAFKA_EVENT_ID_HEADER),
    eventType: readKafkaHeader(record.headers, KAFKA_EVENT_TYPE_HEADER),
    value: decodeKafkaValue(record.value),
  };
}

function readKafkaBytes(value: Buffer | null): HeaderReadResult {
  if (value === null) return { ok: false, reason: "missing" };
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return { ok: false, reason: "invalid-utf8" };
  }
  return decoded.length > 0 ? { ok: true, value: decoded } : { ok: false, reason: "empty" };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
