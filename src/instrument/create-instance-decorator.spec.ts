import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInstanceDecorator } from "./create-instance-decorator.js";

class TestService {
  work() {
    return "ok";
  }

  recurse(n: number): number {
    return n <= 0 ? 0 : this.recurse(n - 1);
  }
}

describe("createInstanceDecorator", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    context.disable();
    trace.disable();

    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);

    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it("produces a child span named TestService.work inside an active root span", () => {
    const decorate = createInstanceDecorator({
      skipInstrumentation: () => false,
    });
    const service = decorate(new TestService()) as TestService;
    const tracer = trace.getTracer("@crudmates/observe");

    tracer.startActiveSpan("root", (root) => {
      service.work();
      root.end();
    });

    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.name === "root");
    const child = spans.find((span) => span.name === "TestService.work");

    expect(root).toBeDefined();
    expect(child).toBeDefined();
    expect(child!.parentSpanContext?.spanId).toBe(root!.spanContext().spanId);
  });

  it("does not record a span when called outside any active span", () => {
    const decorate = createInstanceDecorator({
      skipInstrumentation: () => false,
    });
    const service = decorate(new TestService()) as TestService;

    service.work();

    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it("leaves the instance unproxied when skipInstrumentation returns true", () => {
    const instance = new TestService();
    // Reference identity only, never invoked detached from `instance`.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalWork = instance.work;
    const decorate = createInstanceDecorator({
      skipInstrumentation: () => true,
    });
    const decorated = decorate(instance) as TestService;

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(decorated.work).toBe(originalWork);
  });

  it("does not throw on recursive / re-entrant calls", () => {
    const decorate = createInstanceDecorator({
      skipInstrumentation: () => false,
    });
    const service = decorate(new TestService()) as TestService;
    const tracer = trace.getTracer("@crudmates/observe");

    expect(() => {
      tracer.startActiveSpan("root", (root) => {
        service.recurse(3);
        root.end();
      });
    }).not.toThrow();
  });
});
