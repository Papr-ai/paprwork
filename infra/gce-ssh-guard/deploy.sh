#!/bin/bash
# Deploy the SOC 2 SSH-keys auto-fix. Idempotent; re-run after changing main.py.
#   infra/gce-ssh-guard/deploy.sh [PROJECT]
# Audit log (compute.instances.insert|setMetadata, last op) -> log sink -> Pub/Sub -> push (OIDC) -> Cloud Run.
set -euo pipefail
P=${1:-gen-lang-client-0873281406}; R=us-central1; N=gce-ssh-guard
SA=$N@$P.iam.gserviceaccount.com
cd "$(dirname "$0")"
gcloud iam service-accounts describe "$SA" --project "$P" >/dev/null 2>&1 ||
  gcloud iam service-accounts create $N --project "$P" --display-name "SOC 2 SSH-keys auto-fix"
for i in 1 2 3 4 5 6 7 8 9 10; do  # new SAs take a few seconds to be visible to IAM
  gcloud iam service-accounts describe "$SA" --project "$P" >/dev/null 2>&1 && break; sleep 3; done
# setMetadata on VMs (+ actAs for VMs that run as a service account).
for role in roles/compute.instanceAdmin.v1 roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$P" --member "serviceAccount:$SA" --role $role --condition=None -q >/dev/null ||
    { sleep 10; gcloud projects add-iam-policy-binding "$P" --member "serviceAccount:$SA" --role $role --condition=None -q >/dev/null; }
done
gcloud run deploy $N --project "$P" --region $R --source . --service-account "$SA" --no-allow-unauthenticated \
  --ingress all --max-instances 2 --memory 256Mi --labels purpose=soc2-ssh-guard -q
URL=$(gcloud run services describe $N --project "$P" --region $R --format 'value(status.url)')
gcloud run services add-iam-policy-binding $N --project "$P" --region $R --member "serviceAccount:$SA" --role roles/run.invoker -q >/dev/null
PN=$(gcloud projects describe "$P" --format 'value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$P" -q >/dev/null \
  --member "serviceAccount:service-$PN@gcp-sa-pubsub.iam.gserviceaccount.com" --role roles/iam.serviceAccountTokenCreator
gcloud pubsub topics describe $N --project "$P" >/dev/null 2>&1 || gcloud pubsub topics create $N --project "$P"
FILTER='logName="projects/'"$P"'/logs/cloudaudit.googleapis.com%2Factivity" AND resource.type="gce_instance" AND protoPayload.methodName=~"compute\.instances\.(insert|setMetadata)$" AND operation.last=true'
if gcloud logging sinks describe $N --project "$P" >/dev/null 2>&1; then
  gcloud logging sinks update $N "pubsub.googleapis.com/projects/$P/topics/$N" --log-filter "$FILTER" --project "$P" -q
else
  gcloud logging sinks create $N "pubsub.googleapis.com/projects/$P/topics/$N" --log-filter "$FILTER" --project "$P" -q
fi
WRITER=$(gcloud logging sinks describe $N --project "$P" --format 'value(writerIdentity)')
gcloud pubsub topics add-iam-policy-binding $N --project "$P" --member "$WRITER" --role roles/pubsub.publisher -q >/dev/null
if gcloud pubsub subscriptions describe $N --project "$P" >/dev/null 2>&1; then
  gcloud pubsub subscriptions update $N --project "$P" --push-endpoint "$URL" --push-auth-service-account "$SA"
else
  gcloud pubsub subscriptions create $N --project "$P" --topic $N --push-endpoint "$URL" --push-auth-service-account "$SA" \
    --ack-deadline 60 --min-retry-delay 5s --max-retry-delay 60s --message-retention-duration 1d
fi
echo "Deployed: $URL"
