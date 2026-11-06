import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CoreTelemetry,
  otlpMetricsUrl,
  parseOtlpHeaders,
} from "./coreTelemetry";

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

  it("parses headers, keeping '=' in values and decoding them", () => {
    expect(
      parseOtlpHeaders(
        "Authorization=Bearer%20abc==,x-team = core ,broken,=nokey",
      ),
    ).toEqual({ Authorization: "Bearer abc==", "x-team": "core" });
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });
});

describe("CoreTelemetry", () => {
  const requests: {
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
        requests.push({ url: req.url, headers: req.headers, body });
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
    requests.length = 0;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  function telemetry(env: NodeJS.ProcessEnv) {
    const t = new CoreTelemetry(env);
    instances.push(t);
    return t;
  }

  it("sends counters to the configured endpoint when allowed", async () => {
    const t = telemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer test-token",
    });
    await t.configure({
      allowAnonymousTelemetry: true,
      ideType: "vscode",
      extensionVersion: "1.8.0",
    });
    expect(t.enabled).toBe(true);

    t.count("docs_backup_sites", 2, { outcome: "copied" });
    await t.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/v1/metrics");
    expect(requests[0].headers.authorization).toBe("Bearer test-token");
    const body = requests[0].body;
    expect(body).toContain("nextcli_core_docs_backup_sites");
    expect(body).toContain("nextcli-core");
    expect(body).toContain("copied");
  });

  it("sends nothing unless anonymous telemetry is allowed", async () => {
    for (const allowAnonymousTelemetry of [undefined, false]) {
      const t = telemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
      await t.configure({ allowAnonymousTelemetry });
      expect(t.enabled).toBe(false);
      t.count("docs_backup_sites");
      await t.flush();
    }
    expect(requests).toHaveLength(0);
  });

  it("has no default endpoint: allowed but unconfigured sends nothing", async () => {
    const t = telemetry({});
    await t.configure({ allowAnonymousTelemetry: true });
    expect(t.enabled).toBe(false);
    t.count("docs_backup_sites");
    await t.flush();
    expect(requests).toHaveLength(0);
  });

  it("stops when the user turns telemetry off", async () => {
    const t = telemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    await t.configure({ allowAnonymousTelemetry: true });
    expect(t.enabled).toBe(true);
    await t.configure({ allowAnonymousTelemetry: false });
    expect(t.enabled).toBe(false);
    t.count("docs_backup_sites");
    await t.flush();
    expect(requests.every((r) => !r.body.includes("docs_backup_sites"))).toBe(
      true,
    );
  });

  it("rejects metric names outside lowercase_with_underscores", () => {
    const t = telemetry({});
    expect(() => t.count("Docs-Backup")).toThrow(
      /Invalid telemetry metric name/,
    );
  });
});
