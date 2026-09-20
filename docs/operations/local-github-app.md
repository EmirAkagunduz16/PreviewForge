# Controlled local GitHub App path

M9 has a loopback-only GitHub fixture so the product journey can be repeated
without a real GitHub account, credential, or public webhook tunnel. The
fixture is synthetic and must not be pointed at a shared or production API.

## Start the fixture

Validate the immutable fixture inputs first:

```bash
pnpm m9:fixture:check
```

In a separate terminal, start the controlled HTTP server:

```bash
pnpm m9:github-fixture
```

It binds to `127.0.0.1:43129`, implements OAuth/App/repository/content/source/
Check Run endpoints, and writes an ownership-marked state directory under
`/tmp/previewforge-m9-github-fixture`. Stop it with Ctrl-C; the exact state and
generated archive are removed by the fixture process.

The fixture prints the API/OAuth origin and fixed repository identities, but it
never prints synthetic bearer values or private-key material.

## Configure a disposable local run

Generate a throwaway RSA key outside the repository and a local encryption key:

```bash
openssl genrsa 2048 > /tmp/previewforge-m9-app.pem
export M9_APP_KEY_ESCAPED="$(awk '{printf "%s\\n", $0}' /tmp/previewforge-m9-app.pem)"
export M9_ENCRYPTION_KEY="$(openssl rand -hex 32)"
```

Set these values in the disposable shell that will run `pnpm local:up` (or in
`.env`, which is ignored and must never be committed):

```bash
GITHUB_APP_ID=1900009
GITHUB_CLIENT_ID=m9-fixture-client
GITHUB_CLIENT_SECRET=m9-fixture-client-secret
GITHUB_APP_SLUG=previewforge-m9
GITHUB_API_BASE_URL=http://127.0.0.1:43129
GITHUB_OAUTH_BASE_URL=http://127.0.0.1:43129
GITHUB_WEBHOOK_SECRET=m9-fixture-webhook-secret
GITHUB_APP_PRIVATE_KEY="$M9_APP_KEY_ESCAPED"
GITHUB_PRIVATE_KEY="$M9_APP_KEY_ESCAPED"
ENCRYPTION_KEY="$M9_ENCRYPTION_KEY"
PUBLIC_BASE_URL=http://localhost:3000
PREVIEW_BASE_DOMAIN=preview.localhost
PREVIEW_URL_SCHEME=http
PREVIEWFORGE_GATEWAY_LOCAL_PORT=18080
```

The API and worker still use their normal PostgreSQL, Kafka, registry,
rootless BuildKit, kind, and Envoy boundaries. The fixture changes only the
GitHub HTTP origin; it does not bypass webhook HMAC verification, ownership,
desired-SHA fencing, immutable digests, or workload policy.

## Exercise the lifecycle boundary

After the repository has been imported from the dashboard, run the signed
webhook sequence from another terminal:

```bash
M9_API_ORIGIN=http://127.0.0.1:4000 \
GITHUB_WEBHOOK_SECRET=m9-fixture-webhook-secret \
  pnpm m9:demo
```

The runner sends open, duplicate-open, synchronize, stale-open, close, and
duplicate-close deliveries, then verifies that a pretty-printed body with the
original signature is rejected. It prints scenario counts only; it does not
print payloads, bearer values, or database secrets.

This command is a control-plane boundary check, not full M9 acceptance. The
full gate still needs the browser import flow, a real worker build and
immutable-digest deployment, Envoy hostname/port routing, live-log reconnect,
failure/retry injection, exact close cleanup, and a successful rerun.

## Real GitHub path

For a real GitHub App, stop the fixture and restore the documented real
`GITHUB_*` values. GitHub must reach the webhook endpoint through an explicitly
configured public HTTPS tunnel; PreviewForge does not create that tunnel or
store its credential. Keep the controlled fixture and real setup in separate
disposable environments so a test delivery cannot reach a real repository.
