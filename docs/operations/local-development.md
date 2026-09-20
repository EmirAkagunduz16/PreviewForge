# Local development runtime

M9's local runtime is an operator helper for the trusted, disposable
PreviewForge development environment. It is not a production launcher and it
does not install host packages, change the Docker context, alter AppArmor or
sysctl settings, create a tunnel, or request GitHub/AWS credentials.

## First-time prerequisites

1. Install Node.js 22, pnpm 10, Docker with Compose, kubectl, and kind.
2. Copy `.env.example` to `.env` and fill the GitHub App, encryption, and
   public callback values. `GITHUB_APP_PRIVATE_KEY` is consumed by the API;
   `GITHUB_PRIVATE_KEY` is the worker copy of the same key with escaped `\n`
   sequences accepted.
3. Provision the accepted rootless BuildKit boundary described in
   [M4 rootless image build](../infrastructure/m4-rootless-buildkit.md). The
   runtime only accepts a Unix socket and verifies it with `buildctl debug
   workers`; it never falls back to a Docker socket, TCP BuildKit, privileged
   mode, host networking, or a global security relaxation.
   If the provisioned setup has a dedicated foreground supervisor command,
   `PREVIEWFORGE_LOCAL_BUILDKIT_COMMAND` may contain that command as a JSON
   string array; otherwise the runtime verifies the already-running socket.
   The M9 worker pushes to the Compose registry through the kind Docker-network
   gateway. Stage that endpoint into the rootless BuildKit config before the
   local runtime starts:

   ```bash
   registry_gateway="$(docker network inspect kind --format '{{range .IPAM.Config}}{{println .Gateway}}{{end}}' | awk '/^[0-9]+([.][0-9]+){3}$/ { print; exit }')"
   test -n "$registry_gateway"
   sudo env PREVIEWFORGE_BUILDKIT_REGISTRY_HOST="${registry_gateway}:55000" \
     ./scripts/m4-runner/stage-rootless-runtime-config.sh
   ```

   Restart the dedicated rootless stack after staging. Set
   `PREVIEWFORGE_REGISTRY_HOST` to the same `host:port` only when the derived
   gateway is not suitable for the host; `local:up` derives it automatically
   when the configured value is the default `localhost:55000`.
4. Confirm the selected project Docker context and host prerequisites:

   ```bash
   pnpm run doctor
   ```

The runtime uses `PREVIEWFORGE_DOCKER_CONTEXT`, then `DOCKER_CONTEXT`, then
`default`. It refuses `DOCKER_HOST` overrides. The default local topology uses
PostgreSQL `localhost:55432`, Kafka `localhost:59092`, registry
`localhost:55000` for the host port and the kind network gateway for BuildKit
pushes, API `localhost:4000`, dashboard `localhost:3000`, and the
Envoy loopback Gateway port `18080`. A READY preview is exposed as
`http://preview-<environment-id>.preview.localhost:18080/`; the port is only
the loopback forward and the hostname remains the HTTPRoute identity. The
supervisor writes a private,
ownership-marked kubeconfig for the named kind cluster and never applies the
bootstrap manifests through an ambient user-selected Kubernetes context.

When a default host port is occupied, override `PREVIEWFORGE_POSTGRES_LOCAL_PORT`,
`PREVIEWFORGE_KAFKA_LOCAL_PORT`, or `PREVIEWFORGE_REGISTRY_LOCAL_PORT` and keep
`DATABASE_URL`, `KAFKA_BROKERS`, `REGISTRY_HOST`, and `CONTAINER_REGISTRY`
aligned with the selected ports.

The kind node's default HTTP/HTTPS host mappings are `30080/30443`. If either
host port is occupied, override `PREVIEWFORGE_KIND_HTTP_HOST_PORT` and
`PREVIEWFORGE_KIND_HTTPS_HOST_PORT`; bootstrap then creates a temporary config
override and leaves the repository config and unrelated listener alone.
The Envoy Gateway deployment wait defaults to 300 seconds so a first image pull
does not become a false local-runtime failure; override
`PREVIEWFORGE_ENVOY_GATEWAY_WAIT_SECONDS` only when the disposable host needs a
different bounded wait.

## Start, inspect, stop

Start the owned local runtime in the foreground:

```bash
pnpm local:up
```

The command loads `.env` without printing values, verifies the required
commands and runtime identities, starts or reuses the local PostgreSQL/Kafka/
registry services, applies migrations, creates or reuses the named kind
cluster and Gateway, connects the registry, starts the Gateway port-forward,
and starts API, worker, and web through `pnpm dev`. Readiness is not reported
until API health, worker observability health, and the dashboard respond.

In another terminal, inspect only redacted process/port state:

```bash
pnpm local:status
```

Stop the exact runtime owned by the start command:

```bash
pnpm local:down
```

The state and logs live under the exact ownership-marked directory configured
by `PREVIEWFORGE_LOCAL_STATE_DIR` (default `/var/tmp/previewforge-local`).
Teardown stops only recorded process groups and Compose service containers
created by this runtime, deletes a kind cluster only when this runtime created
that exact cluster, and removes its state directory. An unmarked or unexpected
state directory is never recursively removed.

## GitHub callback boundary

The browser OAuth callback may use the local dashboard origin, but GitHub must
reach the webhook endpoint from outside the machine. Configure a user-owned
HTTPS tunnel and set the GitHub App webhook URL to the tunnel's `/api/webhooks/
github` endpoint. Keep the setup URL and OAuth callback aligned with the
configured `PUBLIC_BASE_URL`. PreviewForge does not install or start a tunnel
automatically; the controlled M9 fixture is the credential-free path for
repeatable acceptance.

## Failure handling

`local:up` fails closed with the missing command, configuration name, Docker
context, or BuildKit socket boundary. A failed child process is reported with
its log path. Do not bypass a failure with `--privileged`, a Docker socket,
`DOCKER_HOST`, host networking, or a global AppArmor/sysctl change; repair the
documented local prerequisite and rerun the preflight.
