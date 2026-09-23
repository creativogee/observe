import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./resolve-config.js";

const KEYS = [
  "OBSERVE_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SERVICE_NAME",
  "OBSERVE_TRACES_SAMPLE_RATE",
  "NODE_ENV",
  "OBSERVE_LOGS",
  "OBSERVE_LOGS_MIN_LEVEL",
  "OBSERVE_PROMETHEUS_PORT",
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("resolveConfig", () => {
  it("uses OBSERVE_ENDPOINT when set", () => {
    process.env.OBSERVE_ENDPOINT = "http://observe:4318";
    expect(resolveConfig().endpoint).toBe("http://observe:4318");
  });

  it("leaves endpoint undefined when OBSERVE_ENDPOINT is unset", () => {
    expect(resolveConfig().endpoint).toBeUndefined();
  });

  it("does not use OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel:4318";
    expect(resolveConfig().endpoint).toBeUndefined();
  });

  it("uses OTEL_SERVICE_NAME when set", () => {
    process.env.OTEL_SERVICE_NAME = "orders";
    expect(resolveConfig().serviceName).toBe("orders");
  });

  it("parses OBSERVE_TRACES_SAMPLE_RATE", () => {
    process.env.OBSERVE_TRACES_SAMPLE_RATE = "0.1";
    expect(resolveConfig().tracesSampleRate).toBe(0.1);
  });

  it("ignores invalid OBSERVE_TRACES_SAMPLE_RATE", () => {
    process.env.OBSERVE_TRACES_SAMPLE_RATE = "nope";
    expect(resolveConfig().tracesSampleRate).toBeUndefined();
  });

  it("leaves logsEnabled false when OBSERVE_LOGS is unset", () => {
    expect(resolveConfig().logsEnabled).toBe(false);
    expect(resolveConfig().logsMinLevel).toBe("warn");
  });

  it("sets logsEnabled only when OBSERVE_LOGS is exactly true", () => {
    process.env.OBSERVE_LOGS = "TRUE";
    expect(resolveConfig().logsEnabled).toBe(false);
    process.env.OBSERVE_LOGS = "true";
    expect(resolveConfig().logsEnabled).toBe(true);
  });

  it("parses OBSERVE_LOGS_MIN_LEVEL and defaults invalid values to warn", () => {
    process.env.OBSERVE_LOGS_MIN_LEVEL = "error";
    expect(resolveConfig().logsMinLevel).toBe("error");
    process.env.OBSERVE_LOGS_MIN_LEVEL = "debug";
    expect(resolveConfig().logsMinLevel).toBe("debug");
    process.env.OBSERVE_LOGS_MIN_LEVEL = "nope";
    expect(resolveConfig().logsMinLevel).toBe("warn");
  });

  it("parses OBSERVE_PROMETHEUS_PORT when it is a valid port", () => {
    process.env.OBSERVE_PROMETHEUS_PORT = "9464";
    expect(resolveConfig().prometheusPort).toBe(9464);
    process.env.OBSERVE_PROMETHEUS_PORT = " 8080 ";
    expect(resolveConfig().prometheusPort).toBe(8080);
  });

  it("leaves prometheusPort undefined when OBSERVE_PROMETHEUS_PORT is unset", () => {
    expect(resolveConfig().prometheusPort).toBeUndefined();
  });

  it("ignores invalid OBSERVE_PROMETHEUS_PORT without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.OBSERVE_PROMETHEUS_PORT = "0";
    expect(resolveConfig().prometheusPort).toBeUndefined();
    process.env.OBSERVE_PROMETHEUS_PORT = "65536";
    expect(resolveConfig().prometheusPort).toBeUndefined();
    process.env.OBSERVE_PROMETHEUS_PORT = "abc";
    expect(resolveConfig().prometheusPort).toBeUndefined();
    process.env.OBSERVE_PROMETHEUS_PORT = "9464.5";
    expect(resolveConfig().prometheusPort).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
