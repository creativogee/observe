import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import { loadOptionalPeer } from "../utils/optional-peer.js";

const TOPIC_PATCHED = Symbol.for("@crudmates/observe:pubsub-topic-patched");
const SUBSCRIPTION_PATCHED = Symbol.for(
  "@crudmates/observe:pubsub-subscription-patched",
);
const WRAPPED_MESSAGE_LISTENER = Symbol.for(
  "@crudmates/observe:pubsub-message-listener",
);
const TRACER_NAME = "@crudmates/observe";

type StringAttributes = Record<string, string>;

/** The `@google-cloud/pubsub` message shape this module reads. */
type PubsubMessage = {
  data?: unknown;
  attributes?: StringAttributes;
  id?: string;
  orderingKey?: string;
};

type TopicPrototype = {
  name?: string;
  publishMessage?: (message: PubsubMessage, ...rest: unknown[]) => unknown;
  publish?: (
    data: unknown,
    attributes?: StringAttributes,
    ...rest: unknown[]
  ) => unknown;
  [TOPIC_PATCHED]?: boolean;
};

type SubscriptionPrototype = {
  name?: string;
  on?: (
    event: string | symbol,
    listener: (...args: unknown[]) => unknown,
    ...rest: unknown[]
  ) => unknown;
  [SUBSCRIPTION_PATCHED]?: boolean;
};

type Ctor<T> = { prototype: T };

type GcpPubsubModule = {
  Topic?: Ctor<TopicPrototype>;
  Subscription?: Ctor<SubscriptionPrototype>;
  default?: {
    Topic?: Ctor<TopicPrototype>;
    Subscription?: Ctor<SubscriptionPrototype>;
  };
};

const attributeSetter: TextMapSetter<StringAttributes> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

const attributeGetter: TextMapGetter<StringAttributes> = {
  get(carrier, key) {
    return carrier[key];
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

/**
 * Pub/Sub resource names are fully qualified - `projects/p/topics/orders`.
 * Only the trailing segment is useful as a span attribute; the project is
 * already on the resource.
 */
function shortResourceName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    return "";
  }
  const segments = name.split("/");
  return segments[segments.length - 1] ?? "";
}

function recordSpanError(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

function resolveClass<T>(
  module: GcpPubsubModule | undefined,
  key: "Topic" | "Subscription",
): Ctor<T> | undefined {
  if (!module) {
    return undefined;
  }
  const direct = module[key];
  if (direct?.prototype) {
    return direct as Ctor<T>;
  }
  const fromDefault = module.default?.[key];
  if (fromDefault?.prototype) {
    return fromDefault as Ctor<T>;
  }
  return undefined;
}

/**
 * Patches `Topic#publishMessage` to inject W3C trace context into the
 * message's `attributes`, which is the only part of a Pub/Sub message that
 * survives the broker and reaches the subscriber. Without this a consumer
 * starts a brand-new trace and the causal link to the publisher is lost.
 */
function wrapPublishMessage(proto: TopicPrototype): void {
  const original = proto.publishMessage;
  if (typeof original !== "function") {
    return;
  }

  proto.publishMessage = function wrappedPublishMessage(
    this: TopicPrototype,
    message: PubsubMessage,
    ...rest: unknown[]
  ) {
    const destination = shortResourceName(this?.name);
    const run = (msg: PubsubMessage) => original.call(this, msg, ...rest);

    let traced: PubsubMessage = message;
    try {
      const attributes: StringAttributes = { ...message?.attributes };
      propagation.inject(context.active(), attributes, attributeSetter);
      traced = { ...message, attributes };
    } catch {
      // Injection must never cost a publish.
      return run(message);
    }

    let started = false;
    try {
      return trace.getTracer(TRACER_NAME).startActiveSpan(
        `publish ${destination}`,
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            "messaging.system": "gcp_pubsub",
            "messaging.destination.name": destination,
            "messaging.operation.type": "publish",
          },
        },
        (span) => {
          started = true;
          let result: unknown;
          try {
            result = run(traced);
          } catch (error) {
            recordSpanError(span, error);
            span.end();
            throw error;
          }
          if (isThenable(result)) {
            return result.then(
              (value) => {
                span.end();
                return value;
              },
              (error: unknown) => {
                recordSpanError(span, error);
                span.end();
                throw error;
              },
            );
          }
          span.end();
          return result;
        },
      );
    } catch (error) {
      // If the tracer itself threw before the callback ran, still publish.
      if (started) {
        throw error;
      }
      return run(traced);
    }
  };
}

/**
 * Legacy `Topic#publish(data, attributes)`. Deprecated by Google in favour of
 * `publishMessage`, but still present and still used, so it gets the same
 * injection rather than silently producing untraceable messages.
 */
function wrapLegacyPublish(proto: TopicPrototype): void {
  const original = proto.publish;
  if (typeof original !== "function") {
    return;
  }

  proto.publish = function wrappedPublish(
    this: TopicPrototype,
    data: unknown,
    attributes?: StringAttributes,
    ...rest: unknown[]
  ) {
    // Delegate to the patched `publishMessage` when it is available so the
    // span and injection live in exactly one place.
    if (typeof this.publishMessage === "function") {
      return this.publishMessage({ data, attributes: { ...attributes } });
    }
    return original.call(this, data, attributes, ...rest);
  };
}

