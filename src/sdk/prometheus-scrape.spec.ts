import { createServer } from "node:http";
import { diag, metrics, trace } from "@opentelemetry/api";
import type { NodeSDK } from "@opentelemetry/sdk-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserveMetrics } from "../metrics/observe-metrics.js";
import { resetSdkForTests, startSdk } from "./start-sdk.js";

const ENV_KEYS = ["OBSERVE_ENDPOINT", "OBSERVE_PROMETHEUS_PORT"] as const;
const PORT = 39464;
const PROMETHEUS_LISTEN_FAILED_WARN =
  "Observe: Prometheus scrape listener failed; continuing without /metrics";

let activeSdk: NodeSDK | null = null;

afterEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  if (activeSdk) {
    await activeSdk.shutdown();
    activeSdk = null;
  }
  resetSdkForTests();
  metrics.disable();
  trace.disable();
  diag.disable();
});

describe("prometheus scrape endpoint", () => {
  it("serves Prometheus text including an ObserveMetrics series", async () => {
    process.env.OBSERVE_PROMETHEUS_PORT = String(PORT);
    const started = startSdk();
    expect(started.sdk).not.toBeNull();
    activeSdk = started.sdk;

    new ObserveMetrics().counter("observe_scrape_probe").add(1);

    let body = "";
    await expect
      .poll(async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/metrics`);
        if (!response.ok) {
          return false;
        }
        body = await response.text();
        return body.includes("observe_scrape_probe");
      })
      .toBe(true);

    expect(body).toMatch(/# TYPE observe_scrape_probe/);
    expect(body).toMatch(/target_info\{[^}]*host/);
  });

  it("warns and keeps the SDK running when the prometheus port is in use", async () => {
    // Bind the same address the exporter asks for. A default `listen(PORT)`
    // binds `::`, which on some platforms coexists with `0.0.0.0` instead of
    // colliding, and the listen error under test would never fire.
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen({ port: PORT, host: "0.0.0.0" }, resolve);
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.OBSERVE_PROMETHEUS_PORT = String(PORT);
      const started = startSdk();
      expect(started.sdk).not.toBeNull();
      activeSdk = started.sdk;

      await expect
        .poll(() =>
          warn.mock.calls.some(
            (call) => call[0] === PROMETHEUS_LISTEN_FAILED_WARN,
          ),
        )
        .toBe(true);
    } finally {
      warn.mockRestore();
      await new Promise<void>((resolve, reject) => {
        blocker.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
