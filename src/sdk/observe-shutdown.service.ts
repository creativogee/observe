import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { shutdownObserve } from "./start-sdk.js";

/**
 * Flushes buffered telemetry when Nest tears the application down.
 *
 * Only fires for a service that calls `app.enableShutdownHooks()`. The
 * SIGTERM/SIGINT handler registered by `startSdk` covers the rest, and
 * `shutdownObserve()` is idempotent, so both paths firing is harmless.
 */
@Injectable()
export class ObserveShutdownService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownObserve();
  }
}
