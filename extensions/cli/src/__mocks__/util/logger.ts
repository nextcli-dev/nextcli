import { vi } from "vitest";

export const logger: any = {
  trace: vi.fn(),
  debug: vi.fn(),
  verbose: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn((): any => logger),
  isLevelEnabled: vi.fn(() => false),
};
export const getLogPath = vi.fn(() => "/mock/log/path");
export const getSessionId = vi.fn(() => "mock-session-id");
