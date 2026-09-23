import {
  Controller,
  Inject,
  Injectable,
  Module,
  type INestMicroservice,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SpanKind } from "@opentelemetry/api";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createObserveModule } from "../src/observe.module.js";
import {
  shutdownInMemoryOtel,
  startInMemoryOtel,
} from "../src/testing/in-memory-otel.js";

async function tryLoadGrpc(): Promise<
  | {
      ok: true;
      microservices: typeof import("@nestjs/microservices");
      grpcJs: typeof import("@grpc/grpc-js");
      protoLoader: typeof import("@grpc/proto-loader");
    }
  | { ok: false }
> {
  try {
    const microservices = await import("@nestjs/microservices");
    const grpcJs = await import("@grpc/grpc-js");
    const protoLoader = await import("@grpc/proto-loader");
    return { ok: true, microservices, grpcJs, protoLoader };
  } catch {
    return { ok: false };
  }
}

/** Unary gRPC client method: request in, Node-style callback out. */
type UnaryGrpcMethod = (
  request: unknown,
  callback: (error: unknown, response: unknown) => void,
) => void;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const grpc = await tryLoadGrpc();

describe.skipIf(!grpc.ok)("gRPC collection", () => {
  if (!grpc.ok) {
    return;
  }

  delete process.env.OBSERVE_ENDPOINT;

  const { exporter, started } = startInMemoryOtel();
  const { ObserveModule, ObserveInstrument } = createObserveModule();
  const { GrpcMethod, Transport } = grpc.microservices;
  const { credentials, loadPackageDefinition } = grpc.grpcJs;
  const { loadSync } = grpc.protoLoader;
  const protoPath = fileURLToPath(
    new URL("./ping.test.proto", import.meta.url),
  );

  @Injectable()
  class PingService {
    pong() {
      return { message: "pong" };
    }
  }

  @Controller()
  class PingGrpcController {
    constructor(
      @Inject(PingService) private readonly pingService: PingService,
    ) {}

    @GrpcMethod("Ping", "Pong")
    pong() {
      return this.pingService.pong();
    }
  }

  @Module({
    imports: [ObserveModule.forRoot()],
    controllers: [PingGrpcController],
    providers: [PingService],
  })
  class GrpcTestModule {}

  let app: INestMicroservice;
  let client: { Pong: UnaryGrpcMethod; close?: () => void };

  beforeAll(async () => {
    const port = await freePort();
    const url = `127.0.0.1:${port}`;

    app = await NestFactory.createMicroservice(GrpcTestModule, {
      transport: Transport.GRPC,
      options: {
        package: "pingtest",
        protoPath,
        url,
      },
      instrument: ObserveInstrument,
      logger: false,
    } as never);
    await app.listen();

    const definition = loadSync(protoPath, {
      keepCase: true,
      defaults: true,
      oneofs: true,
    });
    const proto = loadPackageDefinition(definition) as unknown as {
      pingtest: {
        Ping: new (
          address: string,
          creds: ReturnType<typeof credentials.createInsecure>,
        ) => { Pong: UnaryGrpcMethod; close?: () => void };
      };
    };
    client = new proto.pingtest.Ping(url, credentials.createInsecure());
  });

  afterAll(async () => {
    client?.close?.();
    await app?.close();
    await shutdownInMemoryOtel(started);
  });

  beforeEach(() => {
    exporter.reset();
  });

  it("records a gRPC SERVER span and PingService.pong", async () => {
    await new Promise<unknown>((resolve, reject) => {
      client.Pong({}, (error: unknown, response: unknown) =>
        // grpc-js always calls back with a `ServiceError` (extends `Error`)
        // or `null`, never a bare non-Error value.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        error ? reject(error) : resolve(response),
      );
    });

    const spans = exporter.getFinishedSpans();
    const server = spans.find((span) => span.kind === SpanKind.SERVER);
    const method = spans.find((span) => span.name === "PingService.pong");

    expect(server).toBeDefined();
    expect(method).toBeDefined();
    expect(method!.spanContext().traceId).toBe(server!.spanContext().traceId);

    // One RPC must produce exactly one SERVER span. GrpcInstrumentation opens
    // it from `grpc.Server.register`; RpcObserveAgentService's Nest RPC hook
    // sees a span already on the context and stands down. If that ordering
    // ever inverts, both fire and every RPC is double-counted.
    const serverSpans = spans.filter((span) => span.kind === SpanKind.SERVER);
    expect(
      serverSpans.map((span) => span.name),
      "duplicate gRPC SERVER spans",
    ).toHaveLength(1);

    // The collector's spanmetrics connector builds gRPC RED from these
    // dimensions. RpcObserveAgentService's fallback span carries none of
    // them, so losing GrpcInstrumentation would silently empty the RED
    // dashboards rather than break a trace.
    expect(server!.instrumentationScope?.name).toBe(
      "@opentelemetry/instrumentation-grpc",
    );
    expect(server!.attributes).toMatchObject({
      "rpc.system": "grpc",
      "rpc.service": "pingtest.Ping",
      "rpc.method": "Pong",
    });
  });
});
