import { readFileSync } from "node:fs";
import { join } from "node:path";

export type LogsMinLevel = "error" | "warn" | "info" | "debug";

export interface ResolvedObserveConfig {
  endpoint: string | undefined;
  serviceName: string;
  serviceVersion: string | undefined;
  environment: string | undefined;
  /** Set only when OBSERVE_TRACES_SAMPLE_RATE is present and valid. */
  tracesSampleRate: number | undefined;
  debug: boolean;
  logsEnabled: boolean;
  logsMinLevel: LogsMinLevel;
  prometheusPort: number | undefined;
}

interface PackageJson {
  name?: string;
  version?: string;
}

function readPackageJson(): PackageJson {
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return {};
  }
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseTracesSampleRate(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return undefined;
  }
  return parsed;
}

const LOGS_MIN_LEVELS = new Set<LogsMinLevel>([
  "error",
  "warn",
  "info",
  "debug",
]);

function parseLogsMinLevel(raw: string | undefined): LogsMinLevel {
  if (raw !== undefined && LOGS_MIN_LEVELS.has(raw as LogsMinLevel)) {
    return raw as LogsMinLevel;
  }
  return "warn";
}

function parsePrometheusPort(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return undefined;
  }
  const port = Number(trimmed);
  if (port < 1 || port > 65535) {
    return undefined;
  }
  return port;
}

function resolveEndpoint(): string | undefined {
  const endpoint = process.env.OBSERVE_ENDPOINT;
  return endpoint === undefined ? undefined : stripTrailingSlash(endpoint);
}

export function resolveConfig(): ResolvedObserveConfig {
  const pkg = readPackageJson();

  return {
    endpoint: resolveEndpoint(),
    serviceName: process.env.OTEL_SERVICE_NAME ?? pkg.name ?? "unknown",
    serviceVersion: pkg.version,
    environment: process.env.NODE_ENV,
    tracesSampleRate: parseTracesSampleRate(
      process.env.OBSERVE_TRACES_SAMPLE_RATE,
    ),
    debug: process.env.OBSERVE_DEBUG === "true",
    logsEnabled: process.env.OBSERVE_LOGS === "true",
    logsMinLevel: parseLogsMinLevel(process.env.OBSERVE_LOGS_MIN_LEVEL),
    prometheusPort: parsePrometheusPort(process.env.OBSERVE_PROMETHEUS_PORT),
  };
}
