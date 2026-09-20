# Active backlog

M8 and M9 local product experience are complete under their execution plans.
Only the explicitly deferred AWS/EKS/ECR M10 work remains active, and it is not
an M9 dependency.

~~~yaml
- id: M10-CLOUD-DEMO
  status: blocked
  title: Deploy the deferred demo to EKS and ECR
  owner: PreviewForge delivery
  depends_on: [M9-ACCEPTANCE, explicit AWS budget approval]
  acceptance_ref: docs/plans/m9-local-product-experience.md#M10-CLOUD-DEMO
  owned_paths: [infrastructure/eks/, scripts/m10/cloud/, docs/infrastructure/m10-eks-ecr-demo.md, .github/workflows/m10-cloud-demo.yml]
  verification_command: not-run — AWS explicitly deferred
  next_action: obtain explicit maximum spend, billing alert, disposable account/region, and destroy-procedure approval before any AWS preflight or provisioning
  blocker: the user's AWS Free Tier is exhausted and no unapproved cloud spend is authorized
  acceptance: after the future unblock, the fixture reaches EKS READY through an immutable ECR digest, negative RBAC and network-policy probes pass, and close cleanup leaves no cloud demo residue
  evidence: blocked by cost boundary; no AWS calls made
  evidence_commit: not-run

~~~
