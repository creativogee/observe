import { MODULE_METADATA } from "@nestjs/common/constants.js";
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
import "reflect-metadata";
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

type CronJobLike = { fireOnTick?: (...args: unknown[]) => unknown };
type SchedulerRegistryLike = {
  prototype: {
    addCronJob?: (
      name: string,
      job: CronJobLike,
      ...rest: unknown[]
    ) => unknown;
  };
};

/** Mirrors `cron`'s CronJob: `fireOnTick` is what runs on every trigger. */
function createFakeCronJob(work: () => unknown): CronJobLike {
  return {
    fireOnTick() {
      return work();
    },
  };
}

function createFakeSchedulerRegistry(): SchedulerRegistryLike {
  class FakeSchedulerRegistry {
    static registered: Array<{ name: string; job: CronJobLike }> = [];
    addCronJob(name: string, job: CronJobLike) {
      FakeSchedulerRegistry.registered.push({ name, job });
    }
  }
  return FakeSchedulerRegistry;
}

function mockScheduleWithRegistry(
  ScheduleExplorer: ScheduleExplorerLike,
  SchedulerRegistry: SchedulerRegistryLike,
): void {
  vi.mocked(loadOptionalPeer).mockImplementation(() => ({
    installed: true,
    module: { ScheduleExplorer, SchedulerRegistry },
  }));
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

describe("ScheduleObserveAgentService dynamic cron registration", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    vi.mocked(loadOptionalPeer).mockReset();
    context.disable();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    const manager = new AsyncLocalStorageContextManager();
    manager.enable();
    context.setGlobalContextManager(manager);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  afterEach(async () => {
    context.disable();
    trace.disable();
    propagation.disable();
    await provider.shutdown();
  });

  it("wraps a job registered through SchedulerRegistry.addCronJob", async () => {
    const ScheduleExplorer = createFakeScheduleExplorer();
    const SchedulerRegistry = createFakeSchedulerRegistry();
    mockScheduleWithRegistry(ScheduleExplorer, SchedulerRegistry);
    new ScheduleObserveAgentService();

    const registry = new (
      SchedulerRegistry as unknown as new () => {
        addCronJob: (n: string, j: CronJobLike) => void;
      }
    )();
    const job = createFakeCronJob(() => "done");
    registry.addCronJob("outbox-drain", job);

    await job.fireOnTick!();

    const span = exporter.getFinishedSpans().at(-1);
    // The whole point: the job's own work now has a named parent instead of
    // reporting orphan database spans.
    expect(span?.name).toBe("cron outbox-drain");
  });

  it("parents the job's own spans under the job span", async () => {
    const ScheduleExplorer = createFakeScheduleExplorer();
    const SchedulerRegistry = createFakeSchedulerRegistry();
    mockScheduleWithRegistry(ScheduleExplorer, SchedulerRegistry);
    new ScheduleObserveAgentService();

    const registry = new (
      SchedulerRegistry as unknown as new () => {
        addCronJob: (n: string, j: CronJobLike) => void;
      }
    )();
    const job = createFakeCronJob(() => {
      trace.getTracer("test").startActiveSpan("pg.query", (child) => {
        child.end();
      });
    });
    registry.addCronJob("outbox-drain", job);

    await job.fireOnTick!();

    const spans = exporter.getFinishedSpans();
    const child = spans.find((s) => s.name === "pg.query");
    const parent = spans.find((s) => s.name === "cron outbox-drain");
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });

  it("marks the job span ERROR when the job throws", async () => {
    const ScheduleExplorer = createFakeScheduleExplorer();
    const SchedulerRegistry = createFakeSchedulerRegistry();
    mockScheduleWithRegistry(ScheduleExplorer, SchedulerRegistry);
    new ScheduleObserveAgentService();

    const registry = new (
      SchedulerRegistry as unknown as new () => {
        addCronJob: (n: string, j: CronJobLike) => void;
      }
    )();
    const job = createFakeCronJob(() => {
      throw new Error("drain failed");
    });
    registry.addCronJob("outbox-drain", job);

    await expect(job.fireOnTick!()).rejects.toThrow("drain failed");
    expect(exporter.getFinishedSpans().at(-1)?.status.code).toBe(
      SpanStatusCode.ERROR,
    );
  });

  it("still registers the job with the real registry", async () => {
    const ScheduleExplorer = createFakeScheduleExplorer();
    const SchedulerRegistry = createFakeSchedulerRegistry();
    mockScheduleWithRegistry(ScheduleExplorer, SchedulerRegistry);
    new ScheduleObserveAgentService();

    const registered = (
      SchedulerRegistry as unknown as { registered: unknown[] }
    ).registered;
    registered.length = 0;
    const registry = new (
      SchedulerRegistry as unknown as new () => {
        addCronJob: (n: string, j: CronJobLike) => void;
      }
    )();
    registry.addCronJob(
      "outbox-drain",
      createFakeCronJob(() => undefined),
    );

    // Instrumentation must never swallow the registration itself.
    expect(registered).toHaveLength(1);
  });

  it("does not double-wrap a job registered twice", async () => {
    const ScheduleExplorer = createFakeScheduleExplorer();
    const SchedulerRegistry = createFakeSchedulerRegistry();
    mockScheduleWithRegistry(ScheduleExplorer, SchedulerRegistry);
    new ScheduleObserveAgentService();

    const registry = new (
      SchedulerRegistry as unknown as new () => {
        addCronJob: (n: string, j: CronJobLike) => void;
      }
    )();
    const job = createFakeCronJob(() => undefined);
    registry.addCronJob("outbox-drain", job);
    registry.addCronJob("outbox-drain", job);

    await job.fireOnTick!();

    expect(
      exporter.getFinishedSpans().filter((s) => s.name === "cron outbox-drain"),
    ).toHaveLength(1);
  });
});
