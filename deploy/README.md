# Deploying the collector

`@crudmates/observe` sends OTLP to one address and knows nothing else. Everything downstream - sampling budget, RED metrics, storage - is the collector's, and the collector can be run three ways. Pick one; the SDK and your services are identical under all three.

| Directory | Backends | You run | Use it for |
|---|---|---|---|
| [`local/`](./local/) | Tempo + Mimir + Loki + Grafana, in Compose | 5 containers on one host | Development. Throwaway data, no account needed |
| [`grafana-cloud/`](./grafana-cloud/) | Managed by Grafana | 1–2 collectors | **Current direction.** Free tier for testing, same configs in cluster |
| [`self-hosted/`](./self-hosted/) | Tempo + Mimir + Loki in your cluster | 6 Helm releases | Full control, data never leaves the cluster |
| [`vps/`](./vps/) | Grafana Cloud (managed) | 1 container on your box | A single VPS, no Kubernetes |

`vps/` is `grafana-cloud/` plus the process supervision a single box needs; it reuses that config rather than forking it.

These are alternatives, not stages. Nothing in `local/` has to be torn down to try `grafana-cloud/`, and nothing in either forecloses `self-hosted/` later.

## Switching between them

One environment variable in the service, one config file in the collector:

```bash
# local/
OBSERVE_ENDPOINT=http://localhost:4318

# grafana-cloud/ or self-hosted/
OBSERVE_ENDPOINT=http://otel-collector-gateway.observability.svc.cluster.local:4318
```

No code change, no redeploy of the SDK, no `package.json` edit. That is the point of the OTLP boundary: the services never learn where telemetry is stored.

## What is the same everywhere

Every config in every directory shares the same shape, so a change in one is easy to mirror:

- **`spanmetrics` fans out at the receiver**, never downstream of sampling. Placing it after `tail_sampling` would make RED follow the keep rate, biasing error rate toward 100% - the kept population is mostly errors and slow traces by construction.
- **`tail_sampling` policies are identical**: all errors, everything over 500ms, 10% of the rest, OR'd.
- **The SDK stays `ParentBased(AlwaysOn)`.** It ships everything and lets the collector hold the budget, because an app cannot know at root-span time that a request will fail three hops later.

Because the files are self-contained rather than layered, that shared shape is duplicated. If you change a sampling policy or a spanmetrics dimension, change it in each config it appears in - CI validates syntax, not agreement between files.

## The constraint that shapes all three

`tail_sampling` is stateful. It holds a trace in memory until `decision_wait` expires, then judges the complete trace, which requires **every span of a trace to reach the same collector process**.

At one replica that is free. At 2+ replicas behind an ordinary ClusterIP Service it breaks, and not by dropping a random percentage: when a request errors on its third hop, the replica holding the ERROR span keeps its fragment while the replicas holding the rest drop theirs. Tempo ends up with a trace that is mostly the error span and missing the context explaining it - and `errors-always`, the policy that exists to make this case reliable, is the one that fails.

So each directory ships a single-instance config and, where scale-out applies, a gateway/sampler pair that routes by trace ID. This is a property of the collector, not of the backend: **it applies on Grafana Cloud exactly as it does self-hosted.**

## Validate

CI validates every config in this tree on each push. Locally:

```bash
for config in $(find deploy -name 'otel-collector*.yaml'); do
  docker run --rm \
    -e TEMPO_ENDPOINT=tempo:4317 \
    -e MIMIR_REMOTE_WRITE=http://mimir:9009/api/v1/push \
    -e LOKI_ENDPOINT=http://loki:3100/otlp \
    -e SAMPLER_DNS=sampler.observability.svc.cluster.local \
    -e POD_NAME=local \
    -e GRAFANA_CLOUD_OTLP_ENDPOINT=https://otlp-gateway-prod-us-east-0.grafana.net/otlp \
    -e GRAFANA_CLOUD_INSTANCE_ID=000000 \
    -e GRAFANA_CLOUD_API_TOKEN=placeholder \
    -v "$PWD/$config:/etc/otelcol/config.yaml:ro" \
    otel/opentelemetry-collector-contrib:latest \
    validate --config=/etc/otelcol/config.yaml && echo "OK $config"
done
```

Placeholders are fine - `validate` parses, it does not connect.
