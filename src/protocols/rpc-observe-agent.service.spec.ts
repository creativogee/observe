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
import type { ModulesContainer } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createObserveModule } from "../observe.module.js";
import { resetSdkForTests } from "../sdk/start-sdk.js";
import { loadOptionalPeer } from "../utils/optional-peer.js";
import {
  RpcObserveAgentService,
  resetRpcListenPatchForTests,
} from "./rpc-observe-agent.service.js";

vi.mock("../utils/optional-peer.js", () => ({
  loadOptionalPeer: vi.fn(),
  describePeerLoadError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

/** W3C example traceparent (version-traceId-parentSpanId-flags). */
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const PARENT_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";

const Transport = { GRPC: 4 } as const;

type StartHook = (
  transportId: number | symbol,
  ctx: unknown,
  done: () => unknown,
) => void;

type EndHook = (
  transportId: number | symbol,
  ctx: unknown,
  err?: unknown,
) => void;

function createFakeRpcTarget() {
  let onStart: StartHook | undefined;
  let onEnd: EndHook | undefined;
  const target = {
    setOnProcessingStartHook(hook: StartHook) {
      onStart = hook;
    },
    setOnProcessingEndHook(hook: EndHook) {
      onEnd = hook;
    },
  };
  return {
    target,
    get onStart() {
      return onStart;
    },
    get onEnd() {
      return onEnd;
    },
  };
}

function createModulesContainer(
  subscribe: (callback: (target: unknown) => void) => {
    unsubscribe: () => void;
  },
): ModulesContainer {
  return {
    getRpcTargetRegistry: () => ({ subscribe }),
  } as unknown as ModulesContainer;
}

function mockMicroservicesMissing(): void {
  vi.mocked(loadOptionalPeer).mockReturnValue({ installed: false });
}

function mockMicroservicesInstalled(): void {
  vi.mocked(loadOptionalPeer).mockReturnValue({
    installed: true,
    module: { Transport },
  });
}

describe("RpcObserveAgentService", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    vi.mocked(loadOptionalPeer).mockReset();
    resetRpcListenPatchForTests();
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
    resetRpcListenPatchForTests();
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it("does not throw when @nestjs/microservices is not installed", async () => {
    mockMicroservicesMissing();
    const subscribe = vi.fn();
    const agent = new RpcObserveAgentService(createModulesContainer(subscribe));

    await expect(agent.onModuleInit()).resolves.toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("hooks RPC when @nestjs/microservices is installed but fails to load", () => {
    vi.mocked(loadOptionalPeer).mockReturnValue({
      installed: true,
      module: undefined,
      error: new Error("ERR_REQUIRE_ESM"),
    });
    const subscribe = vi.fn(() => ({ unsubscribe: vi.fn() }));
    new RpcObserveAgentService(createModulesContainer(subscribe));
    expect(subscribe).toHaveBeenCalled();
  });

  it("installs RPC hooks when ServerGrpc.listen runs", async () => {
    const fake = createFakeRpcTarget();
    const originalListen = vi.fn(async () => "ok");
    const ServerGrpc = { prototype: { listen: originalListen } };
    vi.mocked(loadOptionalPeer).mockReturnValue({
      installed: true,
      module: { Transport, ServerGrpc },
    });
    new RpcObserveAgentService(
      createModulesContainer(() => ({ unsubscribe: vi.fn() })),
    );

    const result = await ServerGrpc.prototype.listen.call(fake.target);
    expect(result).toBe("ok");
    expect(fake.onStart).toBeDefined();
    expect(originalListen).toHaveBeenCalledOnce();
  });

  it("patches ServerGrpc.listen via ESM import when require fails", async () => {
    vi.mocked(loadOptionalPeer).mockReturnValue({
      installed: true,
      module: undefined,
      error: new Error("ERR_REQUIRE_ESM"),
    });
    const { ServerGrpc } =
      await import("@nestjs/microservices/server/server-grpc.js");
    // Reference identity only, never invoked detached from the prototype.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = ServerGrpc.prototype.listen;
    const fake = createFakeRpcTarget();
    const agent = new RpcObserveAgentService(
      createModulesContainer(() => ({ unsubscribe: vi.fn() })),
    );
    await agent.onModuleInit();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(ServerGrpc.prototype.listen).not.toBe(original);
    try {
      await ServerGrpc.prototype.listen.call(fake.target, () => {});
    } catch {
      // Real listen() needs a ServerGrpc instance; hooks install first.
    }
    expect(fake.onStart).toBeDefined();
    expect(fake.onEnd).toBeDefined();
  });

  it("creates a SERVER span as a child of the incoming traceparent", async () => {
    mockMicroservicesInstalled();
    const fake = createFakeRpcTarget();
    const agent = new RpcObserveAgentService(
      createModulesContainer((callback) => {
        callback(fake.target);
        return { unsubscribe: vi.fn() };
      }),
    );
    await agent.onModuleInit();

    expect(fake.onStart).toBeDefined();
    expect(fake.onEnd).toBeDefined();

    const call = {
      request: {},
      metadata: {
        getMap: () => ({ traceparent: TRACEPARENT }),
      },
      operationId: "Orders.FindOne",
    };

    // `onStart` is typed `unknown` to match production (`done()` may or may
    // not return a promise); here it always does.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await fake.onStart!(Transport.GRPC, call, () => {
      const active = trace.getSpan(context.active());
      expect(active).toBeDefined();
      expect(active?.spanContext().traceId).toBe(PARENT_TRACE_ID);
    });

    expect((call as { __observeSpan?: unknown }).__observeSpan).toBeUndefined();
    expect(
      (call.request as { __observeSpan?: unknown }).__observeSpan,
    ).toBeUndefined();
    expect(Object.keys(call.request)).toEqual([]);

    expect(exporter.getFinishedSpans()).toEqual([]);

    fake.onEnd!(Transport.GRPC, call);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].name).toBe("Orders.FindOne");
    expect(spans[0].spanContext().traceId).toBe(PARENT_TRACE_ID);
    expect(spans[0].parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    expect(spans[0].status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("ends the SERVER span when Nest's end hook receives call.request", async () => {
    mockMicroservicesInstalled();
    const fake = createFakeRpcTarget();
    const agent = new RpcObserveAgentService(
      createModulesContainer((callback) => {
        callback(fake.target);
        return { unsubscribe: vi.fn() };
      }),
    );
    await agent.onModuleInit();

    const request = {};
    const call = {
      request,
      metadata: { getMap: () => ({}) },
      operationId: "Ping.Pong",
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await fake.onStart!(Transport.GRPC, call, () => {});
    expect(
      (request as { __observeSpan?: unknown }).__observeSpan,
    ).toBeUndefined();
    expect(Object.keys(request)).toEqual([]);
    // Nest gRPC `createUnaryServiceMethod` passes `call.request`, not the
    // start-hook context that carries `operationId`.
    fake.onEnd!(Transport.GRPC, request);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].name).toBe("Ping.Pong");
  });

  it("sets SpanStatusCode.ERROR when the processing end hook receives an error", async () => {
    mockMicroservicesInstalled();
    const fake = createFakeRpcTarget();
    const agent = new RpcObserveAgentService(
      createModulesContainer((callback) => {
        callback(fake.target);
        return { unsubscribe: vi.fn() };
      }),
    );
    await agent.onModuleInit();

    const call = {
      request: {},
      metadata: { getMap: () => ({}) },
      operationId: "Orders.Explode",
    };
    const failure = new Error("deliberate");

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await fake.onStart!(Transport.GRPC, call, () => {});
    fake.onEnd!(Transport.GRPC, call, failure);

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
  });

  it("sets SpanStatusCode.ERROR when done() rejects, even though the real processing end hook never carries an error", async () => {
    // `@nestjs/microservices`' own `ServerGrpc` calls
    // `onProcessingEndHook?.(transportId, call.request)` with exactly two
    // arguments on every dispatch path - never a third `err`. A failed RPC
    // is only observable here as a rejection of the promise `done()` itself
    // returns.
    mockMicroservicesInstalled();
    const fake = createFakeRpcTarget();
    const agent = new RpcObserveAgentService(
      createModulesContainer((callback) => {
        callback(fake.target);
        return { unsubscribe: vi.fn() };
      }),
    );
    await agent.onModuleInit();

    const call = {
      request: {},
      metadata: { getMap: () => ({}) },
      operationId: "Orders.Explode",
    };
    const failure = new Error("deliberate rejection");

    await expect(
      fake.onStart!(Transport.GRPC, call, () => Promise.reject(failure)),
    ).rejects.toThrow(failure);

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
  });
});

describe("ObserveModule RPC agent registration", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    resetSdkForTests();
    vi.mocked(console.warn).mockRestore();
  });

  it("registers RpcObserveAgentService on the ObserveModule class", () => {
    const { ObserveModule } = createObserveModule();
    const providers: unknown[] =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ObserveModule) ?? [];
    expect(providers).toContain(RpcObserveAgentService);
  });
});
