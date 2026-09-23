import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObserveOptionsFactory } from "./interfaces/observe-options.interface.js";
import { OBSERVE_OPTIONS } from "./observe.constants.js";
import { createObserveModule } from "./observe.module.js";
import {
  resetSdkForTests,
  startSdk,
  type StartedSdk,
} from "./sdk/start-sdk.js";

vi.mock("./sdk/start-sdk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sdk/start-sdk.js")>();
  return {
    ...actual,
    startSdk: vi.fn(() => actual.startSdk()),
  };
});

const AGENT_SKIP_NAMES = [
  "HttpObserveAgentService",
  "RpcObserveAgentService",
  "QueueObserveAgentService",
  "ScheduleObserveAgentService",
  "ObserveMetrics",
] as const;

function instanceNamed(name: string): object {
  const classes = { [name]: class {} };
  return new classes[name]();
}

async function shutdownStartedSdks(): Promise<void> {
  for (const result of vi.mocked(startSdk).mock.results) {
    const started = result.value as StartedSdk | undefined;
    if (started?.sdk) {
      await started.sdk.shutdown();
    }
  }
}

describe("createObserveModule", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(startSdk).mockClear();
  });

  afterEach(async () => {
    await shutdownStartedSdks();
    resetSdkForTests();
    vi.mocked(console.warn).mockRestore();
    delete process.env.OBSERVE_ENDPOINT;
  });

  it("starts the SDK, returns an instanceDecorator, and boots forRoot", async () => {
    const { ObserveModule, ObserveInstrument } = createObserveModule();

    const moduleRef = await Test.createTestingModule({
      imports: [ObserveModule.forRoot()],
    }).compile();

    expect(startSdk).toHaveBeenCalled();
    expect(typeof ObserveInstrument.instanceDecorator).toBe("function");
    expect(moduleRef.get(OBSERVE_OPTIONS)).toBeDefined();

    await moduleRef.close();
  });

  it("passes debug from createObserveModule options into startSdk", () => {
    createObserveModule({ debug: true });
    expect(startSdk).toHaveBeenCalledWith(
      expect.objectContaining({ debug: true }),
    );
  });

  it("registers forRoot as a global module providing OBSERVE_OPTIONS", () => {
    const { ObserveModule } = createObserveModule();
    const dynamic = ObserveModule.forRoot({
      http: { ignore: ["/health"] },
    });

    expect(dynamic.global).toBe(true);
    expect(dynamic.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provide: OBSERVE_OPTIONS,
          useValue: expect.objectContaining({
            http: { ignore: ["/health"] },
          }),
        }),
      ]),
    );
  });

  it("leaves instances skipped by the user hook unproxied", () => {
    class OptedOut {
      run() {
        return "ok";
      }
    }
    const { ObserveInstrument } = createObserveModule({
      skipInstrumentation: (instance) => instance instanceof OptedOut,
    });
    const decorate = ObserveInstrument.instanceDecorator;
    const optedOut = new OptedOut();
    const other = { run() {} };

    expect(decorate(optedOut)).toBe(optedOut);
    expect(decorate(other)).not.toBe(other);
  });

  it("skips protocol agents and ObserveMetrics by constructor.name", () => {
    const { ObserveInstrument } = createObserveModule();
    const decorate = ObserveInstrument.instanceDecorator;

    for (const name of AGENT_SKIP_NAMES) {
      const instance = instanceNamed(name);
      expect(decorate(instance)).toBe(instance);
    }
  });
});

describe("createObserveModule#forRootAsync", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(startSdk).mockClear();
  });

  afterEach(async () => {
    await shutdownStartedSdks();
    resetSdkForTests();
    vi.mocked(console.warn).mockRestore();
  });

  it("resolves options through useFactory", async () => {
    const { ObserveModule } = createObserveModule();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ObserveModule.forRootAsync({
          useFactory: () => ({ debug: true }),
        }),
      ],
    }).compile();

    expect(moduleRef.get(OBSERVE_OPTIONS)).toMatchObject({ debug: true });
    expect(startSdk).toHaveBeenCalled();
    await moduleRef.close();
  });

  it("resolves options through useClass", async () => {
    class ObserveConfig implements ObserveOptionsFactory {
      createObserveOptions() {
        return { debug: true };
      }
    }
    const { ObserveModule } = createObserveModule();
    const moduleRef = await Test.createTestingModule({
      imports: [ObserveModule.forRootAsync({ useClass: ObserveConfig })],
    }).compile();

    expect(moduleRef.get(OBSERVE_OPTIONS)).toMatchObject({ debug: true });
    await moduleRef.close();
  });

  it("resolves options through useExisting", async () => {
    class ObserveConfig implements ObserveOptionsFactory {
      createObserveOptions() {
        return { http: { ignore: ["/ready"] } };
      }
    }

    @Module({
      providers: [ObserveConfig],
      exports: [ObserveConfig],
    })
    class ConfigModule {}

    const { ObserveModule } = createObserveModule();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ObserveModule.forRootAsync({
          imports: [ConfigModule],
          useExisting: ObserveConfig,
        }),
      ],
    }).compile();

    expect(moduleRef.get(OBSERVE_OPTIONS)).toMatchObject({
      http: { ignore: ["/ready"] },
    });
    await moduleRef.close();
  });

  it("throws when none of useFactory, useClass, or useExisting is set", () => {
    const { ObserveModule } = createObserveModule();
    expect(() => ObserveModule.createAsyncProviders({})).toThrow(
      /requires one of "useFactory", "useClass" or "useExisting"/,
    );
  });
});
