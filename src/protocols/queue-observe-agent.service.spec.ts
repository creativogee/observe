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
import { QueueObserveAgentService } from "./queue-observe-agent.service.js";

vi.mock("../utils/optional-peer.js", () => ({
  loadOptionalPeer: vi.fn(),
  describePeerLoadError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

type ProcessorDecoratorServiceLike = {
  prototype: {
    decorate?: (
      processor: (job: FakeJob) => unknown,
    ) => (job: FakeJob) => unknown;
  };
};

type FakeJob = {
  queueName: string;
  name: string;
  id: string;
  timestamp?: number;
  processedOn?: number;
  delay?: number;
  attemptsMade?: number;
  opts?: { attempts?: number };
  data?: Record<string, unknown>;
};

function createFakeProcessorDecoratorService(): ProcessorDecoratorServiceLike {
  class FakeProcessorDecoratorService {}
  return FakeProcessorDecoratorService;
}

function mockBullMqMissing(): void {
  vi.mocked(loadOptionalPeer).mockReturnValue({ installed: false });
}

function mockBullMqInstalled(
  ProcessorDecoratorService: ProcessorDecoratorServiceLike,
): void {
  vi.mocked(loadOptionalPeer).mockReturnValue({
    installed: true,
    module: { ProcessorDecoratorService },
  });
}

describe("QueueObserveAgentService", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let ProcessorDecoratorService: ProcessorDecoratorServiceLike;
  let originalDecorate: ProcessorDecoratorServiceLike["prototype"]["decorate"];

  beforeEach(() => {
    vi.mocked(loadOptionalPeer).mockReset();
    ProcessorDecoratorService = createFakeProcessorDecoratorService();
    originalDecorate = ProcessorDecoratorService.prototype.decorate;

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
    ProcessorDecoratorService.prototype.decorate = originalDecorate;
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it("stays silent when @nestjs/bullmq is not installed", () => {
    mockBullMqMissing();

    expect(() => new QueueObserveAgentService()).not.toThrow();
    expect(ProcessorDecoratorService.prototype.decorate).toBe(originalDecorate);
  });

  it("wraps decorated processors in a CONSUMER span", async () => {
    mockBullMqInstalled(ProcessorDecoratorService);
    new QueueObserveAgentService();

    const decorate = ProcessorDecoratorService.prototype.decorate;
    expect(decorate).toEqual(expect.any(Function));
    expect(decorate).not.toBe(originalDecorate);

    const job: FakeJob = {
      queueName: "orders",
      name: "process",
      id: "job-1",
      timestamp: Date.now() - 5_000,
      processedOn: Date.now(),
      delay: 0,
      attemptsMade: 2,
      opts: { attempts: 5 },
      data: { secret: "must-not-appear-on-span" },
    };
    const processor = vi.fn(async () => "done");
    const wrapped = decorate!(processor);

    await expect(wrapped(job)).resolves.toBe("done");
    expect(processor).toHaveBeenCalledWith(job);

    const [span] = exporter.getFinishedSpans();
    expect(span.kind).toBe(SpanKind.CONSUMER);
    expect(span.name).toBe("job orders process");
    expect(span.attributes["messaging.system"]).toBe("bullmq");
    expect(span.attributes["messaging.destination"]).toBe("orders");
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(span.attributes)).not.toContain(
      "must-not-appear-on-span",
    );
  });

  it("records processor failures on the span", async () => {
    mockBullMqInstalled(ProcessorDecoratorService);
    new QueueObserveAgentService();

    const decorate = ProcessorDecoratorService.prototype.decorate!;
    const failure = new Error("deliberate");
    const wrapped = decorate(async () => {
      throw failure;
    });

    await expect(
      wrapped({
        queueName: "orders",
        name: "fail",
        id: "job-2",
      }),
    ).rejects.toThrow(failure);

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
  });
});

describe("ObserveModule queue agent registration", () => {
  afterEach(() => {
    resetSdkForTests();
  });

  it("registers QueueObserveAgentService on the ObserveModule class", () => {
    const { ObserveModule } = createObserveModule();
    const providers: unknown[] =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ObserveModule) ?? [];
    expect(providers).toContain(QueueObserveAgentService);
  });
});
