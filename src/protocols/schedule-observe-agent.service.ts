import { Injectable } from "@nestjs/common";
import { SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import {
  describePeerLoadError,
  loadOptionalPeer,
} from "../utils/optional-peer.js";

/**
 * `@nestjs/schedule`'s metadata keys and scheduler-type enum, inlined so the
 * package stays an optional peer. `@Cron`/`@Interval`/`@Timeout` stamp all
 * three onto the handler: which kind of scheduler it is, the name it was given
 * (if any), and the options the decorator was called with.
 */
const SCHEDULER_TYPE = "SCHEDULER_TYPE";
const SCHEDULER_NAME = "SCHEDULER_NAME";
const SCHEDULE_CRON_OPTIONS = "SCHEDULE_CRON_OPTIONS";

/** `SchedulerType` from `@nestjs/schedule`, by value. */
const SCHEDULER_TYPE_LABELS: Record<number, string> = {
  1: "cron",
  2: "timeout",
  3: "interval",
};

/**
 * The `CronJob` surface this service wraps. `fireOnTick` is what the cron
 * library calls on every trigger, so wrapping it covers every callback
 * registered on that job.
 */
interface CronJobLike {
  fireOnTick?: (...args: unknown[]) => unknown;
}

/**
 * The `SchedulerRegistry` surface this service patches. Only `addCronJob` is
 * instrumentable: `addInterval` and `addTimeout` receive an already-scheduled
 * handle rather than a callback, so by the time the registry sees them the
 * function is beyond reach.
 */
interface SchedulerRegistryLike {
  prototype?: {
    addCronJob?: (
      name: string,
      job: CronJobLike,
      ...rest: unknown[]
    ) => unknown;
  };
}

/** The `ScheduleExplorer` surface this service patches, structurally typed. */
interface ScheduleExplorerLike {
  prototype?: {
    wrapFunctionInTryCatchBlocks?: WrapFunction;
  };
}

type ScheduledHandler = (...args: unknown[]) => unknown;
type WrapFunction = (
  this: unknown,
  methodRef: ScheduledHandler,
  instance: object,
) => ScheduledHandler;

/**
 * Scheduled job instrumentation for `@nestjs/schedule`.
 *
 * `ScheduleExplorer` routes every discovered handler through
 * `wrapFunctionInTryCatchBlocks(methodRef, instance)` before registering it -
 * one seam covering `@Cron`/`@Interval`/`@Timeout` alike. Patched on the
 * prototype from the constructor, before the explorer's own `onModuleInit`
 * runs discovery. The explorer's wrapper is kept and ours goes inside it, so
 * a throwing handler is still logged as before, just also reported.
 *
 * That seam only covers handlers the explorer *discovers* - the decorator
 * forms. Jobs registered at runtime with
 * `schedulerRegistry.addCronJob(name, new CronJob(...))` never reach the
 * explorer, so they need a second seam: `SchedulerRegistry.addCronJob`, where
 * the job object is still in hand and its `fireOnTick` can be wrapped.
 * Without it those jobs run with no active span and their database work is
 * reported as orphan root spans, with nothing naming the job that caused it.
 */
@Injectable()
export class ScheduleObserveAgentService {
  constructor() {
    this.patchScheduleExplorer();
    this.patchSchedulerRegistry();
  }

  /**
   * Loaded from the constructor, not lazily: a dynamic `import()` could
   * resolve after the explorer's own `onModuleInit` already wrapped every
   * handler.
   */
  private loadScheduleExplorer(): ScheduleExplorerLike | undefined {
    type ExplorerModule = { ScheduleExplorer?: ScheduleExplorerLike };

    const entryPoint = loadOptionalPeer<ExplorerModule>("@nestjs/schedule");
    if (!entryPoint.installed) {
      return undefined;
    }
    if (entryPoint.module?.ScheduleExplorer) {
      return entryPoint.module.ScheduleExplorer;
    }

    const deepPath = loadOptionalPeer<ExplorerModule>(
      "@nestjs/schedule",
      "@nestjs/schedule/dist/schedule.explorer.js",
    );
    if (deepPath.installed && deepPath.module?.ScheduleExplorer) {
      return deepPath.module.ScheduleExplorer;
    }

    const cause =
      (deepPath.installed && deepPath.error) ||
      entryPoint.error ||
      new Error("ScheduleExplorer is not exported by @nestjs/schedule");
    console.warn(
      `@nestjs/schedule is installed but its ScheduleExplorer could not be loaded, so scheduled jobs will not be instrumented: ${describePeerLoadError(cause)}`,
    );
    return undefined;
  }

  private patchScheduleExplorer(): void {
    const ScheduleExplorer = this.loadScheduleExplorer();
    if (!ScheduleExplorer) {
      return;
    }

    const prototype = ScheduleExplorer.prototype;
    const originalWrap = prototype?.wrapFunctionInTryCatchBlocks;
    if (typeof originalWrap !== "function") {
      console.warn(
        "The installed version of @nestjs/schedule does not expose 'ScheduleExplorer.wrapFunctionInTryCatchBlocks', so scheduled jobs cannot be instrumented. Skipping patching.",
      );
      return;
    }

    const PATCHED = Symbol.for("@crudmates/observe:schedule-patched");
    const marked = originalWrap as WrapFunction & { [PATCHED]?: true };
    if (marked[PATCHED]) {
      return;
    }

    const instrument = (methodRef: ScheduledHandler, instance: object) =>
      this.instrumentHandler(methodRef, instance);

    const patched: WrapFunction & { [PATCHED]?: true } = function (
      this: unknown,
      methodRef,
      instance,
    ) {
      return originalWrap.call(this, instrument(methodRef, instance), instance);
    };
    patched[PATCHED] = true;
    prototype!.wrapFunctionInTryCatchBlocks = patched;
  }

  private describeHandler(
    methodRef: ScheduledHandler,
    instance: object,
  ): { schedulerType: string; name: string } {
    const schedulerTypeValue = Reflect.getMetadata(
      SCHEDULER_TYPE,
      methodRef,
    ) as number | undefined;
    const cronOptions = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      methodRef,
    ) as { name?: string } | undefined;
    const explicitName =
      (Reflect.getMetadata(SCHEDULER_NAME, methodRef) as string | undefined) ??
      cronOptions?.name;

    const className = instance?.constructor?.name || "Object";
    const methodName = methodRef.name || "anonymous";

    return {
      schedulerType:
        (schedulerTypeValue !== undefined &&
          SCHEDULER_TYPE_LABELS[schedulerTypeValue]) ||
        "schedule",
      name: explicitName || `${className}.${methodName}`,
    };
  }

  /**
   * Loads `SchedulerRegistry` from the package entry point. Unlike
   * `ScheduleExplorer` this is public API, so the entry point always has it
   * when the package is installed.
   */
  private loadSchedulerRegistry(): SchedulerRegistryLike | undefined {
    type RegistryModule = { SchedulerRegistry?: SchedulerRegistryLike };
    const entryPoint = loadOptionalPeer<RegistryModule>("@nestjs/schedule");
    if (!entryPoint.installed) {
      return undefined;
    }
    if (entryPoint.module?.SchedulerRegistry) {
      return entryPoint.module.SchedulerRegistry;
    }
    console.warn(
      `@nestjs/schedule is installed but its SchedulerRegistry could not be loaded, so dynamically registered cron jobs will not be instrumented: ${describePeerLoadError(
        entryPoint.error ??
          new Error("SchedulerRegistry is not exported by @nestjs/schedule"),
      )}`,
    );
    return undefined;
  }

  private patchSchedulerRegistry(): void {
    const SchedulerRegistry = this.loadSchedulerRegistry();
    const prototype = SchedulerRegistry?.prototype;
    const original = prototype?.addCronJob;
    if (!prototype || typeof original !== "function") {
      return;
    }

    const PATCHED = Symbol.for("@crudmates/observe:scheduler-registry-patched");
    const marked = original as typeof original & { [PATCHED]?: true };
    if (marked[PATCHED]) {
      return;
    }

    const instrument = (name: string, job: CronJobLike) =>
      this.instrumentCronJob(name, job);

    const patched = function (
      this: unknown,
      name: string,
      job: CronJobLike,
      ...rest: unknown[]
    ) {
      try {
        instrument(name, job);
      } catch {
        // Never let instrumentation stop a job from being registered.
      }
      return original.call(this, name, job, ...rest);
    } as NonNullable<typeof original> & { [PATCHED]?: true };
    patched[PATCHED] = true;
    prototype.addCronJob = patched;
  }

  /**
   * Wraps one job's `fireOnTick` so each trigger runs inside a span the job's
   * own work is parented to. Marked on the instance so re-registering the same
   * job object cannot nest the span twice.
   */
  private instrumentCronJob(name: string, job: CronJobLike): void {
    const originalFire = job?.fireOnTick;
    if (typeof originalFire !== "function") {
      return;
    }
    const JOB_PATCHED = Symbol.for("@crudmates/observe:cron-job-patched");
    const marked = job as CronJobLike & { [JOB_PATCHED]?: true };
    if (marked[JOB_PATCHED]) {
      return;
    }

    const run = (...args: unknown[]) =>
      this.runInSpan(`cron ${name}`, () => originalFire.apply(job, args));
    job.fireOnTick = run;
    Object.defineProperty(job, JOB_PATCHED, {
      value: true,
      enumerable: false,
    });
  }

  /**
   * Runs `work` inside an active span, awaiting a promise result so the span
   * covers the whole job rather than just its synchronous prologue.
   */
  private runInSpan<T>(spanName: string, work: () => T | Promise<T>) {
    return trace
      .getTracer("@crudmates/observe")
      .startActiveSpan(
        spanName,
        { kind: SpanKind.INTERNAL },
        async (span: Span) => {
          try {
            return await work();
          } catch (err) {
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw err;
          } finally {
            span.end();
          }
        },
      );
  }

  private instrumentHandler(
    methodRef: ScheduledHandler,
    instance: object,
  ): ScheduledHandler {
    const { schedulerType, name } = this.describeHandler(methodRef, instance);
    const tracer = trace.getTracer("@crudmates/observe");
    const spanName = `${schedulerType} ${name}`;

    return (...args: unknown[]) =>
      tracer.startActiveSpan(
        spanName,
        { kind: SpanKind.INTERNAL },
        async (span: Span) => {
          try {
            const returnValue = methodRef.call(instance, ...args);
            if (returnValue instanceof Promise) {
              return await returnValue;
            }
            return returnValue;
          } catch (err) {
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw err;
          } finally {
            span.end();
          }
        },
      );
  }
}
