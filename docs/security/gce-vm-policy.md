# GCE VM policy (SOC 2)

Secureframe test: **"Project-wide SSH keys are restricted (GCP)"**. Every VM must have instance metadata
`block-project-ssh-keys=TRUE`, otherwise the project-level `ssh-keys` grant shell access to it.

## Rules for code that creates VMs
Every `gcloud compute instances create` / `instance-templates create` in this repo must pass:
- `--metadata ...,block-project-ssh-keys=TRUE`
- `--labels purpose=<owner-task>` (lets a finding map to an owner and a cleanup rule)

Enforced in CI by `scripts/ci/check-gce-create.sh` (the "Change control" required check), tests in
`scripts/ci/test-check-gce-create.sh`. A deliberate exception needs `# gce-policy:ignore` on the command and a
reason in the PR.

## Backstop: auto-fix (defense in depth)
`infra/gce-ssh-guard/` (Cloud Run, project `gen-lang-client-0873281406`): an audit-log sink on
`compute.instances.insert|setMetadata` pushes each event through Pub/Sub; the service sets
`block-project-ssh-keys=TRUE` on the VM if missing, typically within seconds and well before Secureframe's daily
scan. Every fix is logged at `NOTICE` with the VM and the actor who created it, so the source can be fixed in code.
Deploy / redeploy: `infra/gce-ssh-guard/deploy.sh`.

Check what it fixed:
```
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="gce-ssh-guard" AND jsonPayload.result="fixed"' --project gen-lang-client-0873281406 --limit 20
```
