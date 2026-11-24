# Change Management: paprwork cloud services

Applies to the cloud app host (`apps.papr.ai`, Cloud Run service `papr-cloud-app-host`) and the cloud
agent gateway (`papr-cloud-agent-gateway`).
Supports SOC 2 CC8.1. Owner: Amir Kabbara.

## Normal changes

1. Work on a branch, open a PR into `development`. CI runs tests and Semgrep.
2. Merge to `development`. GitHub Actions (**Deploy Cloud App Host**) runs tests, builds the image and
   deploys it to `papr-cloud-app-host-dev`, then health-checks it.
3. Open a PR from `development` into `master`. Branch protection requires 1 approving review from
   someone other than the author and passing checks.
4. Merge to `master`. The workflow runs tests, builds, and deploys a **candidate revision with 0% traffic**
   to `papr-cloud-app-host`, then health-checks the candidate URL. Production traffic is unchanged.
5. The **Promote** job shifts traffic to 100% automatically once the candidate passes its health check,
   then verifies `apps.papr.ai/health`. If the health check fails, production traffic is never changed.
   The approval in step 3 (someone other than the author, admins included) is the change authorization;
   there is no second approval at deploy time.

### Holding a launch at 0%

To ship several services together, set the repository variable `CLOUD_PROMOTE_HOLD=true`
(Settings → Secrets and variables → Actions → Variables) before merging, or run a deploy manually with
`hold` checked. Candidates deploy and health-check but stay at 0%. When ready, run
**Promote Cloud Services** on `master` with the commit (8 characters) and the services to switch; they are
promoted at the same time. Set the variable back to `false` afterwards. The same workflow rolls back to an
older commit whose revision still exists.

Evidence for each production change lives in GitHub: the PR + review, the workflow run (tests, image tag,
commit), the candidate health check, and the promote job (who triggered it, when, previous revision).

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
2. Deploy through the workflow if at all possible.
   Laptop deploy (`node scripts/deploy-cloud-app-host.mjs --break-glass`) is a last resort.
3. Within 1 business day: a second person reviews the merged change, comments on the PR, and the
   change is noted in the weekly ops review.

## Access

- GitHub Actions deploys with keyless Workload Identity Federation (`github-pool`, restricted to the
  `Papr-ai/paprwork` repo) as `gha-cloud-app-host-deployer`. No service-account keys are stored in GitHub.
- Production environments (`cloud-app-host-production`, `cloud-agent-gateway-production`) only accept
  deploys from `master`. `master` requires 1 approving review from someone other than the author, applied
  to admins too.
