import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const TRACEPARENT_HEADER = "traceparent";
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

const SAFE_LABEL_NAMES = new Set([
  "method",
  "route",
  "status_code",
  "stage",
  "outcome",
  "retry_class",
  "topic",
  "consumer",
  "error_code",
]);

const SAFE_ATTRIBUTE_NAMES = new Set([
  "error.code",
  "error.type",
  "http.method",
  "http.route",
  "http.status_code",
  "messaging.destination",
  "messaging.operation",
  "messaging.system",
  "previewforge.outcome",
  "previewforge.retry_class",
  "previewforge.stage",
  "service.name",
]);

const HISTOGRAM_BUCKETS = [5, 25, 100, 500, 1_000, 5_000, 30_000] as const;
const MAX_TRACE_RECORDS = 2_000;
const MAX_METRIC_SERIES = 10_000;

export type MetricValue = string | number | boolean;
export type MetricLabels = Readonly<Record<string, MetricValue>>;
export type SpanAttributes = Readonly<Record<string, MetricValue>>;

export type TraceContext = {
  traceId: string;
  spanId: string;
  traceparent: string;
};

export type TraceRecord = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, MetricValue>;
  status: "ok" | "error" | "unset";
};

type MetricDefinition = {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  labelNames: readonly string[];
};

type MetricSeries = {
  definition: MetricDefinition;
  labels: Readonly<Record<string, string>>;
  value: number;
  histogram?: {
    buckets: number[];
    sum: number;
    count: number;
  };
};

const activeTraceStorage = new AsyncLocalStorage<TraceContext>();

export function isValidTraceparent(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match) return false;
  return match[1] !== ZERO_TRACE_ID && match[2] !== ZERO_SPAN_ID;
}

export function parseTraceparent(value: unknown): TraceContext | undefined {
  if (!isValidTraceparent(value)) return undefined;
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match) return undefined;
  const traceId = match[1];
  const spanId = match[2];
  if (traceId === undefined || spanId === undefined) return undefined;
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceparent: value.toLowerCase(),
  };
}

export function activeTraceparent(): string | undefined {
  return activeTraceStorage.getStore()?.traceparent;
}

