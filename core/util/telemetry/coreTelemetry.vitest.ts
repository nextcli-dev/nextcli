import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  CoreTelemetry,
  exportIntervalMs,
  otlpMetricsHeaders,
  otlpMetricsUrl,
  parseOtlpHeaders,
  allowedAttributes,
  CORE_METRICS,
  type MetricRegistry,
} from "./coreTelemetry";

// Tests record to their own registry; CORE_METRICS lists core's real metrics
const TEST_METRICS: MetricRegistry = {
  docs_backup_sites: { outcome: ["copied", "no_source", "failed", "skipped"] },
};

describe("OTLP settings", () => {
  it("prefers the metrics endpoint and appends /v1/metrics to the base", () => {
    expect(otlpMetricsUrl({})).toBeUndefined();
    expect(
      otlpMetricsUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example/" }),
    ).toBe("https://otel.example/v1/metrics");
    expect(
      otlpMetricsUrl({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.example/ingest",
      }),
    ).toBe("https://metrics.example/ingest");
  });

  it("parses headers, keeps '=' in values, and keeps bad %-encoding as is", () => {
    expect(
      parseOtlpHeaders(
        "Authorization=Bearer%20abc==,x-team = core ,broken,=nokey",
      ),
    ).toEqual({ Authorization: "Bearer abc==", "x-team": "core" });
    expect(parseOtlpHeaders("x-bad=%E0%A4%A")).toEqual({ "x-bad": "%E0%A4%A" });
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });

  it("lets metrics headers override the general ones", () => {
    expect(
      otlpMetricsHeaders({
        OTEL_EXPORTER_OTLP_HEADERS: "a=1,b=2",
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: "b=3",
      }),
    ).toEqual({ a: "1", b: "3" });
  });

  it("reads the export interval, defaulting to a minute", () => {
    expect(exportIntervalMs({})).toBe(60_000);
    expect(exportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: "5000" })).toBe(
      5000,
    );
    expect(exportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: "soon" })).toBe(
      60_000,
    );
  });

  it("keeps only declared attributes with declared values", () => {
    const metric = TEST_METRICS.docs_backup_sites;
    expect(allowedAttributes(metric, { outcome: "copied" })).toEqual({
      outcome: "copied",
    });
    // Identifier-like values that are not declared are dropped too
    for (const value of [".env", "secret.ts", "id_rsa", "gpt-4o-mini"]) {
      expect(allowedAttributes(metric, { outcome: value })).toEqual({});
    }
    expect(
      allowedAttributes(metric, {
        path: "/Users/me/secret.ts",
        url: "https://docs.example.com/page",
        count: 3,
      }),
    ).toEqual({});
  });

  it("records nothing on main until a metric is declared", () => {
    expect(CORE_METRICS).toEqual({});
  });
});

describe("CoreTelemetry", () => {
  const bodies: {
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }[] = [];
  let server: http.Server;
  let endpoint: string;
  const instances: CoreTelemetry[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        bodies.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((t) => t.shutdown()));
    bodies.length = 0;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  function telemetry(env: NodeJS.ProcessEnv) {
    const t = new CoreTelemetry(env, TEST_METRICS);
    instances.push(t);
    return t;
  }

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("sends counters with the resource attributes and auth header when allowed", async () => {
    const t = telemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer test-token",
    });
    await t.configure({
      allowAnonymousTelemetry: true,
      ideType: "test-ide",
      extensionVersion: "9.9.9-test",
    });
    expect(t.enabled).toBe(true);

    t.count("docs_backup_sites", 2, { outcome: "copied" });
    await t.flush();

    expect(bodies).toHaveLength(1);
    expect(bodies[0].url).toBe("/v1/metrics");
    expect(bodies[0].headers.authorization).toBe("Bearer test-token");
    const payload = JSON.parse(bodies[0].body);
    const resource = Object.fromEntries(
      payload.resourceMetrics[0].resource.attributes.map((a: any) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(resource).toMatchObject({
      "service.name": "nextcli-core",
      "service.version": "9.9.9-test",
      "nextcli.ide": "test-ide",
    });
    const metric = payload.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.name).toBe("nextcli_core_docs_backup_sites");
    const point = metric.sum.dataPoints[0];
    expect(point.asInt ?? point.asDouble).toBe(2);
    expect(point.attributes).toEqual([
      { key: "outcome", value: { stringValue: "copied" } },
    ]);
  });

  it("sends nothing unless anonymous telemetry is allowed", async () => {
    for (const allowAnonymousTelemetry of [undefined, false]) {
      const t = telemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
      await t.configure({ allowAnonymousTelemetry });
      expect(t.enabled).toBe(false);
      t.count("docs_backup_sites");
      await t.flush();
    }
    expect(bodies).toHaveLength(0);
  });

  it("has no default endpoint: allowed but unconfigured sends nothing", async () => {
    const t = telemetry({});
    await t.configure({ allowAnonymousTelemetry: true });
    expect(t.enabled).toBe(false);
    t.count("docs_backup_sites");
    await t.flush();
    expect(bodies).toHaveLength(0);
  });

  it("leaves no exporter running after overlapping configure calls and an opt-out", async () => {
    const t = telemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_METRIC_EXPORT_INTERVAL: "50",
    });
    // Config reloads can overlap; neither call is awaited before the next
    const first = t.configure({
      allowAnonymousTelemetry: true,
      extensionVersion: "1",
    });
    const second = t.configure({
      allowAnonymousTelemetry: true,
      extensionVersion: "2",
    });
    await Promise.all([first, second]);
    t.count("docs_backup_sites");
    await sleep(150);
    expect(bodies.length).toBeGreaterThan(0);

    await t.configure({ allowAnonymousTelemetry: false });
    expect(t.enabled).toBe(false);
    const sent = bodies.length;
    await sleep(300); // six export intervals
    expect(bodies.length).toBe(sent);
  });

  it("stops when the user opts out, and retries after a failed start", async () => {
    const t = telemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    await t.configure({ allowAnonymousTelemetry: true });
    expect(t.enabled).toBe(true);
    await t.configure({ allowAnonymousTelemetry: false });
    expect(t.enabled).toBe(false);
    t.count("docs_backup_sites");
    await t.flush();
    expect(bodies).toHaveLength(0);

    // A start that throws leaves telemetry off and is retried next time
    const failing = telemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await failing.configure({ allowAnonymousTelemetry: true });
    warn.mockRestore();
    expect(failing.enabled).toBe(false);
  });

  it("does nothing, and never throws, for any name while off", () => {
    const t = telemetry({});
    expect(() => t.count("Docs-Backup")).not.toThrow();
    expect(() =>
      t.count("docs_backup_sites", 1, { path: "/etc/passwd" }),
    ).not.toThrow();
  });

  it("drops a metric that is not declared, with one warning, while on", async () => {
    const t = telemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    await t.configure({ allowAnonymousTelemetry: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    t.count("chat_messages");
    t.count("chat_messages");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    await t.flush();
    expect(bodies).toHaveLength(0);
  });
});
