import { context, propagation } from "@opentelemetry/api";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { GrpcInstrumentation } from "@opentelemetry/instrumentation-grpc";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { loadOptionalPeer } from "../utils/optional-peer.js";

const warnedConstructors = new Set<string>();

let grpcClientUnpatch: (() => void) | undefined;

type GrpcMetadata = {
  set: (key: string, value: string) => void;
};

type GrpcJs = {
  InterceptingCall: new (
    nextCall: unknown,
    requester?: {
      start?: (
        metadata: GrpcMetadata,
        listener: unknown,
        next: (metadata: GrpcMetadata, listener: unknown) => void,
      ) => void;
    },
  ) => unknown;
};

type NestGrpcClientOptions = {
  transport?: number | symbol;
  options?: {
    channelOptions?: {
      interceptors?: unknown[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

type NestMicroservices = {
  Transport: { GRPC: number | symbol };
  ClientProxyFactory: {
    create: (
      clientOptions: NestGrpcClientOptions,
      customClass?: unknown,
    ) => unknown;
  };
};

/** Resets constructor-warn and gRPC client-patch state — tests only. */
export function resetInstrumentationsForTests(): void {
  warnedConstructors.clear();
  grpcClientUnpatch?.();
  grpcClientUnpatch = undefined;
}

function peerResolvable(packageName: string): boolean {
  return loadOptionalPeer(packageName, packageName, { probeOnly: true })
    .installed;
}

function tryConstruct(
  name: string,
  factory: () => Instrumentation,
): Instrumentation | undefined {
  try {
    return factory();
  } catch (error) {
    if (!warnedConstructors.has(name)) {
      warnedConstructors.add(name);
      console.warn(
        `Observe: failed to construct ${name} instrumentation; skipping`,
        error,
      );
    }
    return undefined;
  }
}

function pushIfConstructed(
  list: Instrumentation[],
  name: string,
  factory: () => Instrumentation,
): void {
  const instrumentation = tryConstruct(name, factory);
  if (instrumentation) {
    list.push(instrumentation);
  }
}

/**
 * Nest / `@grpc/grpc-js` client interceptor: copies W3C `traceparent` /
 * `tracestate` from the active OTel context into outgoing call metadata.
 * `GrpcInstrumentation` below only patches the server and client transport,
 * not Nest's `ClientProxyFactory`, so outgoing propagation needs this
 * separate interceptor installed by `installGrpcClientPropagation`.
 */
export function observeGrpcClientInterceptor(
  options: unknown,
  nextCall: (options: unknown) => unknown,
): unknown {
  const next = nextCall(options);
  const grpcJs = loadOptionalPeer<GrpcJs>("@grpc/grpc-js");
  if (!grpcJs.installed || !grpcJs.module?.InterceptingCall) {
    return next;
  }
  return new grpcJs.module.InterceptingCall(next, {
    start(metadata, listener, nextStart) {
      try {
        propagation.inject(context.active(), metadata, {
          set(carrier, key, value) {
            carrier.set(key, value);
          },
        });
      } catch {
        // Never block the RPC if propagation fails.
      }
      nextStart(metadata, listener);
    },
  });
}

function withGrpcClientInterceptor(
  clientOptions: NestGrpcClientOptions,
  grpcTransport: number | symbol,
): NestGrpcClientOptions {
  if (clientOptions?.transport !== grpcTransport) {
    return clientOptions;
  }
  const options = { ...clientOptions.options };
  const channelOptions = { ...options.channelOptions };
  const interceptors = channelOptions.interceptors ?? [];
  if (!interceptors.includes(observeGrpcClientInterceptor)) {
    channelOptions.interceptors = [
      observeGrpcClientInterceptor,
      ...interceptors,
    ];
  }
  options.channelOptions = channelOptions;
  return { ...clientOptions, options };
}

function installGrpcClientPropagation(): void {
  if (grpcClientUnpatch) {
    return;
  }

  const nest = loadOptionalPeer<NestMicroservices>("@nestjs/microservices");
  if (!nest.installed) {
    return;
  }
  const factory = nest.module?.ClientProxyFactory;
  const grpcTransport = nest.module?.Transport?.GRPC;
  if (
    !factory ||
    typeof factory.create !== "function" ||
    grpcTransport == null
  ) {
    if (nest.module) {
      if (!warnedConstructors.has("grpc-client-interceptor")) {
        warnedConstructors.add("grpc-client-interceptor");
        console.warn(
          "Observe: @nestjs/microservices is installed but ClientProxyFactory could not be patched for gRPC client W3C injection; skipping",
        );
      }
    }
    return;
  }

  const original = factory.create;
  factory.create = (clientOptions, customClass) =>
    original.call(
      factory,
      withGrpcClientInterceptor(clientOptions, grpcTransport),
      customClass,
    );
  grpcClientUnpatch = () => {
    factory.create = original;
  };
}

export function loadInstrumentations(): Instrumentation[] {
  const instrumentations: Instrumentation[] = [];

  pushIfConstructed(
    instrumentations,
    "runtime-node",
    () => new RuntimeNodeInstrumentation(),
  );

  if (peerResolvable("http")) {
    pushIfConstructed(
      instrumentations,
      "http",
      () =>
        new HttpInstrumentation({
          disableIncomingRequestInstrumentation: true,
        }),
    );
  }

  // Node 20+ provides `fetch` via undici; do not gate on the `undici` package.
  pushIfConstructed(
    instrumentations,
    "undici",
    () => new UndiciInstrumentation(),
  );

  if (peerResolvable("@grpc/grpc-js")) {
    pushIfConstructed(
      instrumentations,
      "grpc",
      () => new GrpcInstrumentation(),
    );
    try {
      installGrpcClientPropagation();
    } catch (error) {
      if (!warnedConstructors.has("grpc-client-interceptor")) {
        warnedConstructors.add("grpc-client-interceptor");
        console.warn(
          "Observe: failed to install gRPC client W3C interceptor; skipping",
          error,
        );
      }
    }
  }

  if (peerResolvable("pg")) {
    pushIfConstructed(instrumentations, "pg", () => new PgInstrumentation());
  }

  if (peerResolvable("ioredis")) {
    pushIfConstructed(
      instrumentations,
      "ioredis",
      () => new IORedisInstrumentation(),
    );
  }

  if (peerResolvable("redis")) {
    pushIfConstructed(
      instrumentations,
      "redis",
      () => new RedisInstrumentation(),
    );
  }

  return instrumentations;
}
