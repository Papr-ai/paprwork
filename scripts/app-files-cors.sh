#!/usr/bin/env bash
#
# CORS policy for the App Files bucket.
#
# Browser uploads go straight from the tab to GCS, so the bucket — not the
# gateway — is what decides whether they are allowed. Three things must hold or
# uploads fail in ways that are hard to read from the browser console:
#
#   1. PUT allowed from the app origins, or every chunk is blocked outright.
#   2. Content-Range in allowed request headers. Resumable uploads send it on
#      every chunk, and a missing entry fails the preflight, not the PUT — so
#      the error names the wrong thing.
#   3. Range in expose-headers. This is the subtle one: without it the PUT
#      still succeeds, but JS cannot read the committed offset, so a resumed
#      upload silently restarts from byte 0. A 10 GB upload would appear to
#      work and simply never finish.
#
# Idempotent — safe to re-run. Verifies after applying rather than trusting
# that the write landed.
#
# Usage:  ./scripts/app-files-cors.sh [bucket]

set -euo pipefail

BUCKET="${1:-papr-app-files}"
CONFIG="$(mktemp -t app-files-cors)"
trap 'rm -f "$CONFIG"' EXIT

# Origins that may upload. Deliberately explicit: a wildcard would let any site
# a user visits PUT into our bucket using their browser's credentials.
cat > "$CONFIG" <<'JSON'
[
  {
    "origin": [
      "https://apps.papr.ai",
      "https://files.papr.ai",
      "http://localhost:18789"
    ],
    "method": ["GET", "HEAD", "PUT", "POST"],
    "responseHeader": [
      "Content-Type",
      "Content-Length",
      "Content-Range",
      "Range",
      "x-goog-resumable"
    ],
    "maxAgeSeconds": 3600
  }
]
JSON

echo "Applying CORS to gs://${BUCKET}"
gcloud storage buckets update "gs://${BUCKET}" --cors-file="$CONFIG"

echo
echo "Verifying preflight (PUT + Content-Range from https://apps.papr.ai)"
PREFLIGHT="$(curl -s -i -X OPTIONS "https://storage.googleapis.com/${BUCKET}/cors-probe" \
  -H "Origin: https://apps.papr.ai" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-range,content-type")"

check() {
  if grep -qi "$1" <<< "$PREFLIGHT"; then
    echo "  ok    $2"
  else
    echo "  FAIL  $2"
    exit 1
  fi
}

check "access-control-allow-origin: https://apps.papr.ai" "origin allowed"
check "access-control-allow-methods:.*PUT"                "PUT allowed"
check "access-control-allow-headers:.*Content-Range"      "Content-Range accepted"

# expose-headers only appears on a real request, never on the preflight — so
# this has to be checked separately or the most damaging misconfiguration
# (silent restart-from-zero) goes unnoticed.
echo
echo "Verifying Range is readable by browser JS"
EXPOSED="$(curl -s -i "https://storage.googleapis.com/${BUCKET}/cors-probe" \
  -H "Origin: https://apps.papr.ai" | grep -i "access-control-expose-headers" || true)"

if grep -qi "Range" <<< "$EXPOSED"; then
  echo "  ok    Range exposed — resumed uploads can read the committed offset"
else
  echo "  FAIL  Range not exposed — resumed uploads would restart from byte 0"
  exit 1
fi

echo
echo "CORS verified on gs://${BUCKET}"
