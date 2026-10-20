# Change management (SOC 2)

Every change to production follows this path. GitHub enforces the steps marked (enforced).

1. **Ticket.** Every PR links a ticket in its description (`Ticket: #123` or a Linear URL). (enforced: Change control check)
2. **PR into `development`.** No direct pushes. The author may merge their own PR once checks pass. (enforced: branch protection)
3. **Verify on dev.** Test the change on the dev environment and record it in Release Desk ("Mark verified"). Release Desk posts the sign-off as a comment on the PR.
4. **Release PR.** Release Desk opens the PR from `development` (memory) or `release/vX.Y.Z` (paprwork) into the production branch, listing each change and its dev verification.
5. **Second-person approval.** Someone other than the author approves the release PR. New pushes reset the approval. Admins cannot bypass. (enforced: branch protection)
6. **Ship.** Merging deploys memory to Cloud Run, or tags paprwork and starts the build. memory ships before paprwork.

Only `development`, `release/*` and `hotfix/*` branches may target the production branch. (enforced: Change control check)

**Hotfix / break-glass.** Branch `hotfix/...` from the production branch, PR straight into it (still needs a second approver), then log the exception in Release Desk with the reason. It is reviewed within 48 hours.

## For AI agents (Pen, Claude, Codex)
Follow the steps above exactly. In particular:
- Never push to `development`, `main` or `master` directly. Always open a PR into `development`.
- Put the ticket in the PR description. If there is none, create a GitHub issue first.
- Never approve a PR you authored or helped write, and never merge into `main`/`master` without a human approval.
- After a change is merged to development and tested, record "Verified on dev" through Release Desk with what you tested.
- Releases happen only through Release Desk ("Send to production").
