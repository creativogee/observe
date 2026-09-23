import { Injectable } from "@nestjs/common";
import { SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import {
  describePeerLoadError,
  loadOptionalPeer,
} from "../utils/optional-peer.js";

/** BullMQ job fields this agent reads. Structurally typed so `bullmq` stays optional. */
type BullMqJob = {
  queueName: string;
  name: string;
  id?: string | number;
  timestamp?: number;
  processedOn?: number;
  delay?: number;
  attemptsMade?: number;
  opts?: { attempts?: number };
};

type BullMqProcessor = (job: BullMqJob) => unknown;

/** The `ProcessorDecoratorService` surface this service patches, structurally typed. */
interface ProcessorDecoratorServiceLike {
  prototype?: {
    decorate?: (processor: BullMqProcessor) => (job: BullMqJob) => unknown;
  };
}

type QueueSpanAttributes = {
  "messaging.system": "bullmq";
  "messaging.destination": string;
  "messaging.operation"?: string;
  "messaging.message.id"?: string;
  "messaging.consumer.wait.duration.ms"?: number;
  "messaging.consumer.attempts"?: number;
  "messaging.consumer.max_attempts"?: number;
  "messaging.message.enqueued.time"?: string;
};

@Injectable()
export class QueueObserveAgentService {
  constructor() {
    this.patchDecorate();
  }

  /**
   * Fields absent from BullMQ's Job type when a driver doesn't populate them
   * are simply omitted, not reported as zero.
   */
  private readQueueMetadata(job: BullMqJob): Partial<QueueSpanAttributes> {
    const metadata: Partial<QueueSpanAttributes> = {};

    if (typeof job.timestamp === "number") {
      metadata["messaging.message.enqueued.time"] = new Date(
        job.timestamp,
      ).toISOString();

      const startedAt =
        typeof job.processedOn === "number" ? job.processedOn : Date.now();

      // `timestamp` is job-creation time, not runnable time - for a delayed
      // job the gap is a schedule the caller asked for, not backlog. Without
      // subtracting `delay`, a job dated a week out would report a week of
      // wait.
      const availableAt = job.timestamp + (job.delay ?? 0);
      metadata["messaging.consumer.wait.duration.ms"] = Math.max(
        0,
        startedAt - availableAt,
      );
    }

    if (typeof job.attemptsMade === "number") {
      metadata["messaging.consumer.attempts"] = job.attemptsMade;
    }

    const maxAttempts = job.opts?.attempts;
    if (typeof maxAttempts === "number") {
      metadata["messaging.consumer.max_attempts"] = maxAttempts;
    }

    return metadata;
  }

  /** `undefined` when the package isn't installed; `null` when it is but doesn't expose the decorator service. */
  private loadProcessorDecoratorService():
    ProcessorDecoratorServiceLike | null | undefined {
    const result = loadOptionalPeer<{
      ProcessorDecoratorService?: ProcessorDecoratorServiceLike;
    }>("@nestjs/bullmq");
    if (!result.installed) {
      return undefined;
    }
    if (result.error) {
      console.warn(
        `@nestjs/bullmq is installed but its processor decorator could not be loaded: ${describePeerLoadError(result.error)}`,
      );
      return null;
    }
    return result.module?.ProcessorDecoratorService ?? null;
  }

  private patchDecorate(): void {
    const ProcessorDecoratorService = this.loadProcessorDecoratorService();
    if (ProcessorDecoratorService === undefined) {
      return;
    }
    if (!ProcessorDecoratorService?.prototype) {
      console.warn(
        "ProcessorDecoratorService is not available. Please, update to the latest version of @nestjs/bullmq. Skipping patching.",
      );
      return;
    }

    const tracer = trace.getTracer("@crudmates/observe");

    ProcessorDecoratorService.prototype["decorate"] =
      (processor: BullMqProcessor) => (job: BullMqJob) => {
        const attributes: QueueSpanAttributes = {
          "messaging.system": "bullmq",
          "messaging.destination": job.queueName,
          "messaging.operation": job.name,
          ...this.readQueueMetadata(job),
        };

        if (job.id != null) {
          attributes["messaging.message.id"] =
            typeof job.id === "number" ? `${job.id}` : String(job.id);
        }

        return tracer.startActiveSpan(
          `job ${job.queueName} ${job.name}`,
          { kind: SpanKind.CONSUMER, attributes },
          async (span: Span) => {
            try {
              return await processor(job);
            } catch (err) {
              span.recordException(err as Error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw err;
            } finally {
              span.end();
            }
          },
        );
      };
  }
}
