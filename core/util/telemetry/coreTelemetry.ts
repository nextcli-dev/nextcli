/**
 * OpenTelemetry metrics for core (the VS Code extension's backend and the
 * CLI's shared engine), on the same terms as the CLI's telemetry:
 *
 * - Off unless the user allows anonymous telemetry (`allowAnonymousTelemetry:
 *   true`; in VS Code, the editor's telemetry setting must be on too), AND
 * - an OTLP endpoint is configured with the standard OpenTelemetry variables
 *   (OTEL_EXPORTER_OTLP_METRICS_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT, and
 *   OTEL_EXPORTER_OTLP_HEADERS for auth).
 *
 * There is no default endpoint: with nothing configured, no exporter is
 * created and nothing is sent. Metrics are counters with low-cardinality
 * attributes; they carry no user, file, URL or content data.
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
const EXPORT_INTERVAL_MS = 60_000;

/** The metrics URL from the standard OTLP variables, or undefined. */
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

/** Parses OTEL_EXPORTER_OTLP_HEADERS ("key=value,key2=value2"). */
export function parseOtlpHeaders(raw: string | undefined) {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key && value) {
      headers[key] = decodeURIComponent(value);
    }
  }
  return headers;
}

/** Metric names are lowercase words joined by underscores. */
function metricName(name: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid telemetry metric name: ${name}`);
  }
  return METRIC_PREFIX + name;
}

export class CoreTelemetry {
  private provider?: MeterProvider;
  private meter?: Meter;
  private readonly counters = new Map<string, Counter>();
  private configuredKey?: string;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get enabled() {
    return this.meter !== undefined;
  }

  /**
   * Applies the current settings. Called on every config load; starts or
   * stops the exporter only when the outcome changes.
   */
  async configure(settings: CoreTelemetrySettings) {
    const url =
      settings.allowAnonymousTelemetry === true
        ? otlpMetricsUrl(this.env)
        : undefined;
    const key = url
      ? JSON.stringify([url, settings.ideType, settings.extensionVersion])
      : undefined;
    if (key === this.configuredKey) {
      return;
    }
    await this.shutdown();
    this.configuredKey = key;
    if (!url) {
      return;
    }

    this.provider = new MeterProvider({
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
            headers: parseOtlpHeaders(this.env.OTEL_EXPORTER_OTLP_HEADERS),
          }),
          exportIntervalMillis: EXPORT_INTERVAL_MS,
        }),
      ],
    });
    this.meter = this.provider.getMeter("nextcli-core");
  }

  /** Adds to a counter. Does nothing while telemetry is off. */
  count(name: string, value = 1, attributes: Attributes = {}) {
    const fullName = metricName(name);
    if (!this.meter || value <= 0) {
      return;
    }
    let counter = this.counters.get(fullName);
    if (!counter) {
      counter = this.meter.createCounter(fullName);
      this.counters.set(fullName, counter);
    }
    counter.add(value, attributes);
  }

  /** Sends what has been recorded so far. */
  async flush() {
    await this.provider?.forceFlush();
  }

  async shutdown() {
    const provider = this.provider;
    this.provider = undefined;
    this.meter = undefined;
    this.counters.clear();
    this.configuredKey = undefined;
    await provider?.shutdown().catch(() => {});
  }
}

/** The process-wide instance core features record to. */
export const coreTelemetry = new CoreTelemetry();
