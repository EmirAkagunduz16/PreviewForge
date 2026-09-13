# MVP scope

## Product promise

When a pull request is opened or updated, PreviewForge builds its repository Dockerfile, deploys the resulting immutable image into an isolated Kubernetes namespace, publishes a preview URL, and reports the result to GitHub. Closing the pull request removes the environment.

## Supported in v1

- GitHub App installation and GitHub pull-request events
- Repositories containing one Dockerfile
- One HTTP container per project
- One desired preview environment per pull request
- Configurable container port and health-check path
- Write-only encrypted environment variables
- Build and deployment history with live logs
- GitHub check result and preview link
- Automatic cleanup on pull-request close and TTL expiry
- One pre-provisioned Kubernetes cluster and one container registry

## Non-goals

- GitLab or Bitbucket
- Docker Compose or multi-container application definitions
- Database, Redis, queue, volume, or Kubernetes cluster provisioning
- Production deployments
- Multi-cloud or multi-region operation
- Custom domains, team billing, or enterprise RBAC
- User-controlled Helm charts or arbitrary Kubernetes manifests
- Serverless workloads or autoscaling user workloads
- A public hostile multi-tenant service in the first release

## Success scenario

1. A user signs in and installs the GitHub App on a repository.
2. The user imports the repository and supplies Dockerfile path, port, and health path.
3. Opening PR `#42` creates one deployment for its exact 40-character head SHA.
4. The UI shows durable stage progress and live logs.
5. The image is pushed under an immutable digest.
6. The worker creates a policy-constrained namespace, Deployment, Service, Secret when needed, and HTTPRoute.
7. The health endpoint returns success and GitHub receives a successful check with the preview URL.
8. A new commit supersedes the older deployment; the old build cannot overwrite the new desired state.
9. Closing the PR removes the namespace and marks the preview deleted.

## Product-level acceptance criteria

- Duplicate webhook deliveries create no duplicate deployment.
- A stale commit can never become the active preview after a newer commit is desired.
- Every external side effect is retry-safe or reconciled by stable resource identity.
- Secret values never appear in list/read API responses or logs.
- A failed deployment records a stage, stable error code, redacted message, and retryability.
- Namespace deletion is safe to repeat and leaked resources are found by a reconciler.