export class MetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly series = new Map<string, MetricSeries>();

  defineCounter(name: string, help: string, labelNames: readonly string[] = []): void {
    this.define({ name, help, type: "counter", labelNames });
  }

  defineGauge(name: string, help: string, labelNames: readonly string[] = []): void {
    this.define({ name, help, type: "gauge", labelNames });
  }

  defineHistogram(name: string, help: string, labelNames: readonly string[] = []): void {
    this.define({ name, help, type: "histogram", labelNames });
  }

  increment(name: string, labels: MetricLabels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("metric increment must be finite");
    const series = this.getSeries(name, labels);
    if (series.definition.type === "histogram") {
      throw new Error(`metric ${name} is a histogram`);
    }
    series.value += amount;
  }

  set(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value)) throw new Error("metric gauge must be finite");
    const series = this.getSeries(name, labels);
    if (series.definition.type !== "gauge") throw new Error(`metric ${name} is not a gauge`);
    series.value = value;
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value) || value < 0) throw new Error("metric observation must be finite");
    const series = this.getSeries(name, labels);
    if (series.definition.type !== "histogram") {
      throw new Error(`metric ${name} is not a histogram`);
    }
    const histogram = series.histogram;
    if (!histogram) throw new Error(`metric ${name} has no histogram storage`);
    histogram.sum += value;
    histogram.count += 1;
    for (let index = 0; index < HISTOGRAM_BUCKETS.length; index += 1) {
      const bucket = HISTOGRAM_BUCKETS[index];
      const count = histogram.buckets[index];
      if (bucket !== undefined && count !== undefined && value <= bucket) {
        histogram.buckets[index] = count + 1;
      }
    }
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const definition of this.definitions.values()) {
      lines.push(`# HELP ${definition.name} ${escapeHelp(definition.help)}`);
      lines.push(`# TYPE ${definition.name} ${definition.type}`);
      const values = [...this.series.values()].filter(
        (series) => series.definition.name === definition.name,
      );
      if (values.length === 0 && definition.type !== "histogram") {
        lines.push(`${definition.name} 0`);
      }
      for (const series of values) {
        const labels = renderLabels(series.labels);
        if (definition.type !== "histogram") {
          lines.push(`${definition.name}${labels} ${formatNumber(series.value)}`);
          continue;
        }
        const histogram = series.histogram;
        if (!histogram) continue;
        for (let index = 0; index < HISTOGRAM_BUCKETS.length; index += 1) {
          lines.push(
            `${definition.name}_bucket${renderLabels({ ...series.labels, le: String(HISTOGRAM_BUCKETS[index]) })} ${histogram.buckets[index]}`,
          );
        }
        lines.push(
          `${definition.name}_bucket${renderLabels({ ...series.labels, le: "+Inf" })} ${histogram.count}`,
        );
        lines.push(`${definition.name}_sum${labels} ${formatNumber(histogram.sum)}`);
        lines.push(`${definition.name}_count${labels} ${histogram.count}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  snapshot(): readonly MetricSeries[] {
    return [...this.series.values()].map((series) => ({
      ...series,
      labels: { ...series.labels },
      ...(series.histogram === undefined
        ? {}
        : { histogram: { ...series.histogram, buckets: [...series.histogram.buckets] } }),
    }));
  }

  private define(definition: MetricDefinition): void {
    if (!/^previewforge_[a-z][a-z0-9_]*$/u.test(definition.name)) {
      throw new Error(`metric name is outside the PreviewForge namespace: ${definition.name}`);
    }
    if (definition.labelNames.some((name) => !SAFE_LABEL_NAMES.has(name))) {
      throw new Error(`metric labels are outside the bounded allow-list: ${definition.name}`);
    }
    const previous = this.definitions.get(definition.name);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(definition)) {
        throw new Error(`metric ${definition.name} was defined with different metadata`);
      }
      return;
    }
    this.definitions.set(definition.name, definition);
  }

  private getSeries(name: string, labels: MetricLabels): MetricSeries {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`metric ${name} is not defined`);
    const normalized = normalizeLabels(definition, labels);
    const key = `${name}|${JSON.stringify(normalized)}`;
    let series = this.series.get(key);
    if (!series) {
      if (this.series.size >= MAX_METRIC_SERIES) throw new Error("metric series limit exceeded");
      series = {
        definition,
        labels: normalized,
        value: 0,
        ...(definition.type === "histogram"
          ? {
              histogram: {
                buckets: HISTOGRAM_BUCKETS.map(() => 0),
                sum: 0,
                count: 0,
              },
            }
          : {}),
      };
      this.series.set(key, series);
    }
    return series;
  }
}

export class PreviewForgeTelemetry {
  readonly metrics = new MetricsRegistry();
  readonly serviceName: string;
  private readonly traces: TraceRecord[] = [];
  private readonly otlpEndpoint: string | undefined;

  constructor(serviceName: string, options: { otlpEndpoint?: string } = {}) {
    if (!/^[a-z][a-z0-9-]{1,63}$/u.test(serviceName)) {
      throw new Error("service name is invalid");
    }
    this.serviceName = serviceName;
    this.otlpEndpoint = normalizeOtlpEndpoint(options.otlpEndpoint);
    defineCommonMetrics(this.metrics);
  }

  startSpan(
    name: string,
    parent?: string | TraceContext,
    attributes: SpanAttributes = {},
  ): PreviewForgeSpan {
    const parentContext =
      typeof parent === "string"
        ? parseTraceparent(parent)
        : (parent ?? activeTraceStorage.getStore());
    const traceId = parentContext?.traceId ?? randomHex(16);
    const spanId = randomHex(8);
    const context: TraceContext = {
      traceId,
      spanId,
      traceparent: `00-${traceId}-${spanId}-01`,
    };
    return new PreviewForgeSpan(this, context, parentContext?.spanId, name, attributes);
  }

  runWithContext<T>(context: TraceContext, callback: () => T): T {
    return activeTraceStorage.run(context, callback);
  }

  getTraceRecords(): readonly TraceRecord[] {
    return this.traces.map((record) => ({
      ...record,
      attributes: { ...record.attributes },
    }));
  }

  renderTraces(): string {
    const spans = this.getTraceRecords();
    const resourceSpans = [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }],
        },
        scopeSpans: [
          {
            scope: { name: "@previewforge/observability", version: "0.0.0" },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
              name: span.name,
              kind: "SPAN_KIND_INTERNAL",
              startTimeUnixNano: span.startTimeUnixNano,
              endTimeUnixNano: span.endTimeUnixNano,
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value: scalarAttribute(value),
              })),
              status: { code: span.status === "error" ? "STATUS_CODE_ERROR" : "STATUS_CODE_OK" },
            })),
          },
        ],
      },
    ];
    return JSON.stringify({ resourceSpans, spans });
  }

  recordSpan(record: TraceRecord): void {
    this.traces.push(record);
    if (this.traces.length > MAX_TRACE_RECORDS)
      this.traces.splice(0, this.traces.length - MAX_TRACE_RECORDS);
    if (this.otlpEndpoint !== undefined) {
      void fetch(this.otlpEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: this.renderOtlpSpan(record),
      }).catch(() => undefined);
    }
  }

  private renderOtlpSpan(span: TraceRecord): string {
    return JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }],
          },
          scopeSpans: [
            {
              scope: { name: "@previewforge/observability", version: "0.0.0" },
              spans: [
                {
                  traceId: span.traceId,
                  spanId: span.spanId,
                  ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
                  name: span.name,
                  kind: "SPAN_KIND_INTERNAL",
                  startTimeUnixNano: span.startTimeUnixNano,
                  endTimeUnixNano: span.endTimeUnixNano,
                  attributes: Object.entries(span.attributes).map(([key, value]) => ({
                    key,
                    value: scalarAttribute(value),
                  })),
                  status: {
                    code: span.status === "error" ? "STATUS_CODE_ERROR" : "STATUS_CODE_OK",
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  }
}

export class PreviewForgeSpan {
  readonly context: TraceContext;
  private readonly startedAt = BigInt(Date.now()) * 1_000_000n;
  private readonly attributes: Record<string, MetricValue>;
  private ended = false;
  private status: TraceRecord["status"] = "unset";

  constructor(
    private readonly telemetry: PreviewForgeTelemetry,
    context: TraceContext,
    private readonly parentSpanId: string | undefined,
    private readonly name: string,
    attributes: SpanAttributes,
  ) {
    this.context = context;
    this.attributes = normalizeAttributes(attributes);
  }

  setAttribute(name: string, value: MetricValue): void {
    if (this.ended) return;
    const normalized = normalizeAttributes({ [name]: value });
    Object.assign(this.attributes, normalized);
  }

  setStatus(status: "ok" | "error"): void {
    if (!this.ended) this.status = status;
  }

  end(status: "ok" | "error" = "ok"): void {
    if (this.ended) return;
    this.ended = true;
    this.status = status;
    const endedAt = BigInt(Date.now()) * 1_000_000n;
    this.telemetry.recordSpan({
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      ...(this.parentSpanId === undefined ? {} : { parentSpanId: this.parentSpanId }),
      name: this.name,
      startTimeUnixNano: String(this.startedAt * 1_000n),
      endTimeUnixNano: String(endedAt * 1_000n),
      attributes: { ...this.attributes },
      status: this.status,
    });
    this.telemetry.metrics.increment("previewforge_trace_spans_total", {
      outcome: this.status === "error" ? "error" : "ok",
    });
  }
}

export type ObservabilityServer = {
  port: number;
  close: () => Promise<void>;
};

export async function startObservabilityServer(
  telemetry: PreviewForgeTelemetry,
  options: { host?: string; port: number },
): Promise<ObservabilityServer> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) =>
    handleObservabilityRequest(telemetry, request, response),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("observability server did not expose a TCP address");
  }
  return {
    port: address.port,
    close: () => closeServer(server),
  };
}

export function parseObservabilityPort(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must contain only digits`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${name} is outside the valid port range`);
  }
  return port;
}

function defineCommonMetrics(metrics: MetricsRegistry): void {
  metrics.defineCounter("previewforge_http_requests_total", "Completed HTTP requests", [
    "method",
    "route",
    "status_code",
  ]);
  metrics.defineHistogram(
    "previewforge_http_request_duration_ms",
    "HTTP request duration in milliseconds",
    ["method", "route", "status_code"],
  );
  metrics.defineCounter("previewforge_api_errors_total", "HTTP API errors", [
    "route",
    "status_code",
    "error_code",
  ]);
  metrics.defineCounter("previewforge_kafka_messages_total", "Kafka messages handled", [
    "topic",
    "consumer",
    "outcome",
  ]);
  metrics.defineHistogram(
    "previewforge_kafka_message_duration_ms",
    "Kafka message duration in milliseconds",
    ["topic", "consumer", "outcome"],
  );
  metrics.defineCounter("previewforge_outbox_batches_total", "Outbox relay batches", ["outcome"]);
  metrics.defineHistogram(
    "previewforge_deployment_stage_duration_ms",
    "Deployment stage duration in milliseconds",
    ["stage", "outcome"],
  );
  metrics.defineCounter(
    "previewforge_deployment_outcomes_total",
    "Deployment processing outcomes",
    ["outcome"],
  );
  metrics.defineCounter("previewforge_github_feedback_total", "GitHub feedback outcomes", [
    "outcome",
  ]);
  metrics.defineCounter("previewforge_cleanup_total", "Cleanup outcomes", ["outcome"]);
  metrics.defineCounter("previewforge_trace_spans_total", "Completed trace spans", ["outcome"]);
  metrics.defineGauge("previewforge_worker_health", "Worker process health");
}

function normalizeLabels(
  definition: MetricDefinition,
  labels: MetricLabels,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of definition.labelNames) {
    const value = labels[name];
    if (value === undefined) throw new Error(`metric ${definition.name} is missing label ${name}`);
    const text = String(value);
    if (text.length === 0 || text.length > 128 || /[\r\n"\\]/u.test(text)) {
      throw new Error(`metric label ${name} is invalid`);
    }
    result[name] = text;
  }
  for (const name of Object.keys(labels)) {
    if (!definition.labelNames.includes(name)) {
      throw new Error(`metric label ${name} is not declared for ${definition.name}`);
    }
  }
  return result;
}

function normalizeAttributes(attributes: SpanAttributes): Record<string, MetricValue> {
  const result: Record<string, MetricValue> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (!SAFE_ATTRIBUTE_NAMES.has(name)) throw new Error(`trace attribute ${name} is not allowed`);
    if (typeof value === "string" && (value.length === 0 || value.length > 256)) {
      throw new Error(`trace attribute ${name} is invalid`);
    }
    if (
      typeof value === "string" &&
      /(?:bearer\s+|gh[pors]_|github_pat_|(?:token|secret|password|api[_-]?key)\s*=)/iu.test(value)
    ) {
      throw new Error(`trace attribute ${name} contains sensitive material`);
    }
    result[name] = value;
  }
  return result;
}

function renderLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

function scalarAttribute(value: MetricValue): Record<string, string | number | boolean> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return { doubleValue: value };
}

function escapeHelp(value: string): string {
  return value.replace(/[\r\n]/gu, " ");
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\r\n]/gu, " ");
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function normalizeOtlpEndpoint(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const endpoint = value.trim().replace(/\/$/u, "");
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.pathname.endsWith("/v1/traces") ? endpoint : `${endpoint}/v1/traces`;
  } catch {
    return undefined;
  }
}

function handleObservabilityRequest(
  telemetry: PreviewForgeTelemetry,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const route = (request.url ?? "/").split("?", 1)[0] || "/";
  const span = telemetry.startSpan("http.server", undefined, {
    "http.method": request.method ?? "GET",
    "http.route": route,
  });
  const finish = (statusCode: number): void => {
    span.setAttribute("http.status_code", statusCode);
    span.end(statusCode >= 500 ? "error" : "ok");
    telemetry.metrics.increment("previewforge_http_requests_total", {
      method: request.method ?? "GET",
      route,
      status_code: statusCode,
    });
  };
  response.setHeader("cache-control", "no-store");
  if (request.url === "/metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    response.end(telemetry.metrics.renderPrometheus());
    finish(200);
    return;
  }
  if (request.url === "/traces") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(telemetry.renderTraces());
    finish(200);
    return;
  }
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ service: telemetry.serviceName, status: "ok" }));
    finish(200);
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
  finish(404);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
