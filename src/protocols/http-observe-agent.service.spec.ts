import "reflect-metadata";
import { EventEmitter } from "node:events";
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
import { RequestMethod } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { HttpAdapterHost } from "@nestjs/core";
import {
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
} from "@opentelemetry/semantic-conventions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createObserveModule } from "../observe.module.js";
import { resetSdkForTests } from "../sdk/start-sdk.js";
import { isIgnoredHttpPath } from "../utils/default-http-ignore.js";
import { HttpObserveAgentService } from "./http-observe-agent.service.js";

/** W3C example traceparent (version-traceId-parentSpanId-flags). */
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const PARENT_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";

type RequestHook = (
  req: { url: string; method: string; headers?: Record<string, string> },
  res: unknown,
  done: () => void,
) => void;

type ResponseHook = (req: unknown, res: { statusCode: number }) => void;

type RouteTriggeredHook = (requestMethod: RequestMethod, path: string) => void;

function createFakeAdapter() {
  let onRequest: RequestHook | undefined;
  let onResponse: ResponseHook | undefined;
  let onRouteTriggered: RouteTriggeredHook | undefined;
  const adapter = {
    setOnRequestHook(hook: RequestHook) {
      onRequest = hook;
    },
    setOnResponseHook(hook: ResponseHook) {
      onResponse = hook;
    },
    setOnRouteTriggered(hook: RouteTriggeredHook) {
      onRouteTriggered = hook;
    },
  };
  return {
    adapter,
    get onRequest() {
      return onRequest;
    },
    get onResponse() {
      return onResponse;
    },
    get onRouteTriggered() {
      return onRouteTriggered;
    },
  };
}

describe("isIgnoredHttpPath", () => {
  it.each(["/health", "/healthz", "/metrics", "/ready", "/live"])(
    "ignores default path %s",
    (path) => {
      expect(isIgnoredHttpPath(path)).toBe(true);
    },
  );

  it("strips the query string and matches the pathname", () => {
    expect(isIgnoredHttpPath("/health?ready=1")).toBe(true);
    expect(isIgnoredHttpPath("/metrics?foo=bar")).toBe(true);
  });

  it("prefix-matches subpaths of a default ignore path", () => {
    expect(isIgnoredHttpPath("/metrics/prometheus")).toBe(true);
    expect(isIgnoredHttpPath("/health/live")).toBe(true);
  });

  it("does not treat /health as a prefix of /healthz", () => {
    expect(isIgnoredHttpPath("/healthcare")).toBe(false);
  });

  it("does not ignore application routes", () => {
    expect(isIgnoredHttpPath("/orders")).toBe(false);
    expect(isIgnoredHttpPath("/orders?id=1")).toBe(false);
  });
});

describe("HttpObserveAgentService", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
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

  it("does not create a SERVER span for GET /health", () => {
    const fake = createFakeAdapter();
    new HttpObserveAgentService(
      { httpAdapter: fake.adapter } as unknown as HttpAdapterHost,
      {},
    );

    const req = { url: "/health", method: "GET", headers: {} };
    fake.onRequest!(req, {}, () => {});
    fake.onResponse!(req, { statusCode: 200 });

    const serverSpans = exporter
      .getFinishedSpans()
      .filter((span) => span.kind === SpanKind.SERVER);
    expect(serverSpans).toEqual([]);
    expect((req as { __observeSpan?: unknown }).__observeSpan).toBeUndefined();
  });

  it("creates a SERVER span for POST /orders with traceparent and ends it on response", () => {
    const fake = createFakeAdapter();
    new HttpObserveAgentService(
      { httpAdapter: fake.adapter } as unknown as HttpAdapterHost,
      {},
    );

    const req = {
      url: "/orders",
      method: "POST",
      headers: { traceparent: TRACEPARENT },
    };
    fake.onRequest!(req, {}, () => {
      const active = trace.getSpan(context.active());
      expect(active).toBeDefined();
      expect(active).toBe((req as { __observeSpan?: unknown }).__observeSpan);
    });

    expect(exporter.getFinishedSpans()).toEqual([]);
    expect((req as { __observeSpan?: unknown }).__observeSpan).toBeDefined();

    fake.onResponse!(req, { statusCode: 201 });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].name).toBe("POST /orders");
    expect(spans[0].spanContext().traceId).toBe(PARENT_TRACE_ID);
    expect(spans[0].parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    expect(spans[0].attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(201);
    expect(spans[0].status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("sets SpanStatusCode.ERROR when the response status is >= 500", () => {
    const fake = createFakeAdapter();
    new HttpObserveAgentService(
      { httpAdapter: fake.adapter } as unknown as HttpAdapterHost,
      {},
    );

    const req = {
      url: "/orders",
      method: "POST",
      headers: { traceparent: TRACEPARENT },
    };
    fake.onRequest!(req, {}, () => {});
    fake.onResponse!(req, { statusCode: 503 });

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(503);
  });

  it("renames the SERVER span to the Nest route when setOnRouteTriggered fires", () => {
    const fake = createFakeAdapter();
    new HttpObserveAgentService(
      { httpAdapter: fake.adapter } as unknown as HttpAdapterHost,
      {},
    );

    expect(fake.onRouteTriggered).toBeDefined();

    const req = { url: "/orders/42", method: "GET", headers: {} };
    fake.onRequest!(req, {}, () => {
      expect(trace.getSpan(context.active())).toBe(
        (req as { __observeSpan?: unknown }).__observeSpan,
      );
      fake.onRouteTriggered!(RequestMethod.GET, "/orders/:id");
    });
    fake.onResponse!(req, { statusCode: 200 });

    const [span] = exporter.getFinishedSpans();
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.name).toBe("GET /orders/:id");
    expect(span.attributes[ATTR_HTTP_ROUTE]).toBe("/orders/:id");
  });

  it("ends the SERVER span on response close when finish never fires", () => {
    const fake = createFakeAdapter();
    new HttpObserveAgentService(
      { httpAdapter: fake.adapter } as unknown as HttpAdapterHost,
      {},
    );

    const req = { url: "/orders", method: "GET", headers: {} };
    const res = new EventEmitter();
    fake.onRequest!(req, res, () => {});

    expect(exporter.getFinishedSpans()).toEqual([]);
    res.emit("close");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].name).toBe("GET /orders");
  });

  it("does not double-end the SERVER span when close fires after finish", () => {
    const fake = createFakeAdapter();
    new HttpObserveAgentService(
      { httpAdapter: fake.adapter } as unknown as HttpAdapterHost,
      {},
    );

    const req = { url: "/orders", method: "GET", headers: {} };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    fake.onRequest!(req, res, () => {});
    fake.onResponse!(req, res);

    expect(exporter.getFinishedSpans()).toHaveLength(1);
    res.emit("close");
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });
});

describe("ObserveModule HTTP agent registration", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    resetSdkForTests();
    vi.mocked(console.warn).mockRestore();
  });

  it("registers HttpObserveAgentService on the ObserveModule class", () => {
    const { ObserveModule } = createObserveModule();
    const providers: unknown[] =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ObserveModule) ?? [];
    expect(providers).toContain(HttpObserveAgentService);
  });
});
