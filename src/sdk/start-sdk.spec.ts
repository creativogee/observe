import { diag, DiagLogLevel, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import type { NodeSDK } from "@opentelemetry/sdk-node";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { ConsoleLogger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapGooglePubsub } from "../protocols/pubsub-wrap.js";
import {
  addSensitiveFields,
  resetSensitiveFieldsForTests,
} from "../sanitizer/redact.js";
import { loadInstrumentations } from "./instrumentations.js";
import {
  registerSdkShutdown,
  resetSdkForTests,
  shutdownObserve,
  startSdk,
} from "./start-sdk.js";

const { logProcessorShouldThrow, prometheus, otlpMetric, otlpTrace } =
  vi.hoisted(() => ({
    logProcessorShouldThrow: { value: false },
    prometheus: {
      shouldThrow: false,
      calls: [] as Array<{ port?: number; host?: string }>,
    },
    otlpMetric: { constructed: false },
    otlpTrace: { constructed: false },
  }));

vi.mock("@opentelemetry/sdk-logs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@opentelemetry/sdk-logs")>();
  return {
    ...actual,
    SimpleLogRecordProcessor: class extends actual.SimpleLogRecordProcessor {
      constructor(
        ...args: ConstructorParameters<typeof actual.SimpleLogRecordProcessor>
      ) {
        if (logProcessorShouldThrow.value) {
          throw new Error("log processor boom");
        }
        super(...args);
      }
    },
  };
});

vi.mock("@opentelemetry/exporter-prometheus", async () => {
  const { MetricReader } = await import("@opentelemetry/sdk-metrics");
  return {
    PrometheusExporter: class extends MetricReader {
      constructor(config: { port?: number; host?: string } = {}) {
        super();
        prometheus.calls.push({ port: config.port, host: config.host });
        if (prometheus.shouldThrow) {
          throw new Error("listen boom");
        }
      }
      protected async onForceFlush() {}
      protected async onShutdown() {}
    },
  };
});

vi.mock("@opentelemetry/exporter-metrics-otlp-http", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@opentelemetry/exporter-metrics-otlp-http")
    >();
  return {
    ...actual,
    OTLPMetricExporter: class extends actual.OTLPMetricExporter {
      constructor(
        ...args: ConstructorParameters<typeof actual.OTLPMetricExporter>
      ) {
        otlpMetric.constructed = true;
        super(...args);
      }
    },
  };
});

vi.mock("@opentelemetry/exporter-trace-otlp-http", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@opentelemetry/exporter-trace-otlp-http")
    >();
  return {
    ...actual,
    OTLPTraceExporter: class extends actual.OTLPTraceExporter {
      constructor(
        ...args: ConstructorParameters<typeof actual.OTLPTraceExporter>
      ) {
        otlpTrace.constructed = true;
        super(...args);
      }
    },
  };
});

vi.mock("./instrumentations.js", () => ({
  loadInstrumentations: vi.fn(() => []),
}));

vi.mock("../protocols/pubsub-wrap.js", () => ({
  wrapGooglePubsub: vi.fn(),
}));

const ENV_KEYS = [
  "OBSERVE_ENDPOINT",
  "OBSERVE_DEBUG",
  "OBSERVE_LOGS",
  "OBSERVE_LOGS_MIN_LEVEL",
  "OBSERVE_PROMETHEUS_PORT",
] as const;

let activeSdk: NodeSDK | null = null;

afterEach(async () => {
  resetSensitiveFieldsForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  logProcessorShouldThrow.value = false;
  prometheus.shouldThrow = false;
  prometheus.calls.length = 0;
  otlpMetric.constructed = false;
  otlpTrace.constructed = false;
  if (activeSdk) {
    await activeSdk.shutdown();
    activeSdk = null;
  }
  resetSdkForTests();
  logs.disable();
  trace.disable();
  diag.disable();
  vi.mocked(wrapGooglePubsub).mockClear();
});

function track(
  started: ReturnType<typeof startSdk>,
): ReturnType<typeof startSdk> {
  if (started.sdk) activeSdk = started.sdk;
  return started;
}

