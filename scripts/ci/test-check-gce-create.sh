#!/bin/bash
# Tests for check-gce-create.sh: compliant commands pass, each missing piece fails.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
C=scripts/ci/check-gce-create.sh; bad=0
expect() { # expect pass|fail name content
  printf '%s\n' "$3" > "$T/$2.sh"
  if bash "$C" "$T/$2.sh" >"$T/out" 2>&1; then got=pass; else got=fail; fi
  if [ "$got" = "$1" ]; then echo "ok   $2"; else echo "FAIL $2 (expected $1, got $got)"; cat "$T/out"; bad=1; fi
}
expect pass compliant_multiline 'gcloud compute instances create vm --zone z \
  --labels purpose=bench \
  --metadata "startup-script-url=gs://x,block-project-ssh-keys=TRUE" --quiet'
expect pass compliant_labels_eq 'gcloud compute instances create vm --labels=team=a,purpose=x --metadata=block-project-ssh-keys=true'
expect pass template 'gcloud compute instance-templates create t --labels purpose=x --metadata block-project-ssh-keys=TRUE'
expect fail missing_ssh 'gcloud compute instances create vm --zone z \
  --labels purpose=bench \
  --metadata "startup-script-url=gs://x" --quiet'
expect fail missing_label 'gcloud compute instances create vm --metadata block-project-ssh-keys=TRUE'
expect fail ssh_false 'gcloud compute instances create vm --labels purpose=x --metadata block-project-ssh-keys=FALSE'
expect fail template_bad 'gcloud compute instance-templates create t --labels purpose=x'
expect pass unrelated 'gcloud compute instances delete vm --quiet'
expect pass ignored 'gcloud compute instances create vm # gce-policy:ignore (documented exception)'
# The pre-fix launcher must fail; the current one must pass.
git show c001be42:scripts/curation-bench/launch_gpu.sh > "$T/old_launch.sh" 2>/dev/null && {
  if bash "$C" "$T/old_launch.sh" >/dev/null 2>&1; then echo "FAIL pre-fix launch_gpu.sh passed"; bad=1; else echo "ok   pre-fix launch_gpu.sh fails"; fi; }
bash "$C" scripts/curation-bench/launch_gpu.sh >/dev/null && echo "ok   current launch_gpu.sh passes" || { echo "FAIL current launch_gpu.sh"; bad=1; }
exit $bad
