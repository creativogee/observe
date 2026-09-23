import {
  FactoryProvider,
  ModuleMetadata,
  Provider,
  Type,
} from "@nestjs/common";

export interface CreateObserveModuleOptions {
  /**
   * Excludes providers from instrumentation. Return true for an instance that
   * should stay untouched - no proxy is placed around it and none of its
   * methods produce spans.
   * @default () => false
   */
  skipInstrumentation?: (instance: unknown) => boolean;
  debug?: boolean;
}

export interface ObserveOptions {
  http?: {
    ignore?:
      | Array<string | RegExp>
      | ((req: { url: string; method: string }) => boolean);
  };
  debug?: boolean;
}

/**
 * Implemented by the class passed to `ObserveModule.forRootAsync()` as
 * `useClass` or `useExisting`.
 */
export interface ObserveOptionsFactory {
  createObserveOptions(): Promise<ObserveOptions> | ObserveOptions;
}

export interface ObserveModuleAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  useExisting?: Type<ObserveOptionsFactory>;
  useClass?: Type<ObserveOptionsFactory>;
  useFactory?: (...args: never[]) => Promise<ObserveOptions> | ObserveOptions;
  inject?: FactoryProvider["inject"];
  extraProviders?: Provider[];
  global?: boolean;
}
