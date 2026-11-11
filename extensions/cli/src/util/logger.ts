import crypto from "crypto";
import fs from "fs";
import path from "path";

import chalk from "chalk";
import winston from "winston";

import { env } from "../env.js";

import { BufferedFileTransport } from "./bufferedFileTransport.js";

const { combine, timestamp, printf, errors } = winston.format;

// One id per process, on every cn.log line and in the trace file name
const RUN_ID = crypto.randomBytes(4).toString("hex");

/** Log levels, most severe first. --verbose is debug. */
export const LOG_LEVELS = [
  "error",
  "warn",
  "info",
  "verbose",
  "debug",
  "trace",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  const level = value?.trim().toLowerCase();
  return LOG_LEVELS.find((known) => known === level);
}

/**
 * Warns about a bad environment variable on stderr as well as in cn.log, so a
 * low log level can't hide it.
 */
export function warnBadEnv(message: string): void {
  process.stderr.write(`Warning: ${message}\n`);
  winstonLogger.warn(message);
}

// Get log directory
function getLogDir(): string {
  const logDir = path.join(env.continueHome, "logs");

  // Create directory if it doesn't exist
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  return logDir;
}

// Get current log file path
function getLogFilePath(): string {
  const logDir = getLogDir();
  return path.join(logDir, "cn.log");
}

// Simple replacer for JSON.stringify to handle common issues
function createReplacer() {
  const seen = new Set();

  return (key: string, value: any) => {
    // Handle circular references
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }

    // Handle Error objects explicitly - extract useful properties
    if (value instanceof Error) {
      const errorObj: any = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
      if (value.cause) {
        errorObj.cause = value.cause;
      }
      return errorObj;
    }

    // Handle functions
    if (typeof value === "function") {
      return "[Function]";
    }

    // Handle undefined (which JSON.stringify skips by default)
    if (value === undefined) {
      return "[undefined]";
    }

    return value;
  };
}

// Custom format for log output
const logFormat = printf(
  ({ level, message, timestamp, stack, ...metadata }) => {
    let msg = `${timestamp} [${RUN_ID}] [${level}]: ${message}`;

    // Add metadata if present
    if (Object.keys(metadata).length > 0) {
      try {
        msg += ` ${JSON.stringify(metadata, createReplacer())}`;
      } catch (err) {
        // Fallback if stringify still fails somehow
        msg += ` [Failed to stringify metadata: ${err}]`;
      }
    }

    // Add stack trace for errors
    if (stack) {
      msg += `\n${stack}`;
    }

    return msg;
  },
);

// Track headless mode
let isHeadlessMode = false;
let isTTYlessEnvironment = false;

const envLevel = process.env.NEXTCLI_LOG_LEVEL;

const winstonLogger = winston.createLogger({
  levels: Object.fromEntries(LOG_LEVELS.map((level, index) => [level, index])),
  level: parseLogLevel(envLevel) ?? "info",
  format: combine(
    errors({ stack: true }),
    timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    logFormat,
  ),
  transports: [
    // File transport for all logs, flushed on exit so process.exit() can't
    // drop the end of a run
    new BufferedFileTransport({
      filename: getLogFilePath(),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
  ],
});

if (envLevel && !parseLogLevel(envLevel)) {
  warnBadEnv(
    `Unknown NEXTCLI_LOG_LEVEL "${envLevel}", using info. Use one of: ${LOG_LEVELS.join(", ")}.`,
  );
}

export function setLogLevel(level: LogLevel) {
  winstonLogger.level = level;
}

// Winston formats a line before its transport drops it by level, so check the
// level first: a disabled level then costs one comparison.
function logAt(level: LogLevel) {
  return (message: string, meta?: any) => {
    if (winstonLogger.isLevelEnabled(level)) {
      winstonLogger.log(level, message, meta);
    }
  };
}

// Function to configure headless mode
export function configureHeadlessMode(headless: boolean) {
  isHeadlessMode = headless;

  // Detect TTY-less environment
  isTTYlessEnvironment =
    process.stdin.isTTY !== true &&
    process.stdout.isTTY !== true &&
    process.stderr.isTTY !== true;

  // In TTY-less environments with headless mode, ensure output is line-buffered
  if (headless && isTTYlessEnvironment) {
    // Set encoding for consistent output
    if (process.stdout.setDefaultEncoding) {
      process.stdout.setDefaultEncoding("utf8");
    }
    if (process.stderr.setDefaultEncoding) {
      process.stderr.setDefaultEncoding("utf8");
    }
  }
}

// Export winstonLogger methods
export const logger = {
  trace: logAt("trace"),
  debug: logAt("debug"),
  verbose: logAt("verbose"),
  info: logAt("info"),
  warn: logAt("warn"),
  error: (message: string, error?: Error | any, meta?: any) => {
    if (error instanceof Error) {
      winstonLogger.error(message, {
        ...meta,
        error: error.message,
        stack: error.stack,
      });
    } else if (error) {
      winstonLogger.error(message, { ...meta, error });
    } else {
      winstonLogger.error(message, meta);
    }

    // In headless mode, also output to stderr
    if (isHeadlessMode) {
      if (error instanceof Error) {
        console.error(chalk.red(`${message}: ${error.message}`));
      } else if (error) {
        console.error(chalk.red(`${message}: ${error}`));
      } else {
        console.error(chalk.red(message));
      }
    }
  },
  setLevel: setLogLevel,
  isLevelEnabled: (level: LogLevel) => winstonLogger.isLevelEnabled(level),
  getLevel: () => winstonLogger.level as LogLevel,
  configureHeadlessMode,
  getLogPath: getLogFilePath,
  getRunId: () => RUN_ID,
};
