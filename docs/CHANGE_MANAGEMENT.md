# Change Management: paprwork cloud services

Applies to the cloud app host (`apps.papr.ai`, Cloud Run service `papr-cloud-app-host`).
Supports SOC 2 CC8.1. Owner: Amir Kabbara.

## Normal changes

1. Work on a branch, open a PR into `development`. CI runs tests and Semgrep.
2. Merge to `development`. GitHub Actions (**Deploy Cloud App Host**) runs tests, builds the image and
   deploys it to `papr-cloud-app-host-dev`, then health-checks it.
3. Open a PR from `development` into `master`. Branch protection requires 1 approving review from
   someone other than the author and passing checks.
4. Merge to `master`. The workflow runs tests, builds, and deploys a **candidate revision with 0% traffic**
   to `papr-cloud-app-host`, then health-checks the candidate URL. Production traffic is unchanged.
5. The **Promote** job waits on the `cloud-app-host-production` GitHub environment. A required reviewer
   (not the person who triggered the run) tests the candidate URL and approves. Traffic shifts to 100%
   and `apps.papr.ai/health` is verified.

Evidence for each production change lives in GitHub: the PR + review, the workflow run (tests, image tag,
commit), and the environment approval (who approved, when).

## Rollback

Re-point traffic to the previous revision (printed in the Promote job summary):

```
gcloud run services update-traffic papr-cloud-app-host --to-revisions=<previous-revision>=100 \
  --region=us-west1 --project=gen-lang-client-0873281406
```

Record the rollback in the incident/PR thread.

## Emergency changes

Use only when production is down or a security fix cannot wait for normal review.

1. Open the PR anyway and add the `emergency` label. Merge with the fastest available review; if no
   reviewer is available, the merger documents why in the PR.
2. Deploy through the workflow if at all possible (approval can be given by the other reviewer).
   Laptop deploy (`node scripts/deploy-cloud-app-host.mjs --break-glass`) is a last resort.
3. Within 1 business day: a second person reviews the merged change, comments on the PR, and the
   change is noted in the weekly ops review.

## Access

- GitHub Actions deploys with keyless Workload Identity Federation (`github-pool`, restricted to the
  `Papr-ai/paprwork` repo) as `gha-cloud-app-host-deployer`. No service-account keys are stored in GitHub.
- Required reviewers for production: Amir Kabbara, Shawkat Kabbara. Self-approval is disabled.
