# Local: Compose + Tempo + Mimir + Loki + Grafana

The whole stack on one host, no account and no cluster. Data is throwaway: retention is an hour in Tempo, and only Tempo has a named volume - Mimir, Loki and Grafana lose everything on `docker compose down`.

Alternatives: [`../grafana-cloud/`](../grafana-cloud/) (managed backends, free tier) and [`../self-hosted/`](../self-hosted/) (your cluster). See [`../README.md`](../README.md) for the comparison.

## Start

From the repo root:

```bash
docker compose -f deploy/local/docker-compose.yaml up
```

Then point a Nest 12 app at it:

```bash
export OBSERVE_ENDPOINT=http://localhost:4318
export OBSERVE_LOGS=true
```

Grafana is at http://localhost:3000 (anonymous Admin). Tempo, Mimir and Loki datasources are provisioned. With `OBSERVE_LOGS=true`, warn+error from the app appears in Loki carrying the request's `trace_id`.

| Port | Service |
|---|---|
| `4317` | Collector OTLP gRPC |
| `4318` | Collector OTLP HTTP (`OBSERVE_ENDPOINT`) |
| `3000` | Grafana |
| `3100` | Loki |
| `9009` | Mimir (Prometheus remote write + query) |

Apps never talk to Tempo, Mimir or Loki. They speak OTLP to the collector. Tempo is not even published to the host - it uses `expose`, so it is reachable only on the Compose network. That rule is enforced by the network here, not just documented.

## Everything runs on one host

`docker compose up` is single-host by definition: all five containers share one Docker daemon and one bridge network, which is why `tempo:4317` resolves as a hostname. Each backend runs in monolithic / single-binary dev mode with filesystem storage and `replication_factor: 1` - that is what makes them fit on a laptop, and what makes them unsuitable for anything else.

The collector here is **single-instance**, which is why it can run `tail_sampling` in one process. See [`../README.md`](../README.md#the-constraint-that-shapes-all-three).

## Pipelines

- **Traces → Mimir RED (`traces/metrics`):** OTLP → `memory_limiter` → `batch` → `spanmetrics`
- **Traces → Tempo (`traces/tempo`):** OTLP → `memory_limiter` → `tail_sampling` → `batch` → Tempo
- **Metrics:** OTLP (SDK process + custom) + `spanmetrics` → `batch` → Mimir
- **Logs:** OTLP → `memory_limiter` → `batch` → Loki

Traces fan out at the receiver so `spanmetrics` sees every span; only Tempo storage is tail-sampled. Downstream of sampling, RED would follow the keep rate.

### Tail sampling

Local keeps 100% so a handful of RPCs actually show up in Grafana. The production policies live in the other two directories.

| Policy | Keep |
|---|---|
| Span status `ERROR` | 100% |
| Trace latency > 500ms | 100% |
| Otherwise | 100% locally (10% in production) |

Policies are OR'd: a trace matching any keep-policy is stored.

Override backends with `TEMPO_ENDPOINT` (default `tempo:4317`), `MIMIR_REMOTE_WRITE` (default `http://mimir:9009/api/v1/push`) and `LOKI_ENDPOINT` (default `http://loki:3100/otlp`). Unlike the production configs these have defaults, because a local collector pointing at a local Tempo is always the right guess. Local TLS is `insecure: true`.

## Prometheus / Mimir names

The SDK emits OTel metric names. `prometheusremotewrite` normalizes them for Mimir (dots → underscores, counters get `_total`).

`spanmetrics` produces RED series from spans (`calls` / `duration`, plus `service.name`, `span.name`, `span.kind`, `status.code`, and HTTP route / gRPC method dimensions). Do **not** also record request-duration histograms in the SDK for the same HTTP/gRPC calls.

Process metrics (event-loop delay, heap, RSS, GC) come from the SDK's runtime instrumentation on the same OTLP metrics pipeline.

## Memory

`memory_limiter` caps the collector at 512 MiB, but `tail_sampling` also buffers up to `num_traces: 50000` traces while waiting out `decision_wait`, and Mimir, Tempo, Loki and Grafana each want their share. On a small VM, drop `num_traces` well below 50000 - locally you are pushing a handful of traces, so it costs nothing.

## Validate

```bash
docker run --rm \
  -v "$(pwd)/deploy/local/otel-collector.yaml:/etc/otelcol/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:latest \
  validate --config=/etc/otelcol/config.yaml
```

Expected: exit 0. If `otelcol` is on `PATH`: `otelcol validate --config=deploy/local/otel-collector.yaml`.
