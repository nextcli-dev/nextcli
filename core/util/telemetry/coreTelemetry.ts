/**
 * OpenTelemetry metrics for core (the VS Code extension's backend), on the
 * same terms as the CLI's telemetry. Nothing is sent unless both hold:
 *
 * - the user opts in: "Allow Anonymous Telemetry" in User Settings
 *   (allowAnonymousTelemetry); in VS Code, the editor's own telemetry setting
 *   must be on too (doLoadConfig);
 * - an OTLP endpoint is set: OTEL_EXPORTER_OTLP_METRICS_ENDPOINT or
 *   OTEL_EXPORTER_OTLP_ENDPOINT (+ /v1/metrics).
 *
 * There is no default endpoint. Metrics go out as OTLP over HTTP with JSON.
 * Also read: OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_METRICS_HEADERS
 * (the latter wins per key), OTEL_METRIC_EXPORT_INTERVAL (milliseconds,
 * default 60000). Other OTEL_* variables, including the protocol ones, are
 * not read.
 *
 * Only metrics declared in CORE_METRICS are recorded, and only with the
 * attribute values declared there. Anything else is dropped here, so a caller
 * cannot send a path, URL, file name or text by mistake.
 */
import type { Attributes, Counter, Meter } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

export interface CoreTelemetrySettings {
  allowAnonymousTelemetry?: boolean;
  ideType?: string;
  extensionVersion?: string;
}

const METRIC_PREFIX = "nextcli_core_";
const DEFAULT_EXPORT_INTERVAL_MS = 60_000;

/**
 * Every counter core records (exported as nextcli_core_<name>), with each
 * attribute it may carry and that attribute's allowed values. Add a metric
 * here, and to docs/reference/telemetry.mdx, before recording it.
 */
export type MetricRegistry = Record<string, Record<string, readonly string[]>>;
export const CORE_METRICS: MetricRegistry = {};

/**
 * Whether telemetry may run: the user's opt-in ("Allow Anonymous Telemetry")
 * AND, in VS Code, the editor's own telemetry setting. Either one off is off.
 */
export async function isTelemetryAllowed(
  optIn: boolean | undefined,
  ideType: string | undefined,
  ide: { isTelemetryEnabled(): Promise<boolean> },
): Promise<boolean> {
  if (optIn !== true) {
    return false;
  }
  return ideType === "vscode"
    ? (await ide.isTelemetryEnabled()) === true
    : true;
}

/** The metrics URL from the OTLP variables, or undefined. */
export function otlpMetricsUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const metricsEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
  if (metricsEndpoint) {
    return metricsEndpoint;
  }
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? `${base.replace(/\/+$/, "")}/v1/metrics` : undefined;
}

/** Parses "key=value,key2=value2". A value that is not valid %-encoding is kept as is. */
export function parseOtlpHeaders(raw: string | undefined) {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!key || !value) {
      continue;
    }
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
}

export function otlpMetricsHeaders(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS),
  };
}

export function exportIntervalMs(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_EXPORT_INTERVAL_MS;
}

/**
 * The attributes of `attributes` that `metric` declares, with declared values.
 * Everything else is dropped.
 */
export function allowedAttributes(
  metric: Record<string, readonly string[]>,
  attributes: Attributes,
): Attributes {
  const allowed: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" && metric[key]?.includes(value)) {
      allowed[key] = value;
    }
  }
  return allowed;
}

export class CoreTelemetry {
  private provider?: MeterProvider;
  private meter?: Meter;
  private readonly counters = new Map<string, Counter>();
  private configuredKey?: string;
  // configure() and shutdown() run one at a time, in call order; a call that
  // a newer one has superseded is skipped.
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly warned = new Set<string>();

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly metrics: MetricRegistry = CORE_METRICS,
  ) {}

  get enabled() {
    return this.meter !== undefined;
  }

  /**
   * Applies the current settings. Called on every config load; starts, swaps
   * or stops the exporter only when the outcome changes.
   */
  configure(settings: CoreTelemetrySettings): Promise<void> {
    const generation = ++this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation) {
        return;
      }
      await this.apply(settings);
    });
  }

  /** Stops the exporter, sending what was recorded. */
  shutdown(): Promise<void> {
    ++this.generation;
    return this.enqueue(() => this.stop());
  }

  /** Adds to a counter. Does nothing while telemetry is off. */
  count(name: string, value = 1, attributes: Attributes = {}) {
    const meter = this.meter;
    if (!meter || !(value > 0)) {
      return;
    }
    const metric = Object.hasOwn(this.metrics, name)
      ? this.metrics[name]
      : undefined;
    if (!metric) {
      this.warnOnce(`Dropped telemetry metric not in CORE_METRICS: ${name}`);
      return;
    }
    const fullName = METRIC_PREFIX + name;
    let counter = this.counters.get(fullName);
    if (!counter) {
      counter = meter.createCounter(fullName);
      this.counters.set(fullName, counter);
    }
    counter.add(value, allowedAttributes(metric, attributes));
  }

  /** Sends what has been recorded so far. */
  async flush() {
    await this.provider?.forceFlush();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch((e) =>
      console.warn("Telemetry configuration failed", e),
    );
    return this.queue;
  }

  private async apply(settings: CoreTelemetrySettings) {
    const url =
      settings.allowAnonymousTelemetry === true
        ? otlpMetricsUrl(this.env)
        : undefined;
    const key = url
      ? JSON.stringify([
          url,
          settings.ideType,
          settings.extensionVersion,
          this.env.OTEL_EXPORTER_OTLP_HEADERS,
          this.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS,
          this.env.OTEL_METRIC_EXPORT_INTERVAL,
        ])
      : undefined;
    if (key === this.configuredKey) {
      return;
    }
    if (!url) {
      await this.stop();
      return;
    }

    // Build the new exporter before replacing the old one. If building
    // fails, telemetry stays off and the key is not recorded, so the next
    // config load tries again.
    let provider: MeterProvider;
    try {
      provider = new MeterProvider({
        resource: resourceFromAttributes({
          "service.name": "nextcli-core",
          ...(settings.extensionVersion
            ? { "service.version": settings.extensionVersion }
            : {}),
          ...(settings.ideType ? { "nextcli.ide": settings.ideType } : {}),
        }),
        readers: [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url,
              headers: otlpMetricsHeaders(this.env),
            }),
            exportIntervalMillis: exportIntervalMs(this.env),
          }),
        ],
      });
    } catch (e) {
      await this.stop();
      throw e;
    }
    await this.stop();
    this.provider = provider;
    this.meter = provider.getMeter("nextcli-core");
    this.configuredKey = key;
  }

  private async stop() {
    const provider = this.provider;
    this.provider = undefined;
    this.meter = undefined;
    this.counters.clear();
    this.configuredKey = undefined;
    await provider?.shutdown().catch(() => {});
  }

  private warnOnce(message: string) {
    if (!this.warned.has(message)) {
      this.warned.add(message);
      console.warn(message);
    }
  }
}

/** The process-wide instance core features record to. */
export const coreTelemetry = new CoreTelemetry();
