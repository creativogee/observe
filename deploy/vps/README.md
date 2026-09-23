# Collector on a VPS

For running the collector on the same box as your app, with Grafana Cloud as the backend. If you are on Kubernetes, use [`../grafana-cloud/`](../grafana-cloud/) directly instead — this directory only adds the process supervision a VPS needs.

## Setup

```bash
cd deploy/vps
cp grafana-cloud.env.example grafana-cloud.env
chmod 600 grafana-cloud.env      # it holds a write credential
$EDITOR grafana-cloud.env        # fill in the three values
docker compose up -d
```

Credentials come from the Grafana Cloud console under **Connections → OTLP**:

| Variable | Where it comes from |
|---|---|
| `GRAFANA_CLOUD_OTLP_ENDPOINT` | `https://otlp-gateway-prod-<region>.grafana.net/otlp` |
| `GRAFANA_CLOUD_INSTANCE_ID` | numeric stack ID, used as the basic-auth username |
| `GRAFANA_CLOUD_API_TOKEN` | token with `metrics:write`, `logs:write`, `traces:write` |

`grafana-cloud.env` is gitignored. Only the `.example` is tracked.

## Point the app at it

```bash
OBSERVE_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=<your-service-name>
```

The app holds **no** Grafana credential. It only knows the collector's address; the collector holds the token and authenticates on its behalf. Rotating the token is a collector restart, not an app redeploy.

Set `OTEL_SERVICE_NAME` explicitly. Unset, it falls back to `package.json` `"name"`, which is often something unhelpful like `api`, and every trace in Grafana is labelled that.

## Why the ports are bound to 127.0.0.1

The app → collector hop is deliberately unauthenticated, which is what keeps credentials out of every service. The trade is that **anything able to reach 4317/4318 can write into your Grafana Cloud account** and consume the quota.

On one VPS, loopback is exactly the right boundary: the app reaches it, the internet does not.

If the app runs on a different host, do not just remove the `127.0.0.1` prefix — that publishes an unauthenticated ingest endpoint to the internet. Put both machines on a private network, or firewall the ports to the app host's address.

## On Coolify

Coolify runs each resource as its own container stack on a shared Docker network, so the collector is a **separate resource**, not something added to the application image. The app's Dockerfile stays a single process.

1. **New Resource → Docker Compose**, in the same Coolify project as the API so they share a network.
2. Paste this, which differs from the compose above in one important way — it publishes no ports at all:

   ```yaml
   services:
     otel-collector:
       image: otel/opentelemetry-collector-contrib:0.159.0
       command: ["--config=/etc/otelcol/config.yaml"]
       restart: unless-stopped
       mem_limit: 768m
       logging:
         driver: json-file
         options: { max-size: "10m", max-file: "3" }
   ```

   Nothing is published because the API reaches the collector over Coolify's internal network by service name. An unpublished port cannot be reached from the internet at all, which is stricter than the loopback binding used for plain Docker.

3. Add the collector config as a **file mount** at `/etc/otelcol/config.yaml`, pasting the contents of [`../grafana-cloud/otel-collector.yaml`](../grafana-cloud/otel-collector.yaml).
4. Set the three `GRAFANA_CLOUD_*` variables in Coolify's environment/secrets UI for that resource. They belong to the collector only — never to the API.
5. On the **API** resource, set:

   ```bash
   OBSERVE_ENDPOINT=http://otel-collector:4318
   OTEL_SERVICE_NAME=cicardias-api
   ```

   Use whatever service name Coolify assigns the collector container; `otel-collector` is the name from the compose above.

Keeping the collector as its own resource means a sampling change or an image bump is a collector restart, not an application release.

## Operating it

```bash
docker compose logs -f otel-collector      # follow
docker compose restart otel-collector      # after a config or token change
docker compose pull && docker compose up -d   # upgrade the image
```

`restart: unless-stopped` means it comes back after a reboot or crash without a systemd unit.

**Check for export failures** — a silent collector is not proof of delivery:

```bash
docker compose logs otel-collector | grep -iE "401|403|permanent error|failed to"
```

Nothing matching means Grafana Cloud is accepting the data. A 401 or 403 means the token is wrong, expired, or lacks write scope.

## Sizing

`memory_limiter` in the config sheds load at 512 MiB, and `mem_limit` gives the container 768 MiB so the kernel does not OOM-kill it before the limiter engages. Raise both together, never one alone.

The other consumer is `tail_sampling`, which buffers up to `num_traces` traces for `decision_wait` before deciding. On a small VPS, lower `num_traces` in [`../grafana-cloud/otel-collector.yaml`](../grafana-cloud/otel-collector.yaml) before raising the memory limit.

Log rotation is configured (10 MB × 3 files). Without it a long-running collector eventually fills the disk.

## Upgrading

The image is pinned rather than `:latest`, so an upgrade is a deliberate edit to `docker-compose.yaml` followed by `docker compose up -d`. Pinning matters here: a `:latest` that silently changes a deprecated component name can take telemetry down at an arbitrary future restart.
