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
 */
@Injectable()
export class ScheduleObserveAgentService {
  constructor() {
    this.patchScheduleExplorer();
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
