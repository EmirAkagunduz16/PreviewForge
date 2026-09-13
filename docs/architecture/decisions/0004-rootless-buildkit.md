# ADR 0004: Dedicated rootless BuildKit

Status: Accepted

## Decision

Run builds through a dedicated rootless BuildKit deployment. Workers never mount the host Docker socket and never enable insecure build entitlements. Source acquisition and build execution use separate credentials and trust zones.

## Rationale

Repository Dockerfiles execute untrusted commands. A Docker socket would turn a normal build compromise into host control. Rootless BuildKit reduces that privilege while preserving Dockerfile compatibility and caching.

## Consequences

Some Dockerfiles requiring privileged behavior are unsupported. BuildKit's documented Kubernetes rootless limitations must be tested on the chosen cluster. Cache and daemon tenancy require a security review before public multi-tenancy.
