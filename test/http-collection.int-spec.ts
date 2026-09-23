import "reflect-metadata";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  type INestApplication,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SpanKind } from "@opentelemetry/api";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createObserveModule } from "../src/observe.module.js";
import {
  shutdownInMemoryOtel,
  startInMemoryOtel,
} from "../src/testing/in-memory-otel.js";

delete process.env.OBSERVE_ENDPOINT;

const { exporter, started } = startInMemoryOtel();
const { ObserveModule, ObserveInstrument } = createObserveModule();

@Injectable()
class PingService {
  pong() {
    return { ok: true };
  }
}

@Controller()
class PingController {
  constructor(@Inject(PingService) private readonly pingService: PingService) {}

  @Get("ping")
  ping() {
    return this.pingService.pong();
  }

  @Get("health")
  health() {
    return { status: "ok" };
  }
}

@Module({
  imports: [ObserveModule.forRoot()],
  controllers: [PingController],
  providers: [PingService],
})
class HttpTestModule {}

describe("HTTP collection", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(HttpTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    await app.listen(0);
  });

  afterAll(async () => {
    await app?.close();
    await shutdownInMemoryOtel(started);
  });

  beforeEach(() => {
    exporter.reset();
  });

  it("records an HTTP SERVER root and PingService.pong on GET /ping", async () => {
    await request(app.getHttpServer()).get("/ping").expect(200);

    const spans = exporter.getFinishedSpans();
    const server = spans.find((span) => span.kind === SpanKind.SERVER);
    const method = spans.find((span) => span.name === "PingService.pong");

    expect(server).toBeDefined();
    expect(method).toBeDefined();
    expect(method!.spanContext().traceId).toBe(server!.spanContext().traceId);
  });

  it("does not record a SERVER span for GET /health", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);

    const servers = exporter
      .getFinishedSpans()
      .filter((span) => span.kind === SpanKind.SERVER);
    expect(servers).toEqual([]);
  });
});
