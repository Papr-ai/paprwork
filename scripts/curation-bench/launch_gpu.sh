#!/bin/bash
# Start the GPU step (run_gpu.sh) on a spot L4 and wait for it. Tries a few zones; deletes the VM at the end.
#   launch_gpu.sh gs://.../vectors/<key> "v10_int8 [v11_pt]"
set -euo pipefail
P=$1; ARMS=$2; NAME=cb-$(date +%s); ZONE=""
for z in us-central1-a us-central1-b us-central1-c us-east4-a us-east1-c us-west1-a; do
  if gcloud compute instances create "$NAME" --zone "$z" --machine-type g2-standard-8 --accelerator type=nvidia-l4,count=1 \
      --image-family pytorch-2-9-cu129-ubuntu-2204-nvidia-580 --image-project deeplearning-platform-release \
      --boot-disk-size 150 --maintenance-policy TERMINATE --scopes cloud-platform \
      --provisioning-model SPOT --instance-termination-action STOP --labels purpose=curation-bench \
      --metadata "startup-script-url=$P/code/run_gpu.sh,bench=$P,arms=$ARMS,install-nvidia-driver=True" --quiet >/dev/null 2>&1; then
    ZONE=$z; break
  fi
done
[ -n "$ZONE" ] || { echo "::error::no spot L4 capacity"; exit 1; }
trap 'gcloud compute instances delete "$NAME" --zone "$ZONE" --quiet >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 120); do
  gcloud storage ls "$P/out/ALL_DONE" >/dev/null 2>&1 && break
  st=$(gcloud compute instances describe "$NAME" --zone "$ZONE" --format="value(status)" 2>/dev/null || echo GONE)
  [ "$st" = "TERMINATED" ] && gcloud compute instances start "$NAME" --zone "$ZONE" --quiet >/dev/null 2>&1 || true
  sleep 30
done
for a in $ARMS; do gcloud storage ls "$P/out/$a/DONE" >/dev/null || { echo "::error::$a vectors missing"; exit 1; }; done
