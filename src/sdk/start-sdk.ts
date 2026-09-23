import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type {
  LogRecordExporter,
  LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  BatchLogRecordProcessor,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  PeriodicExportingMetricReader,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { wrapGooglePubsub } from "../protocols/pubsub-wrap.js";
import {
  installConsoleLogExport,
  uninstallConsoleLogExport,
} from "./console-logs.js";
import { loadInstrumentations } from "./instrumentations.js";
import { resolveConfig } from "./resolve-config.js";

/**
 * Pinned rather than imported from `@opentelemetry/semantic-conventions/incubating`:
 * that subpath only resolves under node16 module resolution, which the CommonJS
 * build cannot use. The value is also deliberately the older `deployment.environment`
 * rather than semconv's newer `deployment.environment.name` - Grafana dashboards and
 * Mimir series key off this exact label, so changing it is a breaking change that has
 * to be coordinated with ops, not picked up silently from a dependency bump.
 */
const ATTR_DEPLOYMENT_ENVIRONMENT = "deployment.environment";

export interface StartedSdk {
  sdk: NodeSDK | null;
  endpoint: string | undefined;
}

export interface StartSdkOptions {
  /** Test-only: in-memory (or other) exporter. Production `createObserveModule` does not pass this. */
  traceExporter?: SpanExporter;
  /** Test-only. Production `createObserveModule` does not pass this. */
  logExporter?: LogRecordExporter;
  debug?: boolean;
}

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

type ShutdownTarget = { shutdown: () => Promise<unknown> };
type ShutdownProcess = {
  once: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
};

let singleton: StartedSdk | undefined;
let warnedMissingEndpoint = false;
let shutdownHandler: (() => void) | undefined;
let shutdownProcess: ShutdownProcess | undefined;
let shutdownTarget: ShutdownTarget | undefined;
let shutdownPromise: Promise<void> | undefined;

/** Bounds the final flush so a wedged collector cannot hold a pod in Terminating. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

function enableDebugDiagnostics(): void {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

/**
 * Flushes and shuts the SDK down, at most once.
 *
 * Exported because a signal handler is only best effort: a service that calls
 * `process.exit()` from its own SIGTERM handler, or one that runs Nest's
 * `enableShutdownHooks()`, terminates before a detached flush can finish and
 * drops whatever telemetry was still buffered. Such a service should await
 * this in its shutdown path.
 *
 * Resolves - never rejects - so a failed flush cannot block a shutdown.
 */
export function shutdownObserve(
  timeoutMs: number = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const target = shutdownTarget;
  if (!target) {
    return Promise.resolve();
  }
  shutdownPromise ??= withTimeout(target.shutdown(), timeoutMs).catch(
    (error: unknown) => {
      console.warn(
        `Observe: telemetry flush on shutdown did not complete: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  );
  return shutdownPromise;
}

function withTimeout(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Do not let the timer alone hold the event loop open.
    timer.unref?.();
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Registers SIGTERM/SIGINT to flush the SDK once.
 * Tests may pass a fake process.
 */
export function registerSdkShutdown(
  sdk: ShutdownTarget,
  proc: ShutdownProcess = process,
): void {
  if (shutdownHandler) {
    return;
  }
  shutdownTarget = sdk;
  // Node never awaits a signal listener, so this handler cannot hold the exit
  // open by itself - the flush completes because the exporter's in-flight
  // request keeps the event loop referenced while it runs. A service that
  // calls `process.exit()` from its own handler, or that runs Nest shutdown
  // hooks, must await `shutdownObserve()` instead of relying on this.
  shutdownHandler = () => {
    void shutdownObserve();
  };
  shutdownProcess = proc;
  for (const signal of SHUTDOWN_SIGNALS) {
    proc.once(signal, shutdownHandler);
  }
}

/** Resets module singleton state — tests only. */
export function resetSdkForTests(): void {
  if (shutdownHandler) {
    for (const signal of SHUTDOWN_SIGNALS) {
      shutdownProcess?.removeListener?.(signal, shutdownHandler);
    }
  }
  shutdownHandler = undefined;
  shutdownProcess = undefined;
  shutdownTarget = undefined;
  shutdownPromise = undefined;
  singleton = undefined;
  warnedMissingEndpoint = false;
  uninstallConsoleLogExport();
}

/**
 * `@opentelemetry/exporter-trace-otlp-http`'s `url` option is passed through
 * unmodified - the `v1/traces`/`v1/metrics` suffix is only auto-appended for
 * `OTEL_EXPORTER_OTLP_*` env vars, so callers must supply the full path.
 */
function otlpSignalUrl(
  endpoint: string,
  signalPath: "traces" | "metrics" | "logs",
): string {
  return `${endpoint}/v1/${signalPath}`;
}

function resolveSampler(
  tracesSampleRate: number | undefined,
): Sampler | undefined {
  if (tracesSampleRate !== undefined) {
    return new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(tracesSampleRate),
    });
  }
  if (process.env.OTEL_TRACES_SAMPLER !== undefined) {
    return undefined;
  }
  return new ParentBasedSampler({ root: new AlwaysOnSampler() });
}

type NodeSdkConfiguration = NonNullable<
  ConstructorParameters<typeof NodeSDK>[0]
>;

type NodeSdkTraceConfig = Pick<
  Partial<NodeSdkConfiguration>,
  "spanProcessors" | "traceExporter" | "autoDetectResources"
>;

/**
 * Picks the NodeSDK trace options.
 *
 * The empty-`spanProcessors` case matters: left unset, NodeSDK falls back to
 * `getSpanProcessorsFromEnv()`, which builds an OTLP exporter pointed at the
 * *default* `http://localhost:4318`. A scrape-only process (only
 * `OBSERVE_PROMETHEUS_PORT` set) would then retry against a collector that was
 * never configured and flood the log with ECONNREFUSED. An explicit empty list
 * registers no tracer provider at all, so spans are no-ops.
 */
function resolveTraceConfig(
  traceExporter: SpanExporter | undefined,
  endpoint: string | undefined,
): NodeSdkTraceConfig {
  if (traceExporter) {
    return {
      spanProcessors: [new SimpleSpanProcessor(traceExporter)],
      // Async resource detectors delay SimpleSpanProcessor export; tests
      // need spans in the in-memory exporter as soon as they end.
      autoDetectResources: false,
    };
  }
  if (endpoint) {
    return {
      traceExporter: new OTLPTraceExporter({
        url: otlpSignalUrl(endpoint, "traces"),
      }),
    };
  }
  return { spanProcessors: [] };
}

export function startSdk(options: StartSdkOptions = {}): StartedSdk {
  if (singleton) {
    return singleton;
  }

  const config = resolveConfig();
  const { endpoint } = config;
  const traceExporter = options.traceExporter;
  const logExporter = options.logExporter;
  const logsWanted =
    config.logsEnabled && (Boolean(endpoint) || Boolean(logExporter));

  if (config.debug || options.debug) {
    enableDebugDiagnostics();
  }

  if (
    !endpoint &&
    !traceExporter &&
    !logsWanted &&
    config.prometheusPort === undefined
  ) {
    if (!warnedMissingEndpoint) {
      console.warn(
        "Observe: no OTLP endpoint configured (OBSERVE_ENDPOINT); telemetry disabled",
      );
      warnedMissingEndpoint = true;
    }
    singleton = { sdk: null, endpoint: undefined };
    wrapGooglePubsub();
    return singleton;
  }

  const resourceAttributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
  };
  if (config.serviceVersion !== undefined) {
    resourceAttributes[ATTR_SERVICE_VERSION] = config.serviceVersion;
  }
  if (config.environment !== undefined) {
    resourceAttributes[ATTR_DEPLOYMENT_ENVIRONMENT] = config.environment;
  }

  const sampler = resolveSampler(config.tracesSampleRate);

  let logRecordProcessors: LogRecordProcessor[] | undefined;
  if (logsWanted) {
    try {
      logRecordProcessors = [
        // A test exporter stays on SimpleLogRecordProcessor so assertions see
        // the record without waiting on a batch timer. Production batches: at
        // warn+ a busy service emits enough records that one OTLP request per
        // record would put the exporter in the request path of every log call.
        logExporter
          ? new SimpleLogRecordProcessor({ exporter: logExporter })
          : new BatchLogRecordProcessor({
              exporter: new OTLPLogExporter({
                url: otlpSignalUrl(endpoint!, "logs"),
              }),
            }),
      ];
    } catch {
      logRecordProcessors = undefined;
    }
  }

  const metricReaders: MetricReader[] = [];
  if (endpoint) {
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: otlpSignalUrl(endpoint, "metrics"),
        }),
      }),
    );
  }
  if (config.prometheusPort !== undefined) {
    try {
      metricReaders.push(
        new PrometheusExporter(
          {
            port: config.prometheusPort,
            host: "0.0.0.0",
          },
          (error) => {
            if (error) {
              console.warn(
                "Observe: Prometheus scrape listener failed; continuing without /metrics",
              );
            }
          },
        ),
      );
    } catch {
      console.warn(
        "Observe: Prometheus scrape listener failed; continuing without /metrics",
      );
    }
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes(resourceAttributes),
    instrumentations: loadInstrumentations(),
    ...resolveTraceConfig(traceExporter, endpoint),
    ...(metricReaders.length > 0 ? { metricReaders } : {}),
    ...(sampler !== undefined ? { sampler } : {}),
    ...(logRecordProcessors ? { logRecordProcessors } : {}),
  });

  sdk.start();
  if (logRecordProcessors) {
    try {
      installConsoleLogExport(config.logsMinLevel);
    } catch {
      uninstallConsoleLogExport();
    }
  }
  wrapGooglePubsub();
  registerSdkShutdown(sdk);

  singleton = { sdk, endpoint };
  return singleton;
}
