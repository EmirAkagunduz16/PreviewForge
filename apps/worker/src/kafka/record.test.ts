import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeKafkaValue,
  inspectKafkaRecord,
  KAFKA_EVENT_ID_HEADER,
  readKafkaHeader,
} from "./record.js";

describe("Kafka record boundary helpers", () => {
  it("reads valid headers and rejects missing/empty headers", () => {
    expect(
      readKafkaHeader({ [KAFKA_EVENT_ID_HEADER]: Buffer.from("event-1") }, KAFKA_EVENT_ID_HEADER),
    ).toEqual({
      ok: true,
      value: "event-1",
    });
    expect(readKafkaHeader({}, KAFKA_EVENT_ID_HEADER)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(
      readKafkaHeader({ [KAFKA_EVENT_ID_HEADER]: Buffer.alloc(0) }, KAFKA_EVENT_ID_HEADER),
    ).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      readKafkaHeader({ [KAFKA_EVENT_ID_HEADER]: ["event-1", "event-2"] }, KAFKA_EVENT_ID_HEADER),
    ).toEqual({ ok: false, reason: "multiple" });
  });

  it("fails closed on invalid UTF-8 without returning the raw header", () => {
    const result = readKafkaHeader(
      { [KAFKA_EVENT_ID_HEADER]: Buffer.from([0xc3, 0x28]) },
      KAFKA_EVENT_ID_HEADER,
    );
    expect(result).toEqual({ ok: false, reason: "invalid-utf8" });
    expect(JSON.stringify(result)).not.toContain("c3");
  });

  it("decodes valid JSON while exposing only a digest for invalid values", () => {
    const validPayload = Buffer.from('{"eventId":"event-1"}');
    expect(decodeKafkaValue(validPayload)).toEqual({
      ok: true,
      value: { eventId: "event-1" },
      payloadSha256: createHash("sha256").update(validPayload).digest("hex"),
    });

    const invalidPayload = Buffer.from("not-json-secret-token");
    const result = decodeKafkaValue(invalidPayload);
    expect(result).toEqual({
      ok: false,
      payloadSha256: createHash("sha256").update(invalidPayload).digest("hex"),
      reason: "invalid-json",
    });
    expect(JSON.stringify(result)).not.toContain(invalidPayload.toString("utf8"));
  });

  it("assigns tombstones a deterministic digest without returning a raw value", () => {
    const first = decodeKafkaValue(null);
    const second = decodeKafkaValue(null);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: false,
      reason: "missing-value",
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(first)).not.toContain("<missing-kafka-value>");
  });

  it("returns stable metadata and no raw value for an invalid record", () => {
    const record = inspectKafkaRecord({
      key: Buffer.from("environment-1"),
      headers: {
        "event-id": "event-1",
        "event-type": "deployment.requested.v1",
      },
      value: Buffer.from([0xff, 0xfe]),
    });

    expect(record.key).toEqual({ ok: true, value: "environment-1" });
    expect(record.eventId).toEqual({ ok: true, value: "event-1" });
    expect(record.eventType).toEqual({ ok: true, value: "deployment.requested.v1" });
    expect(record.value.ok).toBe(false);
    expect(JSON.stringify(record)).not.toContain("ff");
  });
});
