import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResourceMonitoringService } from "./ResourceMonitoringService.js";

const isLevelEnabled = vi.hoisted(() => vi.fn(() => false));

// Mock the logger and BaseService
vi.mock("../util/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    isLevelEnabled,
  },
}));

vi.mock("./BaseService.js", () => ({
  BaseService: class MockBaseService {
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  },
}));

describe("ResourceMonitoringService", () => {
  let service: ResourceMonitoringService;

  beforeEach(async () => {
    // Remove process event listeners to prevent interference
    process.removeAllListeners("exit");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");

    service = new ResourceMonitoringService();
    await service.initialize();
  });

  afterEach(async () => {
    if (service) {
      service.stopMonitoring(); // Ensure monitoring is stopped
      await service.cleanup();
    }
  });

  it("should initialize without starting monitoring by default", () => {
    expect((service as any).isMonitoring).toBe(false);
    const usage = service.getCurrentResourceUsage();
    expect(usage.timestamp).toBeGreaterThan(0);
  });

  it("should collect current resource usage", () => {
    const usage = service.getCurrentResourceUsage();

    expect(usage.timestamp).toBeGreaterThan(0);
    expect(usage.memory.rss).toBeGreaterThan(0);
    expect(usage.memory.heapTotal).toBeGreaterThan(0);
    expect(usage.memory.heapUsed).toBeGreaterThan(0);
    expect(usage.cpu.user).toBeGreaterThanOrEqual(0);
    expect(usage.cpu.system).toBeGreaterThanOrEqual(0);
    expect(usage.system.uptime).toBeGreaterThan(0);
    expect(usage.system.totalMemory).toBeGreaterThan(0);
    expect(usage.eventLoop.lag).toBeGreaterThanOrEqual(0);
  });

  it("should provide resource summary", () => {
    const summary = service.getResourceSummary();

    expect(summary.current).toBeDefined();
    expect(summary.peak).toBeDefined();
    expect(summary.average).toBeDefined();

    expect(summary.peak.memory).toBeGreaterThan(0);
    expect(summary.peak.cpu).toBeGreaterThanOrEqual(0);

    expect(summary.average.memory).toBeGreaterThan(0);
    expect(summary.average.cpu).toBeGreaterThanOrEqual(0);
  });

  it("should start and stop monitoring", async () => {
    service.startMonitoring(100); // 100ms interval for test

    // Wait for some data collection
    await new Promise((resolve) => setTimeout(resolve, 250));

    const history = service.getResourceHistory();
    expect(history.length).toBeGreaterThan(0);

    service.stopMonitoring();
  });

  it("starts monitoring at the debug log level (--verbose)", async () => {
    isLevelEnabled.mockReturnValueOnce(true);

    const verboseService = new ResourceMonitoringService();
    await verboseService.initialize();

    expect((verboseService as any).isMonitoring).toBe(true);
    verboseService.stopMonitoring();
    await verboseService.cleanup();
  });
});
