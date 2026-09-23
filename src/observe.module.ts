import { DynamicModule, Module, type Provider } from "@nestjs/common";
import { createInstanceDecorator } from "./instrument/create-instance-decorator.js";
import type {
  CreateObserveModuleOptions,
  ObserveModuleAsyncOptions,
  ObserveOptions,
  ObserveOptionsFactory,
} from "./interfaces/observe-options.interface.js";
import { ObserveMetrics } from "./metrics/observe-metrics.js";
import { OBSERVE_OPTIONS } from "./observe.constants.js";
import { HttpObserveAgentService } from "./protocols/http-observe-agent.service.js";
import { QueueObserveAgentService } from "./protocols/queue-observe-agent.service.js";
import { RpcObserveAgentService } from "./protocols/rpc-observe-agent.service.js";
import { ScheduleObserveAgentService } from "./protocols/schedule-observe-agent.service.js";
import { ObserveShutdownService } from "./sdk/observe-shutdown.service.js";
import { startSdk } from "./sdk/start-sdk.js";

const MISSING_ASYNC_OPTIONS_PROVIDER =
  'ObserveModule.forRootAsync() requires one of "useFactory", "useClass" or "useExisting".';

const SKIPPED_CONSTRUCTOR_NAMES = new Set([
  "HttpObserveAgentService",
  "RpcObserveAgentService",
  "QueueObserveAgentService",
  "ScheduleObserveAgentService",
  "ObserveShutdownService",
  "ObserveMetrics",
]);

export function createObserveModule(options: CreateObserveModuleOptions = {}) {
  startSdk({ debug: options.debug });
  options.skipInstrumentation ??= () => false;

  @Module({
    providers: [
      HttpObserveAgentService,
      RpcObserveAgentService,
      QueueObserveAgentService,
      ScheduleObserveAgentService,
      ObserveShutdownService,
      ObserveMetrics,
    ],
    exports: [
      HttpObserveAgentService,
      RpcObserveAgentService,
      QueueObserveAgentService,
      ScheduleObserveAgentService,
      ObserveMetrics,
    ],
  })
  class ObserveModule {
    static forRoot(observeOpts?: ObserveOptions): DynamicModule {
      return {
        global: true,
        module: ObserveModule,
        providers: [
          {
            provide: OBSERVE_OPTIONS,
            useValue: {
              ...options,
              ...observeOpts,
            },
          },
        ],
      };
    }

    static forRootAsync(
      asyncOptions: ObserveModuleAsyncOptions,
    ): DynamicModule {
      return {
        module: ObserveModule,
        global: asyncOptions.global ?? true,
        imports: asyncOptions.imports,
        providers: [
          ...this.createAsyncProviders(asyncOptions),
          ...(asyncOptions.extraProviders || []),
        ],
      };
    }

    static createAsyncProviders(
      asyncOptions: ObserveModuleAsyncOptions,
    ): Provider[] {
      if (asyncOptions.useExisting || asyncOptions.useFactory) {
        return [this.createAsyncOptionsProvider(asyncOptions)];
      }
      const useClass = asyncOptions.useClass;
      if (!useClass) {
        throw new Error(MISSING_ASYNC_OPTIONS_PROVIDER);
      }
      return [
        this.createAsyncOptionsProvider(asyncOptions),
        {
          provide: useClass,
          useClass,
        },
      ];
    }

    static createAsyncOptionsProvider(
      asyncOptions: ObserveModuleAsyncOptions,
    ): Provider {
      const useFactory = asyncOptions.useFactory;
      if (useFactory) {
        return {
          provide: OBSERVE_OPTIONS,
          useFactory: async (...args: never[]) => {
            const opts = await useFactory(...args);
            return {
              ...options,
              ...opts,
            };
          },
          inject: asyncOptions.inject || [],
        };
      }
      const optionsFactoryToken =
        asyncOptions.useExisting ?? asyncOptions.useClass;
      if (!optionsFactoryToken) {
        throw new Error(MISSING_ASYNC_OPTIONS_PROVIDER);
      }
      return {
        provide: OBSERVE_OPTIONS,
        useFactory: async (optionsFactory: ObserveOptionsFactory) => ({
          ...options,
          ...(await optionsFactory.createObserveOptions()),
        }),
        inject: [optionsFactoryToken],
      };
    }
  }

  const skipInstrumentation = (instance: unknown): boolean => {
    try {
      return (
        options.skipInstrumentation!(instance) ||
        SKIPPED_CONSTRUCTOR_NAMES.has(
          (instance as { constructor?: { name?: string } })?.constructor
            ?.name ?? "",
        )
      );
    } catch {
      return true;
    }
  };

  return {
    ObserveInstrument: {
      instanceDecorator: createInstanceDecorator({ skipInstrumentation }),
    },
    ObserveModule,
  };
}