function attributesFromMessage(message: unknown): StringAttributes {
  if (typeof message !== "object" || message === null) {
    return {};
  }
  const attrs = (message as { attributes?: unknown }).attributes;
  if (!attrs || typeof attrs !== "object") {
    return {};
  }
  return { ...(attrs as StringAttributes) };
}

function messageId(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Wraps a `subscription.on("message", handler)` listener so the handler runs
 * inside a CONSUMER span parented to the publisher's context, recovered from
 * the message attributes.
 */
function wrapMessageListener(
  originalListener: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  const wrapped = function wrappedMessageListener(
    this: SubscriptionPrototype,
    ...args: unknown[]
  ) {
    const run = () => originalListener.apply(this, args);
    let started = false;
    try {
      const extracted = propagation.extract(
        context.active(),
        attributesFromMessage(args[0]),
        attributeGetter,
      );
      const destination = shortResourceName(this?.name);
      const id = messageId(args[0]);
      const attributes: Record<string, string> = {
        "messaging.system": "gcp_pubsub",
        "messaging.destination.name": destination,
        "messaging.operation.type": "receive",
      };
      if (id !== undefined) {
        attributes["messaging.message.id"] = id;
      }

      return context.with(extracted, () =>
        trace
          .getTracer(TRACER_NAME)
          .startActiveSpan(
            `receive ${destination}`,
            { kind: SpanKind.CONSUMER, attributes },
            (span) => {
              started = true;
              let result: unknown;
              try {
                result = run();
              } catch (error) {
                recordSpanError(span, error);
                span.end();
                throw error;
              }
              if (isThenable(result)) {
                return result.then(
                  (value) => {
                    span.end();
                    return value;
                  },
                  (error: unknown) => {
                    recordSpanError(span, error);
                    span.end();
                    throw error;
                  },
                );
              }
              span.end();
              return result;
            },
          ),
      );
    } catch (error) {
      if (started) {
        throw error;
      }
      return run();
    }
  };
  Object.defineProperty(wrapped, WRAPPED_MESSAGE_LISTENER, { value: true });
  return wrapped;
}

function wrapSubscriptionOn(proto: SubscriptionPrototype): void {
  if (proto[SUBSCRIPTION_PATCHED]) {
    return;
  }
  const originalOn = proto.on;
  if (typeof originalOn !== "function") {
    return;
  }
  proto[SUBSCRIPTION_PATCHED] = true;

  proto.on = function wrappedOn(
    this: SubscriptionPrototype,
    event: string | symbol,
    listener: (...args: unknown[]) => unknown,
    ...rest: unknown[]
  ) {
    let wrappedListener = listener;
    try {
      if (
        event === "message" &&
        typeof listener === "function" &&
        !(WRAPPED_MESSAGE_LISTENER in listener)
      ) {
        wrappedListener = wrapMessageListener(listener);
      }
    } catch {
      wrappedListener = listener;
    }
    return (originalOn as (...params: unknown[]) => unknown).call(
      this,
      event,
      wrappedListener,
      ...rest,
    );
  };
}

function wrapTopicPrototype(proto: TopicPrototype): void {
  if (proto[TOPIC_PATCHED]) {
    return;
  }
  proto[TOPIC_PATCHED] = true;
  wrapPublishMessage(proto);
  wrapLegacyPublish(proto);
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as Promise<unknown>).then === "function"
  );
}

/**
 * Patches `@google-cloud/pubsub` so publishes inject W3C trace context into
 * message attributes and `message` listeners extract it. This is what keeps a
 * trace intact across an asynchronous hop: without it, every consumer is a
 * new trace root and the publisher that caused the work is invisible.
 *
 * The package is an optional peer. A project that does not use Pub/Sub is
 * unaffected, and any failure while patching leaves the library untouched
 * rather than breaking messaging.
 */
export function wrapGooglePubsub(): void {
  try {
    const result = loadOptionalPeer<GcpPubsubModule>("@google-cloud/pubsub");
    if (!result?.installed || result.error || !result.module) {
      return;
    }

    const Topic = resolveClass<TopicPrototype>(result.module, "Topic");
    if (Topic?.prototype) {
      wrapTopicPrototype(Topic.prototype);
    }

    const Subscription = resolveClass<SubscriptionPrototype>(
      result.module,
      "Subscription",
    );
    if (Subscription?.prototype) {
      wrapSubscriptionOn(Subscription.prototype);
    }

    if (!Topic?.prototype && !Subscription?.prototype) {
      console.warn(
        "Observe: @google-cloud/pubsub is installed but neither Topic nor Subscription could be wrapped; Pub/Sub messages will not carry trace context.",
      );
    }
  } catch (error) {
    console.warn(
      `Observe: failed to wrap @google-cloud/pubsub: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
