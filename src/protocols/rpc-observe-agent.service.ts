import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import { NEST_GRPC_TRANSPORT_ID } from "../observe.constants.js";
import {
  describePeerLoadError,
  loadOptionalPeer,
} from "../utils/optional-peer.js";

type ServerGrpcListen = (...args: unknown[]) => unknown;
type ServerGrpcListenProto = { listen: ServerGrpcListen };

let serverGrpcListenPatched = false;
let patchedListenProto: ServerGrpcListenProto | undefined;
let originalServerGrpcListen: ServerGrpcListen | undefined;

/** Restores ServerGrpc.listen and clears the patch flag — tests only. */
export function resetRpcListenPatchForTests(): void {
  if (patchedListenProto && originalServerGrpcListen) {
    patchedListenProto.listen = originalServerGrpcListen;
  }
  patchedListenProto = undefined;
  originalServerGrpcListen = undefined;
  serverGrpcListenPatched = false;
}
const grpcRequestSpans = new WeakMap<object, Span>();

function setGrpcRequestSpan(target: object, span: Span): void {
  grpcRequestSpans.set(target, span);
}

function getGrpcRequestSpan(target: unknown): Span | undefined {
  if (target != null && typeof target === "object") {
    return grpcRequestSpans.get(target);
  }
  return undefined;
}

/**
 * The `@nestjs/microservices` surface this agent reads. Loaded on demand so
 * the package stays an optional peer: a service without it has no RPC target
 * to hook and must not fail to boot.
 */
type Microservices = {
  Transport: { GRPC: number | symbol };
  ServerGrpc?: {
    prototype: {
      listen: (...args: unknown[]) => unknown;
    };
  };
};

interface GrpcCall {
  request?: unknown;
  metadata?: unknown;
  operationId?: string;
}

type RpcServer = {
  setOnProcessingStartHook: (
    hook: (
      transportId: number | symbol,
      ctx: unknown,
      done: () => unknown,
    ) => unknown,
  ) => void;
  setOnProcessingEndHook: (
    hook: (transportId: number | symbol, ctx: unknown, err?: unknown) => void,
  ) => void;
};

