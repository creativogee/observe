import { context } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { format } from "node:util";
import { hasSensitiveFields, redactLogArgs } from "../sanitizer/redact.js";
import { loadOptionalPeer } from "../utils/optional-peer.js";
import type { LogsMinLevel } from "./resolve-config.js";

type ConsoleMethod = "error" | "warn" | "info" | "log" | "debug";
type NestLogLevel = "error" | "warn" | "log" | "debug" | "verbose";
type NestConsoleLogger = { options?: { forceConsole?: boolean } };
type NestPrintMessages = (
  this: NestConsoleLogger,
  messages: unknown[],
  context?: string,
  logLevel?: string,
  ...args: unknown[]
) => unknown;
type NestConsoleLoggerPrototype = { printMessages: NestPrintMessages };

const ORIGINALS = new Map<ConsoleMethod, (...args: never[]) => unknown>();
let nestConsoleLoggerPatch:
  | {
      prototype: NestConsoleLoggerPrototype;
      original: NestPrintMessages;
    }
  | undefined;

const SEVERITY: Record<
  ConsoleMethod,
  { number: SeverityNumber; text: string }
> = {
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  info: { number: SeverityNumber.INFO, text: "INFO" },
  log: { number: SeverityNumber.INFO, text: "INFO" },
  debug: { number: SeverityNumber.DEBUG, text: "DEBUG" },
};

function methodsForMinLevel(min: LogsMinLevel): ConsoleMethod[] {
  switch (min) {
    case "error":
      return ["error"];
    case "warn":
      return ["error", "warn"];
    case "info":
      return ["error", "warn", "info", "log"];
    case "debug":
      return ["error", "warn", "info", "log", "debug"];
  }
}

let warnedNoRedaction = false;

/**
 * Redaction is opt-in, so a service that turns log export on and never
 * declares a field ships its log arguments verbatim to the telemetry backend.
 * That is a legitimate choice, but not one anybody should make by accident, so
 * say it once on the first exported record - by which point bootstrap has run
 * and a declaration would already be in place.
 *
 * Printed through the unpatched `console` method so the warning does not
 * re-enter the exporter it is warning about.
 */
function warnIfNothingDeclared(): void {
  if (warnedNoRedaction || hasSensitiveFields()) {
    return;
  }
  warnedNoRedaction = true;
  // Falls back to `console.warn` when `warn` is below the configured floor,
  // in which case it was never patched and is safe to call directly.
  const warn = (ORIGINALS.get("warn") ?? console.warn) as (
    message: string,
  ) => unknown;
  warn(
    "Observe: OBSERVE_LOGS is on but no sensitive fields are declared, so log arguments are exported unredacted. Call addSensitiveFields([...]) during bootstrap, before the first log is exported.",
  );
}

function emitLog(method: ConsoleMethod, args: unknown[]): void {
  warnIfNothingDeclared();
  const logger = logs.getLogger("@crudmates/observe");
  const { number, text } = SEVERITY[method];
  logger.emit({
    // Redacted before `format` flattens the arguments: once they are one
    // string there are no keys left to match on. The local console print
    // above is untouched and still shows the operator everything.
    body: format(...redactLogArgs(args)),
    severityNumber: number,
    severityText: text,
    context: context.active(),
  });
}

function consoleMethodForNestLevel(
  logLevel: string | undefined,
): ConsoleMethod | undefined {
  const level = logLevel as NestLogLevel;
  switch (level) {
    case "error":
    case "warn":
    case "log":
    case "debug":
      return level;
    case "verbose":
      return "debug";
    default:
      return undefined;
  }
}

function installNestConsoleLoggerExport(minLevel: LogsMinLevel): void {
  try {
    const nest = loadOptionalPeer<{
      ConsoleLogger?: { prototype: NestConsoleLoggerPrototype };
    }>("@nestjs/common");
    const prototype = nest.installed
      ? nest.module?.ConsoleLogger?.prototype
      : undefined;
    if (!prototype || typeof prototype.printMessages !== "function") {
      return;
    }

    const original = prototype.printMessages;
    nestConsoleLoggerPatch = { prototype, original };
    prototype.printMessages = function (
      this: NestConsoleLogger,
      messages,
      context,
      logLevel,
      ...args
    ) {
      const result = original.call(this, messages, context, logLevel, ...args);
      try {
        if (this.options?.forceConsole) {
          return result;
        }
        const method = consoleMethodForNestLevel(logLevel);
        if (method && methodsForMinLevel(minLevel).includes(method)) {
          emitLog(method, messages);
        }
      } catch {
        // Fail-open: Nest already printed the message.
      }
      return result;
    };
  } catch {
    // Fail-open: console methods remain patched even if Nest cannot be loaded.
  }
}

export function installConsoleLogExport(minLevel: LogsMinLevel): void {
  if (ORIGINALS.size > 0) {
    return;
  }
  for (const method of methodsForMinLevel(minLevel)) {
    const original = console[method].bind(console);
    ORIGINALS.set(method, original);
    console[method] = (...args: never[]) => {
      original(...args);
      try {
        emitLog(method, args);
      } catch {
        // Fail-open: local print already happened.
      }
    };
  }
  installNestConsoleLoggerExport(minLevel);
}

export function uninstallConsoleLogExport(): void {
  warnedNoRedaction = false;
  for (const [method, original] of ORIGINALS) {
    console[method] = original as typeof console.error;
  }
  ORIGINALS.clear();
  if (nestConsoleLoggerPatch) {
    nestConsoleLoggerPatch.prototype.printMessages =
      nestConsoleLoggerPatch.original;
    nestConsoleLoggerPatch = undefined;
  }
}
