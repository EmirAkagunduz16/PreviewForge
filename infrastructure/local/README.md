# Local infrastructure

`compose.yaml` provides only control-plane dependencies: PostgreSQL, single-node Kafka in KRaft mode, and a local OCI registry. It does not pretend to emulate Kubernetes.

Start and stop it through the root pnpm scripts. The Kafka listener and registry are intentionally unauthenticated and must remain local-development only.

The Kubernetes milestone will add a reproducible kind cluster and a conformant Gateway API implementation after the controller choice is tested. `pnpm doctor` currently reports kind as optional so foundation work remains runnable before that milestone.

Host ports intentionally use `55432` (PostgreSQL), `59092` (Kafka), and `55000` (registry) to avoid colliding with common developer services. Container-internal ports remain standard.
