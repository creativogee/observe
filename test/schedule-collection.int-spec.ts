import { SchedulerRegistry } from "@nestjs/schedule";
import { trace } from "@opentelemetry/api";
import { CronJob } from "cron";
import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScheduleObserveAgentService } from "../src/protocols/schedule-observe-agent.service.js";
import {
  shutdownInMemoryOtel,
  startInMemoryOtel,
} from "../src/testing/in-memory-otel.js";

delete process.env.OBSERVE_ENDPOINT;

const { exporter, started } = startInMemoryOtel();

/**
 * Against the real `@nestjs/schedule` and `cron`, not fakes.
 *
 * The unit tests prove the wrapping logic; this proves the seam still exists
 * in the shipped packages. It is the check that would have caught the gap
 * this test file was written for: `ScheduleExplorer` only sees decorator-based
 * handlers, so a job registered through `SchedulerRegistry.addCronJob` ran
 * with no active span and its database work surfaced as orphan root spans.
 */
describe("Scheduled job collection (real @nestjs/schedule)", () => {
  beforeAll(() => {
    new ScheduleObserveAgentService();
  });

  afterAll(async () => {
    await shutdownInMemoryOtel(started);
  });

  beforeEach(() => {
    exporter.reset();
  });

  it("wraps a dynamically registered CronJob in a named span", async () => {
    const registry = new SchedulerRegistry();
    let ran = false;
    const job = new CronJob("0 0 1 1 *", () => {
      ran = true;
    });
    registry.addCronJob("outbox-drain", job);

    await job.fireOnTick();

    expect(ran).toBe(true);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toContain(
      "cron outbox-drain",
    );
  });

  it("parents the job's own work under the job span", async () => {
    const registry = new SchedulerRegistry();
    const job = new CronJob("0 0 1 1 *", () => {
      // Stands in for the `pg.query` spans the real outbox drain produces.
      trace.getTracer("test").startActiveSpan("pg.query:UPDATE", (child) => {
        child.end();
      });
    });
    registry.addCronJob("outbox-drain", job);

    await job.fireOnTick();

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "cron outbox-drain");
    const child = spans.find((s) => s.name === "pg.query:UPDATE");
    expect(parent).toBeDefined();
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
    expect(child?.spanContext().traceId).toBe(parent?.spanContext().traceId);
  });

  it("registers the job with the registry regardless", () => {
    const registry = new SchedulerRegistry();
    const job = new CronJob("0 0 1 1 *", () => undefined);
    registry.addCronJob("inventory-alerts", job);

    expect(registry.getCronJob("inventory-alerts")).toBe(job);
  });
});