@Injectable()
export class RpcObserveAgentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RpcObserveAgentService.name);
  private rpcTargetAddedSubscription: { unsubscribe: () => void } | undefined;
  /**
   * Set when `@nestjs/microservices` is installed. Hybrid apps announce the
   * gRPC server from `connectMicroservice()` *before* `onModuleInit`, so the
   * registry is subscribed from the constructor (ReplaySubject still covers
   * the reverse order).
   */
  private microservices: Microservices | undefined;

  constructor(private readonly modulesContainer: ModulesContainer) {
    this.microservices = this.loadMicroservices();
    this.patchServerGrpcListenSync();
    this.bindRpcTargetRegistry();
  }

  async onModuleInit(): Promise<void> {
    this.microservices ??= this.loadMicroservices();
    await this.patchServerGrpcListen();
    this.bindRpcTargetRegistry();
  }

  onModuleDestroy(): void {
    this.rpcTargetAddedSubscription?.unsubscribe();
  }

  /**
   * Loads `@nestjs/microservices` without a static import, so a service that
   * exposes no microservice need not install the package.
   */
  private loadMicroservices(): Microservices | undefined {
    const result = loadOptionalPeer<Microservices>("@nestjs/microservices");
    if (!result.installed) {
      return undefined;
    }
    if (!result.module) {
      return { Transport: { GRPC: NEST_GRPC_TRANSPORT_ID } };
    }
    return result.module;
  }

  /**
   * Hybrid `connectMicroservice()` never delivers the server to
   * `getRpcTargetRegistry` in time, so `ServerGrpc.listen` is patched instead.
   * The CJS probe runs synchronously in the constructor; `onModuleInit` also
   * awaits an ESM `import()` fallback for Nest 12's ESM build.
   */
  private patchServerGrpcListenSync(): void {
    this.applyListenPatch(this.microservices?.ServerGrpc?.prototype);
    if (serverGrpcListenPatched) {
      return;
    }
    const deep = loadOptionalPeer<{
      ServerGrpc?: { prototype: ServerGrpcListenProto };
    }>("@nestjs/microservices", "@nestjs/microservices/server/server-grpc.js");
    this.applyListenPatch(
      deep.installed ? deep.module?.ServerGrpc?.prototype : undefined,
    );
  }

  private async patchServerGrpcListen(): Promise<void> {
    this.patchServerGrpcListenSync();
    if (serverGrpcListenPatched) {
      return;
    }
    const present = loadOptionalPeer(
      "@nestjs/microservices",
      "@nestjs/microservices",
      { probeOnly: true },
    );
    if (!present.installed) {
      return;
    }
    try {
      const mod =
        (await import("@nestjs/microservices/server/server-grpc.js")) as {
          ServerGrpc?: { prototype: ServerGrpcListenProto };
        };
      this.applyListenPatch(mod.ServerGrpc?.prototype);
    } catch (error) {
      this.logger.warn(
        `@nestjs/microservices is installed but ServerGrpc.listen could not be patched: ${describePeerLoadError(error)}`,
      );
    }
  }

  private applyListenPatch(proto: ServerGrpcListenProto | undefined): void {
    if (
      serverGrpcListenPatched ||
      !proto ||
      typeof proto.listen !== "function"
    ) {
      return;
    }
    serverGrpcListenPatched = true;
    patchedListenProto = proto;
    const original = proto.listen;
    originalServerGrpcListen = original;
    const register = (target: RpcServer) => this.registerRpcHooks(target);
    proto.listen = function patchedListen(this: RpcServer, ...args: unknown[]) {
      register(this);
      return original.apply(this, args);
    };
  }

  private bindRpcTargetRegistry(): void {
    if (!this.microservices || this.rpcTargetAddedSubscription) {
      return;
    }
    const registry = this.modulesContainer.getRpcTargetRegistry?.<RpcServer>();
    if (!registry?.subscribe) {
      return;
    }
    this.rpcTargetAddedSubscription = registry.subscribe((target) =>
      this.registerRpcHooks(target),
    );
  }

  private isGrpcTransport(transportId: number | symbol): boolean {
    return (
      transportId === this.microservices?.Transport.GRPC ||
      transportId === NEST_GRPC_TRANSPORT_ID
    );
  }

  registerRpcHooks(target: RpcServer): void {
    target.setOnProcessingStartHook((transportId, ctx, done) => {
      if (this.isGrpcTransport(transportId)) {
        return this.startGrpcRequestTracing(ctx as GrpcCall, done);
      }
      return done();
    });

    target.setOnProcessingEndHook((transportId, ctx, err) => {
      if (this.isGrpcTransport(transportId)) {
        this.endGrpcRequestTracing(ctx as GrpcCall, err);
      }
    });
  }

  private startGrpcRequestTracing(
    call: GrpcCall,
    done: () => unknown,
  ): unknown {
    if (trace.getSpan(context.active())) {
      return done();
    }
    const extracted = propagation.extract(
      context.active(),
      toPropagationCarrier(call.metadata),
    );
    const span = trace
      .getTracer("@crudmates/observe")
      .startSpan(
        call.operationId ?? "unknown",
        { kind: SpanKind.SERVER },
        extracted,
      );
    setGrpcRequestSpan(call, span);
    // Nest's gRPC unary end hook passes `call.request`, not the start-hook
    // context object that carries `operationId`. Associate the span with the
    // request payload too so `onProcessingEndHook` can close it.
    if (call.request != null && typeof call.request === "object") {
      setGrpcRequestSpan(call.request, span);
    }
    return context.with(trace.setSpan(extracted, span), () => {
      const result = done();
      if (isThenable(result)) {
        // `.then(onFulfilled, onRejected)`, not `.finally()`: `.finally()`'s
        // callback takes no arguments, so a rejection from `done()` - the
        // only place an RPC failure is ever observable, since Nest's own
        // `onProcessingEndHook` never carries the error - would otherwise be
        // dropped instead of marking the span ERROR.
        return result.then(
          (value) => {
            if (span.isRecording()) {
              this.endGrpcRequestTracing(call);
            }
            return value;
          },
          (err) => {
            if (span.isRecording()) {
              this.endGrpcRequestTracing(call, err);
            }
            throw err;
          },
        );
      }
      return result;
    });
  }

  private endGrpcRequestTracing(call: GrpcCall, err?: unknown): void {
    const span = getGrpcRequestSpan(call);
    if (!span) {
      return;
    }
    if (err != null) {
      if (err instanceof Error) {
        span.recordException(err);
      }
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  }
}

/**
 * Maps gRPC metadata to a W3C text-map carrier. Nest's call object exposes
 * `grpc.Metadata` (`getMap()`) or, in tests, a plain header map.
 */
function toPropagationCarrier(metadata: unknown): Record<string, string> {
  if (metadata == null || typeof metadata !== "object") {
    return {};
  }
  const withGetMap = metadata as { getMap?: () => Record<string, unknown> };
  const map =
    typeof withGetMap.getMap === "function"
      ? withGetMap.getMap()
      : (metadata as Record<string, unknown>);
  const carrier: Record<string, string> = {};
  for (const [key, value] of Object.entries(map ?? {})) {
    const header = firstHeaderValue(value);
    if (header !== undefined) {
      carrier[key] = header;
    }
  }
  return carrier;
}

function firstHeaderValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return firstHeaderValue(value[0]);
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  // Last resort for a metadata value that is neither array nor Buffer -
  // a string or number in practice, from `grpc.Metadata.getMap()`.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as Promise<unknown>).then === "function"
  );
}
