import "reflect-metadata";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createObserveModule } from "../observe.module.js";
import { resetSdkForTests } from "../sdk/start-sdk.js";
import { loadOptionalPeer } from "../utils/optional-peer.js";
import { ScheduleObserveAgentService } from "./schedule-observe-agent.service.js";

vi.mock("../utils/optional-peer.js", () => ({
  loadOptionalPeer: vi.fn(),
  describePeerLoadError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

const SCHEDULER_TYPE = "SCHEDULER_TYPE";

type ScheduleExplorerLike = {
  prototype: {
    wrapFunctionInTryCatchBlocks?: WrapFunction;
  };
};

type ScheduledHandler = (...args: unknown[]) => unknown;
type WrapFunction = (
  this: unknown,
  methodRef: ScheduledHandler,
  instance: object,
) => ScheduledHandler;

function createFakeScheduleExplorer(): ScheduleExplorerLike {
  class FakeScheduleExplorer {
    wrapFunctionInTryCatchBlocks(
      methodRef: ScheduledHandler,
      instance: object,
    ): ScheduledHandler {
      return (...args: unknown[]) => methodRef.call(instance, ...args);
    }
  }
  return FakeScheduleExplorer;
}

function mockScheduleMissing(): void {
  vi.mocked(loadOptionalPeer).mockReturnValue({ installed: false });
}

function mockScheduleInstalled(ScheduleExplorer: ScheduleExplorerLike): void {
  vi.mocked(loadOptionalPeer).mockImplementation((packageName, specifier) => {
    if (specifier && specifier !== packageName) {
      return { installed: true, module: { ScheduleExplorer } };
    }
    return { installed: true, module: { ScheduleExplorer } };
  });
}

describe("ScheduleObserveAgentService", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let ScheduleExplorer: ScheduleExplorerLike;
  let originalWrap: WrapFunction | undefined;

  beforeEach(() => {
    vi.mocked(loadOptionalPeer).mockReset();
    ScheduleExplorer = createFakeScheduleExplorer();
    originalWrap = ScheduleExplorer.prototype.wrapFunctionInTryCatchBlocks;

    context.disable();
    trace.disable();
    propagation.disable();

    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    ScheduleExplorer.prototype.wrapFunctionInTryCatchBlocks = originalWrap;
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it("stays silent when @nestjs/schedule is not installed", () => {
    mockScheduleMissing();

    expect(() => new ScheduleObserveAgentService()).not.toThrow();
    expect(ScheduleExplorer.prototype.wrapFunctionInTryCatchBlocks).toBe(
      originalWrap,
    );
  });

  it("wraps scheduled handlers in an INTERNAL span", async () => {
    mockScheduleInstalled(ScheduleExplorer);
    new ScheduleObserveAgentService();

    const wrap = ScheduleExplorer.prototype.wrapFunctionInTryCatchBlocks;
    expect(wrap).toEqual(expect.any(Function));
    expect(wrap).not.toBe(originalWrap);

    class ReportsService {
      nightly() {
        return "done";
      }
    }
    const instance = new ReportsService();
    // Reference only, later called with `instance` supplied explicitly.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const methodRef = instance.nightly;
    Reflect.defineMetadata(SCHEDULER_TYPE, 1, methodRef);

    const handler = vi.fn(function nightly(this: ReportsService) {
      return "done";
    });
    Object.defineProperty(handler, "name", { value: "nightly" });
    Reflect.defineMetadata(SCHEDULER_TYPE, 1, handler);

    const wrapped = wrap!.call(ScheduleExplorer.prototype, handler, instance);
    await expect(wrapped("secret-arg")).resolves.toBe("done");
    expect(handler).toHaveBeenCalledWith("secret-arg");

    const [span] = exporter.getFinishedSpans();
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.name).toBe("cron ReportsService.nightly");
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(span.attributes)).not.toContain("secret-arg");
  });

  it("records handler failures on the span", async () => {
    mockScheduleInstalled(ScheduleExplorer);
    new ScheduleObserveAgentService();

    const wrap = ScheduleExplorer.prototype.wrapFunctionInTryCatchBlocks!;
    class FailService {}
    const instance = new FailService();
    const failure = new Error("deliberate");
    const handler = vi.fn(async () => {
      throw failure;
    });
    Object.defineProperty(handler, "name", { value: "tick" });
    Reflect.defineMetadata(SCHEDULER_TYPE, 3, handler);

    const wrapped = wrap.call(ScheduleExplorer.prototype, handler, instance);
    await expect(wrapped()).rejects.toThrow(failure);

    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe("interval FailService.tick");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
  });
});

describe("ObserveModule schedule agent registration", () => {
  afterEach(() => {
    resetSdkForTests();
  });

  it("registers ScheduleObserveAgentService on the ObserveModule class", () => {
    const { ObserveModule } = createObserveModule();
    const providers: unknown[] =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ObserveModule) ?? [];
    expect(providers).toContain(ScheduleObserveAgentService);
  });
});
