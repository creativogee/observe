import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOptionalPeer } from "../utils/optional-peer.js";
import {
  loadInstrumentations,
  observeGrpcClientInterceptor,
  resetInstrumentationsForTests,
} from "./instrumentations.js";

vi.mock("../utils/optional-peer.js", () => ({
  loadOptionalPeer: vi.fn(),
  describePeerLoadError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

const { mocks } = vi.hoisted(() => {
  function named(name: string) {
    return vi.fn(function InstrumentationMock(
      this: { name: string; options: unknown },
      options?: unknown,
    ) {
      this.name = name;
      this.options = options;
    });
  }
  return {
    mocks: {
      RuntimeNodeInstrumentation: named("runtime-node"),
      HttpInstrumentation: named("http"),
      UndiciInstrumentation: named("undici"),
      PgInstrumentation: named("pg"),
      IORedisInstrumentation: named("ioredis"),
      RedisInstrumentation: named("redis"),
      GrpcInstrumentation: named("grpc"),
    },
  };
});

vi.mock("@opentelemetry/instrumentation-runtime-node", () => ({
  RuntimeNodeInstrumentation: mocks.RuntimeNodeInstrumentation,
}));
vi.mock("@opentelemetry/instrumentation-http", () => ({
  HttpInstrumentation: mocks.HttpInstrumentation,
}));
vi.mock("@opentelemetry/instrumentation-undici", () => ({
  UndiciInstrumentation: mocks.UndiciInstrumentation,
}));
vi.mock("@opentelemetry/instrumentation-pg", () => ({
  PgInstrumentation: mocks.PgInstrumentation,
}));
vi.mock("@opentelemetry/instrumentation-ioredis", () => ({
  IORedisInstrumentation: mocks.IORedisInstrumentation,
}));
vi.mock("@opentelemetry/instrumentation-redis", () => ({
  RedisInstrumentation: mocks.RedisInstrumentation,
}));
vi.mock("@opentelemetry/instrumentation-grpc", () => ({
  GrpcInstrumentation: mocks.GrpcInstrumentation,
}));

class FakeInterceptingCall {
  constructor(
    readonly nextCall: unknown,
    readonly requester: {
      start: (
        metadata: { set: (key: string, value: string) => void },
        listener: unknown,
        next: (metadata: unknown, listener: unknown) => void,
      ) => void;
    },
  ) {}
}

const nestClientProxyFactory = {
  create: vi.fn((options: unknown) => options),
};
const nestMicroservices = {
  Transport: { GRPC: 4 },
  ClientProxyFactory: nestClientProxyFactory,
};

type PeerResult = { installed: false } | { installed: true; module: unknown };

function mockPeers(installed: Record<string, boolean | PeerResult>): void {
  vi.mocked(loadOptionalPeer).mockImplementation((pkg: string) => {
    const override = installed[pkg];
    if (override === false) {
      return { installed: false };
    }
    if (override && typeof override === "object") {
      return override;
    }
    if (pkg === "@grpc/grpc-js") {
      return {
        installed: true,
        module: { InterceptingCall: FakeInterceptingCall },
      };
    }
    if (pkg === "@nestjs/microservices") {
      return { installed: true, module: nestMicroservices };
    }
    return { installed: true, module: {} };
  });
}

function namesOf(instrumentations: Array<{ name?: string }>): string[] {
  return instrumentations.map((item) => item.name ?? item.constructor.name);
}

describe("loadInstrumentations", () => {
  beforeEach(() => {
    resetInstrumentationsForTests();
    nestClientProxyFactory.create.mockReset();
    nestClientProxyFactory.create.mockImplementation((options) => options);
    for (const ctor of Object.values(mocks)) {
      ctor.mockClear();
    }
    mocks.PgInstrumentation.mockImplementation(function PgInstrumentation(
      this: { name: string; options: unknown },
      options?: unknown,
    ) {
      this.name = "pg";
      this.options = options;
    });
  });

  it("always includes runtime-node instrumentation", () => {
    mockPeers({
      http: false,
      undici: false,
      pg: false,
      ioredis: false,
      redis: false,
      "@grpc/grpc-js": false,
    });

    const loaded = loadInstrumentations();

    expect(namesOf(loaded)).toEqual(["runtime-node", "undici"]);
    expect(mocks.RuntimeNodeInstrumentation).toHaveBeenCalledTimes(1);
    expect(mocks.UndiciInstrumentation).toHaveBeenCalledTimes(1);
  });

  it("registers UndiciInstrumentation even when the undici package is absent", () => {
    mockPeers({
      http: false,
      undici: false,
      pg: false,
      ioredis: false,
      redis: false,
      "@grpc/grpc-js": false,
    });

    expect(namesOf(loadInstrumentations())).toContain("undici");
    expect(mocks.UndiciInstrumentation).toHaveBeenCalledTimes(1);
  });

  it("does not throw if pg is absent and does not warn", () => {
    mockPeers({
      http: true,
      undici: false,
      pg: false,
      ioredis: false,
      redis: false,
      "@grpc/grpc-js": false,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => loadInstrumentations()).not.toThrow();
    const loaded = loadInstrumentations();

    expect(namesOf(loaded)).not.toContain("pg");
    expect(mocks.PgInstrumentation).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("loads HTTP client-only when http is resolvable", () => {
    mockPeers({
      http: true,
      undici: false,
      pg: false,
      ioredis: false,
      redis: false,
      "@grpc/grpc-js": false,
    });

    loadInstrumentations();

    expect(mocks.HttpInstrumentation).toHaveBeenCalledWith({
      disableIncomingRequestInstrumentation: true,
    });
  });

  it("loads undici, pg, ioredis, and redis when those packages exist", () => {
    mockPeers({
      http: false,
      undici: true,
      pg: true,
      ioredis: true,
      redis: true,
      "@grpc/grpc-js": false,
    });

    expect(namesOf(loadInstrumentations())).toEqual([
      "runtime-node",
      "undici",
      "pg",
      "ioredis",
      "redis",
    ]);
  });

  it("warns once and skips when an instrumentation constructor throws", () => {
    mockPeers({
      http: false,
      undici: false,
      pg: true,
      ioredis: false,
      redis: false,
      "@grpc/grpc-js": false,
    });
    mocks.PgInstrumentation.mockImplementation(function () {
      throw new Error("cannot patch pg");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = loadInstrumentations();
    const second = loadInstrumentations();

    expect(namesOf(first)).toEqual(["runtime-node", "undici"]);
    expect(namesOf(second)).toEqual(["runtime-node", "undici"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/pg/i);
    warn.mockRestore();
  });

  it("registers GrpcInstrumentation when @grpc/grpc-js is present", () => {
    mockPeers({
      http: false,
      undici: false,
      pg: false,
      ioredis: false,
      redis: false,
      "@grpc/grpc-js": true,
    });

    const loaded = loadInstrumentations();

    expect(namesOf(loaded)).toEqual(["runtime-node", "undici", "grpc"]);
    expect(mocks.GrpcInstrumentation).toHaveBeenCalledOnce();
    expect(loadOptionalPeer).toHaveBeenCalledWith(
      "@grpc/grpc-js",
      "@grpc/grpc-js",
      { probeOnly: true },
    );
  });

  it("patches Nest ClientProxyFactory so gRPC clients get the W3C interceptor", () => {
    mockPeers({
      http: false,
      undici: false,
      pg: false,
      ioredis: false,
      redis: false,
      "@grpc/grpc-js": true,
    });

    loadInstrumentations();

    const created = nestClientProxyFactory.create({
      transport: nestMicroservices.Transport.GRPC,
      options: {
        url: "localhost:5000",
        package: "orders",
        protoPath: "o.proto",
      },
    }) as {
      options: { channelOptions: { interceptors: unknown[] } };
    };

    expect(created.options.channelOptions.interceptors[0]).toBe(
      observeGrpcClientInterceptor,
    );
  });
});

describe("observeGrpcClientInterceptor", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    resetInstrumentationsForTests();
    mockPeers({ "@grpc/grpc-js": true });
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
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it("injects W3C traceparent into outgoing grpc metadata", () => {
    const span = trace.getTracer("test").startSpan("outbound");
    const metadata = { set: vi.fn() };
    const next = vi.fn();

    context.with(trace.setSpan(context.active(), span), () => {
      const intercepting = observeGrpcClientInterceptor({}, () => ({
        inner: true,
      })) as FakeInterceptingCall;
      intercepting.requester.start(metadata, {}, next);
    });
    span.end();

    expect(metadata.set).toHaveBeenCalledWith(
      "traceparent",
      expect.stringContaining(span.spanContext().traceId),
    );
    expect(next).toHaveBeenCalled();
  });
});
