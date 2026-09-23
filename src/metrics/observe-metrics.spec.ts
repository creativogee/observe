import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SERIES_PER_METRIC } from "./series-limit.js";

const otelAdd = vi.fn();
const otelRecord = vi.fn();
const otelUpDownAdd = vi.fn();

vi.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: vi.fn(() => ({
      createCounter: vi.fn(() => ({ add: otelAdd })),
      createHistogram: vi.fn(() => ({ record: otelRecord })),
      createUpDownCounter: vi.fn(() => ({ add: otelUpDownAdd })),
    })),
  },
}));

const { ObserveMetrics } = await import("./observe-metrics.js");

describe("ObserveMetrics", () => {
  beforeEach(() => {
    otelAdd.mockClear();
    otelRecord.mockClear();
    otelUpDownAdd.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.warn).mockRestore();
  });

  it("records up to MAX_SERIES_PER_METRIC distinct labels, drops the rest, warns once, and add does not throw", () => {
    const metrics = new ObserveMetrics();
    const counter = metrics.counter("requests_total");

    for (let i = 0; i < MAX_SERIES_PER_METRIC; i++) {
      counter.add(1, { id: String(i) });
    }

    expect(otelAdd).toHaveBeenCalledTimes(MAX_SERIES_PER_METRIC);
    expect(console.warn).not.toHaveBeenCalled();

    expect(() =>
      counter.add(1, { id: String(MAX_SERIES_PER_METRIC) }),
    ).not.toThrow();
    expect(otelAdd).toHaveBeenCalledTimes(MAX_SERIES_PER_METRIC);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Metric "requests_total" reached 1000 distinct label combinations',
      ),
    );

    expect(() =>
      counter.add(1, { id: String(MAX_SERIES_PER_METRIC + 1) }),
    ).not.toThrow();
    expect(otelAdd).toHaveBeenCalledTimes(MAX_SERIES_PER_METRIC);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("re-applies the series cap to histogram and upDownCounter", () => {
    const metrics = new ObserveMetrics();
    const histogram = metrics.histogram("latency_ms");
    const upDown = metrics.upDownCounter("in_flight");

    for (let i = 0; i < MAX_SERIES_PER_METRIC; i++) {
      histogram.record(i, { route: `/r${i}` });
      upDown.add(1, { route: `/r${i}` });
    }

    histogram.record(999, { route: "/overflow" });
    upDown.add(1, { route: "/overflow" });

    expect(otelRecord).toHaveBeenCalledTimes(MAX_SERIES_PER_METRIC);
    expect(otelUpDownAdd).toHaveBeenCalledTimes(MAX_SERIES_PER_METRIC);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
