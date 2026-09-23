import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  resetSdkForTests,
  startSdk,
  type StartedSdk,
} from "../sdk/start-sdk.js";

export interface InMemoryOtel {
  exporter: InMemorySpanExporter;
  started: StartedSdk;
}

/**
 * Starts the Observe SDK with an in-memory span exporter and no OTLP endpoint.
 * Must run before `createObserveModule()` so the singleton already holds this
 * exporter; production `createObserveModule` does not pass one.
 */
export function startInMemoryOtel(): InMemoryOtel {
  delete process.env.OBSERVE_ENDPOINT;
  const exporter = new InMemorySpanExporter();
  const started = startSdk({ traceExporter: exporter });
  return { exporter, started };
}

export async function shutdownInMemoryOtel(started: StartedSdk): Promise<void> {
  await started.sdk?.shutdown();
  resetSdkForTests();
}
