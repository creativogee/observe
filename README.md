# @crudmates/observe

OpenTelemetry for NestJS 12, with the wiring that normally takes a week already done.

Add the module, set one environment variable, and get distributed traces, metrics and logs over OTLP - to Grafana Cloud, a self-hosted LGTM stack, or anything else that speaks OTLP.

If the collector is missing or down, your process still serves traffic.

```bash
npm install @crudmates/observe
```

## Why not just use the OTel SDK

You can, and for a single HTTP service you probably should. This package exists for the parts the SDK leaves to you:

- **Trace context actually crosses your service boundaries.** Incoming HTTP and gRPC requests continue the caller's trace; outgoing calls carry it. Nest's `ClientProxyFactory` is patched for gRPC client propagation, which `@opentelemetry/instrumentation-grpc` does not do.
- **Async hops stay in the same trace.** Google Pub/Sub publishes inject W3C context into message attributes and consumers extract it, so a consumer is not a new trace root.
- **Route templates, not raw paths.** Server spans are named `GET /orders/:id`, so span metrics do not explode into one series per ID.
- **Nothing is mandatory.** Every integration - gRPC, Pub/Sub, BullMQ, Postgres, Redis, schedule - is an optional peer. A service that does not install one is unaffected, and a failure to patch warns rather than throws.
- **Opt-in log redaction** by canonicalized key, so one declaration covers `accountNumber`, `account_number` and `ACCOUNT_NUMBER`.
- **Shutdown flushes**, bounded, so a wedged collector cannot hold a pod in `Terminating`.

## Setup

`createObserveModule()` starts the OTel `NodeSDK` at **import time**, so I/O patches land before `pg`, `http` or `grpc` load. It must be the first import in `main.ts`.

```ts
// src/observe.ts
import { createObserveModule } from "@crudmates/observe";

export const { ObserveModule, ObserveInstrument } = createObserveModule();
```

```ts
// src/main.ts — observe must be the first import
import { ObserveInstrument } from "./observe";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

const app = await NestFactory.create(AppModule, {
  instrument: ObserveInstrument,
});
await app.listen(3000);
```

```ts
// src/app.module.ts
@Module({
  imports: [ObserveModule.forRoot()], // no required fields
})
export class AppModule {}
```

`ObserveModule` is global, so you import it once. `forRootAsync` is supported for ignore routes and debug.

Optional `forRoot` fields: `http.ignore` (defaults include `/health`, `/healthz`, `/metrics`, `/ready`, `/live`) and `debug`.

**Extra resource attributes are not a `forRoot` option.** The SDK starts before `forRoot` runs, so set `OTEL_RESOURCE_ATTRIBUTES` in the process environment instead.

## Configuration

No baked-in hostname, no DSN, no app key.

| Variable                     | Role                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `OBSERVE_ENDPOINT`           | OTLP HTTP **base URL** (e.g. `http://localhost:4318`). Signal paths (`/v1/traces`, `/v1/metrics`, `/v1/logs`) are appended |
| `OBSERVE_LOGS`               | `true` exports Nest and `console` logs via OTLP. Default off. Requires `OBSERVE_ENDPOINT`                                  |
| `OBSERVE_LOGS_MIN_LEVEL`     | `error` \| `warn` \| `info` \| `debug`. Default `warn`; invalid values fall back to `warn`                                 |
| `OBSERVE_PROMETHEUS_PORT`    | Opt-in scrape. Integer `1`–`65535` binds `0.0.0.0:<port>/metrics`. Unset or invalid means no scrape server                 |
| `OBSERVE_TRACES_SAMPLE_RATE` | Optional `0..1`. If set, `ParentBased(TraceIdRatioBased(rate))`                                                            |
| `OBSERVE_DEBUG`              | `true` enables OTel diagnostic logging                                                                                     |
| `OTEL_SERVICE_NAME`          | Service name. Falls back to `package.json` `"name"`                                                                        |
| `OTEL_RESOURCE_ATTRIBUTES`   | Extra resource attributes                                                                                                  |
| `NODE_ENV`                   | Sets `deployment.environment` unless `OTEL_RESOURCE_ATTRIBUTES` already does                                               |

With `OBSERVE_ENDPOINT` unset the SDK warns **once** and stays off, so an unconfigured environment is quiet rather than noisy.

### Sampling

With no sampler configured the default is `ParentBased(AlwaysOn)`: send everything and let the collector hold the budget. That is deliberate. A service cannot know at root-span time that a request will fail three hops later, so head sampling throws away exactly the traces you will want. Tail-sample in the collector instead - recipes in [`deploy/`](./deploy/).

`OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` are honoured when `OBSERVE_TRACES_SAMPLE_RATE` is unset.

## What gets instrumented

Automatic, when the relevant package is installed:

| Area      | Covered                                                                                |
| --------- | -------------------------------------------------------------------------------------- |
| HTTP      | Inbound server spans with route templates; outbound via `http` and `undici`/`fetch`    |
| gRPC      | Server spans from metadata; **client propagation through Nest's `ClientProxyFactory`** |
| Pub/Sub   | `@google-cloud/pubsub` publish injection and consumer extraction                       |
| Queues    | BullMQ processors, with wait time, attempts and max attempts                           |
| Schedule  | `@nestjs/schedule` cron and interval jobs                                              |
| Databases | `pg`, `ioredis`, `redis`                                                               |
| Runtime   | Event-loop delay, heap, RSS, GC                                                        |
| Providers | Per-method spans via the Nest instrument decorator                                     |

## Logs

Opt in with `OBSERVE_LOGS=true`. The floor is warn+error by default.

### Redaction

Exported log records can be redacted by key before they leave the process. **Nothing is redacted until you say what is sensitive** - the package ships no default list.

```ts
import { addSensitiveFields } from "@crudmates/observe";

addSensitiveFields(["email", "phoneNumber", "accountNumber", "apiKey"]);
```

Call it during bootstrap, before the first record is exported. `setSensitiveFields()` replaces the list outright instead of extending it.

There is no built-in list on purpose. What must not reach a telemetry backend depends on your jurisdiction and your domain: `diagnosis` is sensitive in an EMR and meaningless in a logistics service, and personal data is defined differently under NDPR, GDPR and HIPAA. A shipped opinion would be wrong for most consumers while looking like coverage, which is worse than an empty list you have to fill in deliberately.

Matching is on whole word tokens after canonicalizing the key, so one declaration covers every spelling - `accountNumber`, `account_number`, `ACCOUNT_NUMBER` and `account-number` are one field, not four. A declared branch key such as `auth` collapses its whole subtree.

**Local console output is untouched** - redaction applies only to what is exported.

Redaction covers key-value pairs in log records. It does not cover span names, URLs or error message bodies, so a route like `/patients/:id/diagnoses` still needs care at the call site.

## Shutdown

`ObserveModule` registers an `onApplicationShutdown` hook, so `app.enableShutdownHooks()` is covered. A service that calls `process.exit()` from its own handler should await the flush directly:

```ts
import { shutdownObserve } from "@crudmates/observe";

process.on("SIGTERM", async () => {
  await app.close();
  await shutdownObserve(); // resolves, never rejects; 5s cap
  process.exit(0);
});
```

`shutdownObserve()` is idempotent and bounded.

## Running a collector

Your services speak OTLP to one address and know nothing about storage. Three ready-made collector recipes, all validated in CI:

| Recipe                                             | Backends                                         |
| -------------------------------------------------- | ------------------------------------------------ |
| [`deploy/local/`](./deploy/local/)                 | Tempo + Mimir + Loki + Grafana in Docker Compose |
| [`deploy/grafana-cloud/`](./deploy/grafana-cloud/) | Managed, free tier works                         |
| [`deploy/self-hosted/`](./deploy/self-hosted/)     | Your own cluster                                 |

Switching between them is one environment variable. See [`deploy/README.md`](./deploy/README.md).

Request RED metrics (rate, errors, duration by route and gRPC method) come from collector `spanmetrics`, not from SDK histograms - do not record request-duration histograms yourself for the same calls.

> **Scaling note.** Collector `tail_sampling` needs every span of a trace in one process. Past one replica you need a two-tier split routed by trace ID, or the "keep all errors" policy fails on exactly the traces it exists to preserve. Both tiers are in the deploy recipes.

## Module format

Ships both builds: `require()` resolves `dist/cjs`, `import` resolves `dist/esm`. Your service keeps whatever it already is. `npm run verify:package` loads the built package both ways and runs in CI.

## Requirements

- Node.js >= 20.19
- NestJS 12 (`@nestjs/common` and `@nestjs/core` as peers)

NestJS 12 is a hard requirement, not a version-range preference: server span creation uses HTTP adapter hooks (`setOnRequestHook`, `setOnRouteTriggered`) and the `instrument` option on `NestFactory.create`, neither of which exists in Nest 11.

## License

MIT
