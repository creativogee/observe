# Grafana Cloud: managed backends

Tempo, Mimir, Loki and Grafana are Grafana's problem. You run only the collector - one process to test with, two Deployments at scale, instead of the six Helm releases [`../self-hosted/`](../self-hosted/) needs.

Alternatives: [`../local/`](../local/) (Compose, no account) and [`../self-hosted/`](../self-hosted/). See [`../README.md`](../README.md) for the comparison.

## Free tier

No credit card, no expiry.

| Signal | Limit | Retention |
|---|---|---|
| Metrics | 10k active series/month | 14 days |
| Logs | 50 GB ingested/month | 14 days |
| Traces | 50 GB ingested/month | 14 days |
| Users | 3 active | — |

**The binding constraint is 10k active series, not the 50 GB.** Testing will not come near 50 GB of traces, but `spanmetrics` multiplies series by service × span name × `http.route` × `http.request.method` × `rpc.method` × status. Across a couple of dozen services with real route tables, 10k is reachable.

If you hit it, trim `dimensions` in the collector config or test with a handful of services before concluding the SDK is misbehaving - a dropped series looks a lot like broken instrumentation.

Three active users is fine for a spike, not for the wider team.

## Credentials

Grafana Cloud console → **Connections → OTLP**:

| Env var | Value |
|---|---|
| `GRAFANA_CLOUD_OTLP_ENDPOINT` | `https://otlp-gateway-prod-<region>.grafana.net/otlp` |
| `GRAFANA_CLOUD_INSTANCE_ID` | Numeric stack ID - the basic-auth username |
| `GRAFANA_CLOUD_API_TOKEN` | Token with metrics, logs and traces write scope |

One endpoint carries all three signals: `otlphttp` appends `/v1/traces`, `/v1/metrics` and `/v1/logs` to the base URL, and Grafana's gateway fans out on its side. That is why these configs have no Tempo / Mimir / Loki exporters and no `prometheusremotewrite`.

The token is a write credential. Keep it in a Kubernetes Secret or your shell, never in this repo.

## Test it locally

The fastest way to prove distributed tracing end to end - no cluster, no Compose stack:

```bash
export GRAFANA_CLOUD_OTLP_ENDPOINT=https://otlp-gateway-prod-<region>.grafana.net/otlp
export GRAFANA_CLOUD_INSTANCE_ID=<stack id>
export GRAFANA_CLOUD_API_TOKEN=<token>

docker run --rm -p 4317:4317 -p 4318:4318 \
  -e GRAFANA_CLOUD_OTLP_ENDPOINT -e GRAFANA_CLOUD_INSTANCE_ID -e GRAFANA_CLOUD_API_TOKEN \
  -v "$(pwd)/deploy/grafana-cloud/otel-collector.yaml:/etc/otelcol/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:latest \
  --config=/etc/otelcol/config.yaml
```

Then run two services with `OBSERVE_ENDPOINT=http://localhost:4318` and call one through the other.

This exercises what the test suite cannot. The integration tests assert a method span shares a `traceId` with its in-process parent; they never cross a process boundary. Whether the gRPC client interceptor actually injects `traceparent` into Nest's `ClientProxyFactory`, and whether Pub/Sub attributes survive a round trip, only shows up here.

## Which config

| File | Replicas | When |
|---|---|---|
| [`otel-collector.yaml`](./otel-collector.yaml) | 1 | Start here. Local testing, and valid in-cluster at one replica |
| [`otel-collector-gateway.yaml`](./otel-collector-gateway.yaml) + [`otel-collector-sampler.yaml`](./otel-collector-sampler.yaml) | N | Once one replica is no longer enough |

**`tail_sampling` constrains the collector, not the backend.** Managed storage does not change the fact that a sampling decision needs the whole trace in one process, so the two-tier split applies here exactly as it does self-hosted. See [`../README.md`](../README.md#the-constraint-that-shapes-all-three).

At scale-out, tier 1 forwards traces through `loadbalancing` with `routing_key: traceID`, and **tier 2 must sit behind a headless Service** (`clusterIP: None`). A ClusterIP Service balances per connection and silently undoes the routing.

### Open item before scaling tier 1 past one replica

Every tier-1 replica emits `spanmetrics` series for the same span names, and identical series from several senders are rejected as duplicate samples. The self-hosted recipe solves this with `external_labels` on `prometheusremotewrite`; `otlphttp` has no equivalent, and a header does not become a label.

Two options, both ops decisions:

1. **Send metrics over Prometheus remote write instead.** Grafana Cloud exposes a remote-write endpoint alongside OTLP, so `prometheusremotewrite` with `external_labels: {collector_instance: "${env:POD_NAME}"}` works exactly as in `../self-hosted/`. Traces and logs stay on OTLP. Costs one extra credential pair.
2. **Give `spanmetrics` its own collector pool** routed by `service` rather than `traceID`, so a single instance owns each service's series.

Single-replica tier 1 is unaffected. Verify under load before scaling.

## Validate

```bash
for config in otel-collector.yaml otel-collector-gateway.yaml otel-collector-sampler.yaml; do
  docker run --rm \
    -e GRAFANA_CLOUD_OTLP_ENDPOINT=https://otlp-gateway-prod-us-east-0.grafana.net/otlp \
    -e GRAFANA_CLOUD_INSTANCE_ID=000000 \
    -e GRAFANA_CLOUD_API_TOKEN=placeholder \
    -e SAMPLER_DNS=sampler.observability.svc.cluster.local \
    -e POD_NAME=local \
    -v "$(pwd)/deploy/grafana-cloud/$config:/etc/otelcol/config.yaml:ro" \
    otel/opentelemetry-collector-contrib:latest \
    validate --config=/etc/otelcol/config.yaml && echo "OK $config"
done
```

Placeholders are fine - `validate` parses, it does not connect.
