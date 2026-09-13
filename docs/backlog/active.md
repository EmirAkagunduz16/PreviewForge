# Active backlog

Only unfinished work belongs here. Update this file before starting work and before handing off.

## Repository follow-up

```yaml
- id: OPS-LOCAL-REPO
  status: in-progress
  title: Establish an independent Git repository for PreviewForge
  owner: project-maintainer
  depends_on: []
  next_action: Create the first local commit, verify history from PreviewForge root, and retain the documented no-remote policy until a dedicated remote is selected.
  acceptance: git status/history operate from the PreviewForge root with explicit remote/branch policy.
  evidence: independent .git initialized on main; first commit not yet created.
```