describe("startSdk", () => {
  it("does not throw when endpoint is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = startSdk();
    expect(started.sdk).toBeNull();
    expect(started.endpoint).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("starts a NodeSDK when OBSERVE_ENDPOINT is set", () => {
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    const started = track(startSdk());
    expect(started.sdk).not.toBeNull();
    expect(started.endpoint).toBe("http://127.0.0.1:4318");
  });

  it("is idempotent", () => {
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    const a = track(startSdk());
    const b = startSdk();
    expect(a.sdk).toBe(b.sdk);
  });

  it("passes loadInstrumentations() into NodeSDK", () => {
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    vi.mocked(loadInstrumentations).mockClear();
    track(startSdk());
    expect(loadInstrumentations).toHaveBeenCalledTimes(1);
  });

  it("wraps Google Pub/Sub when endpoint is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    startSdk();
    expect(wrapGooglePubsub).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("wraps Google Pub/Sub after sdk.start()", () => {
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    track(startSdk());
    expect(wrapGooglePubsub).toHaveBeenCalledTimes(1);
  });

  it("starts NodeSDK with a provided traceExporter when no endpoint is set", () => {
    const exporter = new InMemorySpanExporter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = track(startSdk({ traceExporter: exporter }));
    expect(started.sdk).not.toBeNull();
    expect(started.endpoint).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();

    trace.getTracer("@crudmates/observe").startSpan("memory-span").end();
    expect(exporter.getFinishedSpans().map((span) => span.name)).toContain(
      "memory-span",
    );
  });

  it("enables OTel diag DEBUG when OBSERVE_DEBUG is true", () => {
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    process.env.OBSERVE_DEBUG = "true";
    const setLogger = vi.spyOn(diag, "setLogger");
    track(startSdk());
    expect(
      setLogger.mock.calls.some((call) => call[1] === DiagLogLevel.DEBUG),
    ).toBe(true);
    setLogger.mockRestore();
  });

  it("enables OTel diag DEBUG when options.debug is true", () => {
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    const setLogger = vi.spyOn(diag, "setLogger");
    track(startSdk({ debug: true }));
    expect(
      setLogger.mock.calls.some((call) => call[1] === DiagLogLevel.DEBUG),
    ).toBe(true);
    setLogger.mockRestore();
  });

  it("does not enable OTel diag DEBUG when debug is unset", () => {
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    const setLogger = vi.spyOn(diag, "setLogger");
    track(startSdk());
    expect(
      setLogger.mock.calls.some((call) => call[1] === DiagLogLevel.DEBUG),
    ).toBe(false);
    setLogger.mockRestore();
  });

  it("registers SIGTERM and SIGINT shutdown once when the SDK starts", () => {
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    const once = vi.spyOn(process, "once");
    track(startSdk());
    startSdk();
    const signals = once.mock.calls
      .filter((call) => call[0] === "SIGTERM" || call[0] === "SIGINT")
      .map((call) => call[0]);
    expect(signals).toEqual(["SIGTERM", "SIGINT"]);
    once.mockRestore();
  });

  it("does not patch console.error when OBSERVE_LOGS is unset", () => {
    const before = console.error;
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    track(startSdk({ traceExporter: new InMemorySpanExporter() }));
    expect(console.error).toBe(before);
  });

  it("does not patch console when OBSERVE_LOGS is true but no endpoint or logExporter", () => {
    const before = console.error;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.OBSERVE_LOGS = "true";
    const started = startSdk();
    expect(started.sdk).toBeNull();
    expect(console.error).toBe(before);
    warn.mockRestore();
  });

  it("records console.error on the logExporter with the active span trace id", () => {
    process.env.OBSERVE_LOGS = "true";
    const logExporter = new InMemoryLogRecordExporter();
    const spanExporter = new InMemorySpanExporter();
    track(
      startSdk({
        traceExporter: spanExporter,
        logExporter,
      }),
    );

    const tracer = trace.getTracer("@crudmates/observe");
    tracer.startActiveSpan("root", (span) => {
      console.error("failed");
      span.end();
    });

    const records = logExporter.getFinishedLogRecords();
    const errorLog = records.find((record) => record.body === "failed");
    expect(errorLog).toBeDefined();
    expect(errorLog!.spanContext?.traceId).toBe(
      spanExporter.getFinishedSpans()[0].spanContext().traceId,
    );
  });

  it("redacts sensitive fields before a log record leaves the process", () => {
    process.env.OBSERVE_LOGS = "true";
    const logExporter = new InMemoryLogRecordExporter();
    const printed: unknown[][] = [];
    const error = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        printed.push(args);
      });
    // A traceExporter is passed only to switch resource detection off, as the
    // other log tests do; async detectors would otherwise delay the export
    // past the assertion.
    track(startSdk({ logExporter, traceExporter: new InMemorySpanExporter() }));

    // Redaction is opt-in: an application declares its own fields, since the
    // package ships no default list.
    addSensitiveFields(["bvn", "accountNumber"]);

    console.error("charge failed", {
      orderId: "ORD_01H",
      bvn: "22345678901",
      accountNumber: "0123456789",
    });

    const exported = logExporter
      .getFinishedLogRecords()
      .map((record) =>
        typeof record.body === "string"
          ? record.body
          : JSON.stringify(record.body),
      )
      .join("\n");

    expect(exported).toContain("charge failed");
    expect(exported).toContain("ORD_01H");
    expect(exported).toContain("[REDACTED]");
    expect(exported).not.toContain("22345678901");
    expect(exported).not.toContain("0123456789");
    error.mockRestore();
  });

  it("records Nest ConsoleLogger error and warn without forceConsole", () => {
    process.env.OBSERVE_LOGS = "true";
    const logExporter = new InMemoryLogRecordExporter();
    track(
      startSdk({
        traceExporter: new InMemorySpanExporter(),
        logExporter,
      }),
    );
    const logger = new ConsoleLogger("Test", { colors: false });

    logger.error("nest provider error");
    logger.warn("nest provider warning");

    expect(
      logExporter
        .getFinishedLogRecords()
        .map(({ body, severityText }) => ({ body, severityText })),
    ).toEqual(
      expect.arrayContaining([
        { body: "nest provider error", severityText: "ERROR" },
        { body: "nest provider warning", severityText: "WARN" },
      ]),
    );
  });

  it("does not record console.info at default min level warn", () => {
    process.env.OBSERVE_LOGS = "true";
    const logExporter = new InMemoryLogRecordExporter();
    track(
      startSdk({
        traceExporter: new InMemorySpanExporter(),
        logExporter,
      }),
    );
    console.info("quiet");
    expect(
      logExporter
        .getFinishedLogRecords()
        .some((record) => record.body === "quiet"),
    ).toBe(false);
  });

  it("does not wrap console.error twice on a second startSdk call", () => {
    process.env.OBSERVE_LOGS = "true";
    track(
      startSdk({
        traceExporter: new InMemorySpanExporter(),
        logExporter: new InMemoryLogRecordExporter(),
      }),
    );
    const wrapped = console.error;
    startSdk();
    expect(console.error).toBe(wrapped);
  });

  it("starts traces when log processor construction throws and does not patch console", () => {
    process.env.OBSERVE_LOGS = "true";
    logProcessorShouldThrow.value = true;
    const before = console.error;
    const spanExporter = new InMemorySpanExporter();
    const started = track(
      startSdk({
        traceExporter: spanExporter,
        logExporter: new InMemoryLogRecordExporter(),
      }),
    );
    expect(started.sdk).not.toBeNull();
    expect(console.error).toBe(before);
    expect(wrapGooglePubsub).toHaveBeenCalledTimes(1);

    trace.getTracer("@crudmates/observe").startSpan("after-log-fail").end();
    expect(spanExporter.getFinishedSpans().map((span) => span.name)).toContain(
      "after-log-fail",
    );
  });

  it("does not construct PrometheusExporter when port is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = startSdk();
    expect(started.sdk).toBeNull();
    expect(prometheus.calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("starts OTLP and Prometheus readers when endpoint and port are set", () => {
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    process.env.OBSERVE_PROMETHEUS_PORT = "9464";
    const started = track(startSdk());
    expect(started.sdk).not.toBeNull();
    expect(otlpMetric.constructed).toBe(true);
    expect(prometheus.calls).toEqual([{ port: 9464, host: "0.0.0.0" }]);
  });

  it("starts scrape-only without the missing-endpoint warning or OTLP metrics", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.OBSERVE_PROMETHEUS_PORT = "9464";
    const started = track(startSdk());
    expect(started.sdk).not.toBeNull();
    expect(started.endpoint).toBeUndefined();
    expect(otlpMetric.constructed).toBe(false);
    expect(prometheus.calls).toEqual([{ port: 9464, host: "0.0.0.0" }]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("exports no traces when scrape-only, rather than falling back to the default OTLP endpoint", () => {
    process.env.OBSERVE_PROMETHEUS_PORT = "9464";
    const started = track(startSdk());
    expect(started.sdk).not.toBeNull();
    // NodeSDK reads `getSpanProcessorsFromEnv()` when `spanProcessors` is
    // absent, which targets http://localhost:4318 whether or not a collector
    // is there. Scrape-only must register no span processor at all.
    expect(otlpTrace.constructed).toBe(false);
    expect(trace.getTracer("probe").startSpan("probe").isRecording()).toBe(
      false,
    );
  });

  it("constructs an OTLP trace exporter when OBSERVE_ENDPOINT is set", () => {
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    track(startSdk());
    expect(otlpTrace.constructed).toBe(true);
  });

  it("warns and keeps OTLP metrics when PrometheusExporter throws", () => {
    process.env.OBSERVE_ENDPOINT = "http://127.0.0.1:4318";
    process.env.OBSERVE_PROMETHEUS_PORT = "9464";
    prometheus.shouldThrow = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = track(startSdk());
    expect(started.sdk).not.toBeNull();
    expect(otlpMetric.constructed).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "Observe: Prometheus scrape listener failed; continuing without /metrics",
    );
    warn.mockRestore();
  });

  it("is still a singleton when scrape-only", () => {
    process.env.OBSERVE_PROMETHEUS_PORT = "9464";
    const a = track(startSdk());
    const b = startSdk();
    expect(a.sdk).toBe(b.sdk);
    expect(prometheus.calls).toHaveLength(1);
  });
});

describe("registerSdkShutdown", () => {
  it("invokes sdk.shutdown once for SIGTERM and does not register twice", async () => {
    const shutdown = vi.fn(async () => {});
    const handlers = new Map<string, () => unknown>();
    const proc = {
      once: vi.fn((signal: string, handler: () => unknown) => {
        handlers.set(signal, handler);
        return proc;
      }),
    };

    registerSdkShutdown({ shutdown }, proc);
    registerSdkShutdown({ shutdown }, proc);

    expect(proc.once).toHaveBeenCalledTimes(2);
    expect(handlers.get("SIGTERM")).toBeDefined();
    expect(handlers.get("SIGINT")).toBeDefined();

    await handlers.get("SIGTERM")!();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("starts a flush the caller can await via shutdownObserve", async () => {
    let releaseFlush: () => void = () => {};
    let flushed = false;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = () => {
            flushed = true;
            resolve();
          };
        }),
    );
    const handlers = new Map<string, () => unknown>();
    const proc = {
      once: vi.fn((signal: string, handler: () => unknown) => {
        handlers.set(signal, handler);
        return proc;
      }),
    };

    registerSdkShutdown({ shutdown }, proc);
    handlers.get("SIGTERM")!();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(flushed).toBe(false);

    // The signal handler and a caller awaiting shutdownObserve() share one
    // flush, so the service's own shutdown path can wait for the same work.
    const awaited = shutdownObserve();
    releaseFlush();
    await awaited;
    expect(flushed).toBe(true);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

describe("shutdownObserve", () => {
  it("resolves without a started SDK", async () => {
    await expect(shutdownObserve()).resolves.toBeUndefined();
  });

  it("flushes once however many callers ask", async () => {
    const shutdown = vi.fn(async () => {});
    registerSdkShutdown({ shutdown }, { once: () => undefined });

    await Promise.all([shutdownObserve(), shutdownObserve()]);
    await shutdownObserve();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("resolves and warns when the flush rejects, so shutdown is never blocked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shutdown = vi.fn(() => Promise.reject(new Error("collector gone")));
    registerSdkShutdown({ shutdown }, { once: () => undefined });

    await expect(shutdownObserve()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Observe: telemetry flush on shutdown did not complete: collector gone",
    );
    warn.mockRestore();
  });

  it("gives up on a flush that never settles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    registerSdkShutdown({ shutdown }, { once: () => undefined });

    await expect(shutdownObserve(10)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Observe: telemetry flush on shutdown did not complete: timed out after 10ms",
    );
    warn.mockRestore();
  });
});
