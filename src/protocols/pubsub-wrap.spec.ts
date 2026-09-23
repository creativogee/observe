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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOptionalPeer } from "../utils/optional-peer.js";

vi.mock("../utils/optional-peer.js", () => ({
  loadOptionalPeer: vi.fn(),
  describePeerLoadError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

/** W3C example traceparent (version-traceId-parentSpanId-flags). */
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const PARENT_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

type Attributes = Record<string, string>;

type PublishedMessage = {
  data?: unknown;
  attributes?: Attributes;
};

/**
 * Stand-ins for `@google-cloud/pubsub`'s `Topic` and `Subscription`, carrying
 * only the surface this module patches: `publishMessage` / `publish` on the
 * topic, and `EventEmitter#on` on the subscription.
 */
class FakeTopic {
  static lastPublished: PublishedMessage | undefined;
  static shouldThrow = false;
  name = "projects/demo/topics/orders";

  publishMessage(message: PublishedMessage): Promise<string> {
    FakeTopic.lastPublished = message;
    if (FakeTopic.shouldThrow) {
      return Promise.reject(new Error("publish failed"));
    }
    return Promise.resolve("message-id-1");
  }

  publish(data: unknown, attributes?: Attributes): Promise<string> {
    FakeTopic.lastPublished = { data, attributes };
    return Promise.resolve("message-id-legacy");
  }
}

class FakeSubscription extends EventEmitter {
  name = "projects/demo/subscriptions/orders-worker";
}

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

async function importFreshWrapper() {
  vi.resetModules();
  return import("./pubsub-wrap.js");
}

function mockPeer(module: unknown, installed = true): void {
  vi.mocked(loadOptionalPeer).mockReturnValue({
    installed,
    module,
  });
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  FakeTopic.lastPublished = undefined;
  FakeTopic.shouldThrow = false;
  vi.mocked(loadOptionalPeer).mockReset();
});

afterEach(async () => {
  contextManager.disable();
  context.disable();
  trace.disable();
  propagation.disable();
  await provider.shutdown();
});

describe("Google Pub/Sub trace propagation", () => {
  it("injects traceparent into message attributes on publishMessage", async () => {
    mockPeer({ Topic: FakeTopic, Subscription: FakeSubscription });
    const { wrapGooglePubsub } = await importFreshWrapper();
    wrapGooglePubsub();

    const topic = new FakeTopic();
    await trace.getTracer("test").startActiveSpan("caller", async (span) => {
      await topic.publishMessage({ data: Buffer.from("payload") });
      span.end();
    });

    expect(FakeTopic.lastPublished?.attributes?.traceparent).toBeDefined();
  });

  it("preserves caller attributes while adding trace context", async () => {
    mockPeer({ Topic: FakeTopic, Subscription: FakeSubscription });
    const { wrapGooglePubsub } = await importFreshWrapper();
    wrapGooglePubsub();

    const topic = new FakeTopic();
    await topic.publishMessage({
      data: Buffer.from("payload"),
      attributes: { tenant: "acme" },
    });

    expect(FakeTopic.lastPublished?.attributes?.tenant).toBe("acme");
  });

  it("records a PRODUCER span named for the short topic name", async () => {
    mockPeer({ Topic: FakeTopic, Subscription: FakeSubscription });
    const { wrapGooglePubsub } = await importFreshWrapper();
    wrapGooglePubsub();

    await new FakeTopic().publishMessage({ data: Buffer.from("payload") });

    const span = exporter.getFinishedSpans().at(-1);
    expect(span?.name).toBe("publish orders");
    expect(span?.kind).toBe(SpanKind.PRODUCER);
    expect(span?.attributes["messaging.destination.name"]).toBe("orders");
    expect(span?.attributes["messaging.system"]).toBe("gcp_pubsub");
  });

  it("marks the publish span ERROR when the publish rejects", async () => {
    mockPeer({ Topic: FakeTopic, Subscription: FakeSubscription });
    const { wrapGooglePubsub } = await importFreshWrapper();
    wrapGooglePubsub();
    FakeTopic.shouldThrow = true;

    await expect(
      new FakeTopic().publishMessage({ data: Buffer.from("payload") }),
    ).rejects.toThrow("publish failed");

    const span = exporter.getFinishedSpans().at(-1);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("routes legacy publish(data, attributes) through publishMessage", async () => {
    mockPeer({ Topic: FakeTopic, Subscription: FakeSubscription });
    const { wrapGooglePubsub } = await importFreshWrapper();
    wrapGooglePubsub();

    const topic = new FakeTopic();
    await trace.getTracer("test").startActiveSpan("caller", async (span) => {
      await topic.publish(Buffer.from("payload"), { tenant: "acme" });
      span.end();
    });

    // Legacy callers must not lose propagation just for using the old API.
    expect(FakeTopic.lastPublished?.attributes?.traceparent).toBeDefined();
    expect(FakeTopic.lastPublished?.attributes?.tenant).toBe("acme");
  });

  it("extracts traceparent so the message handler runs in the publisher's trace", async () => {
    mockPeer({ Topic: FakeTopic, Subscription: FakeSubscription });
    const { wrapGooglePubsub } = await importFreshWrapper();
    wrapGooglePubsub();

    const subscription = new FakeSubscription();
    let observedTraceId: string | undefined;
    subscription.on("message", () => {
      observedTraceId = trace.getSpan(context.active())?.spanContext().traceId;
    });

    subscription.emit("message", {
      data: Buffer.from("payload"),
      attributes: { traceparent: TRACEPARENT },
      id: "msg-1",
    });

    // The whole point: consumer work joins the producer's trace rather than
    // starting a new root.
    expect(observedTraceId).toBe(PARENT_TRACE_ID);
  });

  it("records a CONSUMER span carrying the message id", async () => {
    mockPeer({ Topic: FakeTopic, Subscription: FakeSubscription });
    const { wrapGooglePubsub } = await importFreshWrapper();
    wrapGooglePubsub();

    const subscription = new FakeSubscription();
    subscription.on("message", () => undefined);
    subscription.emit("message", {
      data: Buffer.from("payload"),
      attributes: { traceparent: TRACEPARENT },
      id: "msg-7",
    });

    const span = exporter.getFinishedSpans().at(-1);
    expect(span?.name).toBe("receive orders-worker");
    expect(span?.kind).toBe(SpanKind.CONSUMER);
    expect(span?.attributes["messaging.message.id"]).toBe("msg-7");
  });

  it("marks the receive span ERROR when the handler throws", async () => {
    mockPeer({ Topic: FakeTopic, Subscription: FakeSubscription });
    const { wrapGooglePubsub } = await importFreshWrapper();
    wrapGooglePubsub();

    const subscription = new FakeSubscription();
    subscription.on("message", () => {
      throw new Error("handler failed");
    });

    expect(() =>
      subscription.emit("message", {
        data: Buffer.from("payload"),
        attributes: {},
      }),
    ).toThrow("handler failed");

    const span = exporter.getFinishedSpans().at(-1);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("does not double-wrap a listener registered twice", async () => {
    mockPeer({ Topic: FakeTopic, Subscription: FakeSubscription });
    const { wrapGooglePubsub } = await importFreshWrapper();
    wrapGooglePubsub();
    wrapGooglePubsub();

    const subscription = new FakeSubscription();
    subscription.on("message", () => undefined);
    subscription.emit("message", {
      data: Buffer.from("payload"),
      attributes: {},
    });

    const receiveSpans = exporter
      .getFinishedSpans()
      .filter((span) => span.kind === SpanKind.CONSUMER);
    expect(receiveSpans).toHaveLength(1);
  });

  it("leaves non-message events untouched", async () => {
    mockPeer({ Topic: FakeTopic, Subscription: FakeSubscription });
    const { wrapGooglePubsub } = await importFreshWrapper();
    wrapGooglePubsub();

    const subscription = new FakeSubscription();
    const onError = vi.fn();
    subscription.on("error", onError);
    subscription.emit("error", new Error("transport"));

    expect(onError).toHaveBeenCalledOnce();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("is a no-op when @google-cloud/pubsub is not installed", async () => {
    mockPeer(undefined, false);
    const { wrapGooglePubsub } = await importFreshWrapper();

    expect(() => wrapGooglePubsub()).not.toThrow();
  });

  it("resolves Topic and Subscription from a default export", async () => {
    // A distinct class: `FakeTopic.prototype` may already carry the patch
    // marker from an earlier test, which would make this assertion pass
    // without ever exercising default-export resolution.
    class DefaultExportTopic extends FakeTopic {}
    mockPeer({
      default: { Topic: DefaultExportTopic, Subscription: FakeSubscription },
    });
    const { wrapGooglePubsub } = await importFreshWrapper();
    wrapGooglePubsub();

    const topic = new DefaultExportTopic();
    await trace.getTracer("test").startActiveSpan("caller", async (span) => {
      await topic.publishMessage({ data: Buffer.from("payload") });
      span.end();
    });

    expect(FakeTopic.lastPublished?.attributes?.traceparent).toBeDefined();
  });
});
