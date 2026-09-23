# Self-hosted: your cluster, your backends

Tempo, Mimir and Loki run in your cluster. Full control and no data leaving it, at the cost of six Helm releases to operate instead of [`../grafana-cloud/`](../grafana-cloud/)'s one or two.

Alternatives: [`../local/`](../local/) (Compose, no account) and [`../grafana-cloud/`](../grafana-cloud/) (managed). See [`../README.md`](../README.md) for the comparison.

## What ops deploys

Six Helm releases. Nothing is a chart written from scratch - all six are upstream charts plus values:

| # | Release | Chart | Ops supplies |
|---|---|---|---|
| 1 | `otel-collector-gateway` | `open-telemetry/opentelemetry-collector` | [gateway config](./otel-collector-gateway.yaml), `mode: deployment`, HPA |
| 2 | `otel-collector-sampler` | *same chart, second release* | [sampler config](./otel-collector-sampler.yaml), **headless** Service, larger memory limits |
| 3 | `tempo` | `grafana/tempo` or `tempo-distributed` | Object storage, retention |
| 4 | `mimir` | `grafana/mimir-distributed` | Object storage, retention |
| 5 | `loki` | `grafana/loki` | Object storage, retention |
| 6 | `grafana` | `grafana/grafana` | Datasources, dashboards |

Rows 1 and 2 are the **same image and chart installed twice** with different values. That pair is the whole implementation of the two-tier split.

"Deployment" is loose: only the collectors are `Deployment`s. Tempo, Mimir and Loki run ingesters as `StatefulSet`s because they hold a WAL, and in microservices mode each expands into 5–8 workloads.

```
services ──OTLP──> [1] gateway ──┬──> spanmetrics ──> [4] Mimir
                                 ├──> logs ────────> [5] Loki
                                 ├──> app metrics ─> [4] Mimir
                                 └──loadbalancing──> [2] sampler ──> [3] Tempo
                                    routing_key: traceID
                                                     [6] Grafana reads 3, 4, 5
```

## Why two collector tiers

`tail_sampling` needs every span of a trace in one process. At 2+ replicas behind a ClusterIP Service it decides on fragments, and `errors-always` fails on exactly the traces it exists to preserve. Full explanation in [`../README.md`](../README.md#the-constraint-that-shapes-all-three).

| Tier | File | Replicas | State | Carries |
|---|---|---|---|---|
| 1 — gateway | [`otel-collector-gateway.yaml`](./otel-collector-gateway.yaml) | N, scales freely | none | spanmetrics RED, app metrics, logs; forwards traces to tier 2 |
| 2 — sampler | [`otel-collector-sampler.yaml`](./otel-collector-sampler.yaml) | N, headless Service | in-flight traces | `tail_sampling` → Tempo |

Tier 1 forwards through the `loadbalancing` exporter with `routing_key: traceID`, which hashes each span's trace ID to pick a tier-2 instance, so every span of a trace lands on one sampler. The tiers are split because they scale on different constraints: tier 1 is stateless and scales on ingest volume, tier 2 holds traces in memory and cannot be rescheduled as casually.

## Requirements ops must honour

These fail silently rather than loudly, which is why they are listed:

- **Tier 2 needs a headless Service** (`clusterIP: None`). The collector chart creates a normal ClusterIP Service unless told otherwise, and that degrades tier 1's routing to round-robin - reintroducing the exact bug the split fixes, with no error to show for it.
- **`POD_NAME` must come from the downward API** (`fieldRef: metadata.name`) in tier 1's values. Without it every replica writes identical spanmetrics series and Mimir rejects them as duplicates: RED dashboards go blank while traces keep working.
- **Dashboards must aggregate over `collector_instance`.** Query `sum by (service_name, span_name) (...)`, never a bare series selector, or you get one line per collector pod.
- **`decision_wait` must exceed p99 trace duration.** Set below it and slow traces are decided before their slowest spans arrive, silently defeating `latency-over-500ms`.
- **Rolling restarts of tier 2 drop in-flight traces**, bounded by `decision_wait`. Expect a small gap in Tempo on deploy; metrics and logs are unaffected because they never transit tier 2.
- **Backends come from the environment with no defaults**: `TEMPO_ENDPOINT`, `MIMIR_REMOTE_WRITE`, `LOKI_ENDPOINT`, `SAMPLER_DNS`, `POD_NAME`. Unlike [`../local/`](../local/) these do not fall back, so a missing value fails at startup rather than shipping production telemetry to a `tempo:4317` that does not exist.
- **Sizing:** tier 2 memory scales with `num_traces` × avg spans/trace × span size. Raise `memory_limiter` and `num_traces` together, never one alone.

### Service discovery

Tier 1 resolves tier 2 through `SAMPLER_DNS`, defaulting to a headless Service in an `observability` namespace. On Kubernetes the `k8s` resolver reacts to pod churn faster than DNS TTL allows; the swap is three lines, commented in place in [`otel-collector-gateway.yaml`](./otel-collector-gateway.yaml), and needs RBAC to watch endpoints.

## Nothing changes for the services

`OBSERVE_ENDPOINT` points at tier 1, and the SDK stays `ParentBased(AlwaysOn)` - it ships everything and lets tier 2 hold the budget. No code change and no SDK redeploy when the topology changes.

## Validate

```bash
for config in otel-collector-gateway.yaml otel-collector-sampler.yaml; do
  docker run --rm \
    -e TEMPO_ENDPOINT=tempo:4317 \
    -e MIMIR_REMOTE_WRITE=http://mimir:9009/api/v1/push \
    -e LOKI_ENDPOINT=http://loki:3100/otlp \
    -e SAMPLER_DNS=sampler.observability.svc.cluster.local \
    -e POD_NAME=local \
    -v "$(pwd)/deploy/self-hosted/$config:/etc/otelcol/config.yaml:ro" \
    otel/opentelemetry-collector-contrib:latest \
    validate --config=/etc/otelcol/config.yaml && echo "OK $config"
done
```
