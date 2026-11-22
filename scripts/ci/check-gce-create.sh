#!/bin/bash
# SOC 2 (Secureframe "Project-wide SSH keys are restricted (GCP)"): every VM or instance template this repo creates
# must set block-project-ssh-keys=TRUE in its metadata and carry a purpose label (so Secureframe findings map to an owner).
# Scans tracked shell, workflow, Python, JS/TS and Markdown-free code for `gcloud compute instances create` and
# `gcloud compute instance-templates create`, joining backslash-continued lines into one command.
#   check-gce-create.sh            # scan the repo (CI)
#   check-gce-create.sh FILE...    # scan given files (tests)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# bash 3.2 compatible (macOS): no mapfile.
files=()
if [ $# -gt 0 ]; then files=("$@"); else
  while IFS= read -r f; do files+=("$f"); done < <(git ls-files -- '*.sh' '*.bash' '*.yml' '*.yaml' '*.py' '*.js' '*.mjs' '*.ts' '*.mts' \
    ':!:node_modules/**' ':!:scripts/ci/check-gce-create.sh' ':!:scripts/ci/test-check-gce-create.sh')
fi
[ ${#files[@]} -gt 0 ] || { echo "GCE VM policy: no files to scan"; exit 0; }
fail=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  grep -qE 'compute[[:space:]]+(instances|instance-templates)[[:space:]]+create' "$f" || continue
  # Join continuation lines, remember the first line number of each logical command.
  while IFS=$'\t' read -r line cmd; do
    case "$cmd" in *gce-policy:ignore*) continue ;; esac
    miss=()
    printf '%s' "$cmd" | grep -Eq 'block-project-ssh-keys=(TRUE|true|True)' || miss+=("block-project-ssh-keys=TRUE")
    printf '%s' "$cmd" | grep -Eq -- '--labels[= ][^ ]*purpose=[A-Za-z0-9_-]+' || miss+=("--labels purpose=<owner-task>")
    if [ ${#miss[@]} -gt 0 ]; then
      echo "::error file=$f,line=$line::VM created without ${miss[*]} (SOC 2: project-wide SSH keys must be blocked; see docs/security/gce-vm-policy.md)"
      fail=1
    fi
  done < <(awk '
    { l=$0; if (buf=="") start=NR; buf = buf " " l }
    l ~ /\\[[:space:]]*$/ { sub(/\\[[:space:]]*$/, "", buf); next }
    { if (buf ~ /compute[[:space:]]+(instances|instance-templates)[[:space:]]+create/) printf "%d\t%s\n", start, buf; buf="" }
  ' "$f")
done
[ $fail -eq 0 ] && echo "GCE VM policy (block-project-ssh-keys + purpose label): ok"
exit $fail
