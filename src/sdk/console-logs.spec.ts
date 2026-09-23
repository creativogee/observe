import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { ConsoleLogger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSensitiveFields,
  resetSensitiveFieldsForTests,
} from "../sanitizer/redact.js";
import {
  installConsoleLogExport,
  uninstallConsoleLogExport,
} from "./console-logs.js";

afterEach(() => {
  uninstallConsoleLogExport();
  resetSensitiveFieldsForTests();
  vi.restoreAllMocks();
});

describe("installConsoleLogExport", () => {
  it("calls the original console.error and emits ERROR", () => {
    const original = console.error;
    const printed = vi.fn();
    console.error = printed;
    const emit = vi.fn();
    vi.spyOn(logs, "getLogger").mockReturnValue({ emit } as never);

    installConsoleLogExport("warn");
    console.error("boom", 1);

    expect(printed).toHaveBeenCalledWith("boom", 1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "boom 1",
        severityNumber: SeverityNumber.ERROR,
        severityText: "ERROR",
      }),
    );
    console.error = original;
  });

  it("does not emit console.info when min level is warn", () => {
    const emit = vi.fn();
    vi.spyOn(logs, "getLogger").mockReturnValue({ emit } as never);
    const printed = vi.spyOn(console, "info").mockImplementation(() => {});

    installConsoleLogExport("warn");
    console.info("skip-me");

    expect(emit).not.toHaveBeenCalled();
    printed.mockRestore();
  });

  it("does not wrap console.error twice", () => {
    const emit = vi.fn();
    vi.spyOn(logs, "getLogger").mockReturnValue({ emit } as never);
    installConsoleLogExport("error");
    const wrapped = console.error;
    installConsoleLogExport("error");
    expect(console.error).toBe(wrapped);
  });

  it("still prints when emit throws", () => {
    const printed = vi.fn();
    const original = console.error;
    console.error = printed;
    vi.spyOn(logs, "getLogger").mockReturnValue({
      emit: () => {
        throw new Error("exporter down");
      },
    } as never);

    installConsoleLogExport("error");
    expect(() => console.error("kept")).not.toThrow();
    expect(printed).toHaveBeenCalledWith("kept");
    console.error = original;
  });

  it("emits Nest ConsoleLogger messages written directly to process streams", () => {
    const emit = vi.fn();
    vi.spyOn(logs, "getLogger").mockReturnValue({ emit } as never);
    const logger = new ConsoleLogger("Test", {
      colors: false,
      logLevels: ["error", "warn", "log", "debug", "verbose"],
    });

    installConsoleLogExport("debug");
    logger.error("nest error");
    logger.warn("nest warning");
    logger.log("nest info");
    logger.debug("nest debug");
    logger.verbose("nest verbose");

    expect(emit.mock.calls.map(([record]) => record)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: "nest error",
          severityNumber: SeverityNumber.ERROR,
          severityText: "ERROR",
        }),
        expect.objectContaining({
          body: "nest warning",
          severityNumber: SeverityNumber.WARN,
          severityText: "WARN",
        }),
        expect.objectContaining({
          body: "nest info",
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
        }),
        expect.objectContaining({
          body: "nest debug",
          severityNumber: SeverityNumber.DEBUG,
          severityText: "DEBUG",
        }),
        expect.objectContaining({
          body: "nest verbose",
          severityNumber: SeverityNumber.DEBUG,
          severityText: "DEBUG",
        }),
      ]),
    );
  });

  it("warns once when log export runs with no declared fields", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installConsoleLogExport("error");

    console.error("first");
    console.error("second");

    const unredactedWarnings = warn.mock.calls.filter(([message]) =>
      String(message).includes("no sensitive fields are declared"),
    );
    // Once, not once per log line: this is a configuration mistake, not an
    // event worth repeating on every record.
    expect(unredactedWarnings).toHaveLength(1);
  });

  it("stays quiet once fields are declared", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    addSensitiveFields(["password"]);
    installConsoleLogExport("error");

    console.error("first");

    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes("no sensitive fields are declared"),
      ),
    ).toHaveLength(0);
  });

  it("restores ConsoleLogger.printMessages on uninstall", () => {
    const prototype = ConsoleLogger.prototype as unknown as Record<
      string,
      unknown
    >;
    const original = prototype.printMessages;

    installConsoleLogExport("warn");
    expect(prototype.printMessages).not.toBe(original);

    uninstallConsoleLogExport();
    expect(prototype.printMessages).toBe(original);
  });
});
