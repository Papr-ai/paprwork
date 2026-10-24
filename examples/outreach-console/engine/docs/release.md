# Release preparation

Current source version is **0.0.0**, not a published release. Packaging checks may
run with `npm run release:verify -- --allow-unreleased`; publication refuses 0.0.0.
No workflow, document or local test constitutes approval to publish or deploy.

## Maintainer checklist

- Review ADRs and BUILD_PLAN decisions. Resolve incomplete M8/M9 scope explicitly.
- Run build, full check, soak, package dry-run, and clean-install CLI/MCP smoke tests.
- Complete allowlisted Gmail and Outlook sends, uncertain-outcome/reply checks,
  live Papr bundle acceptance and an actual Claude Code stdio handshake.
- Stage 2 remote MCP remains blocked on approved issuer/audience/HTTPS hosting and
  ChatGPT acceptance. Do not expose unauthenticated HTTP as a substitute.
- Assign one coordinated release version to all public packages and update exact
  internal dependency versions and package-lock.json. Add dated release notes.
- Configure npm Trusted Publisher for each public package and workflow
  `outreach-engine-publish.yml`; protect the GitHub `npm-release` environment with
  required maintainer review. Initial package bootstrap may require a maintainer.
  These are persistent access changes and require explicit authorization.
- Merge only after review and authorization. Create a signed annotated tag
  `outreach-engine-v<VERSION>` on clean main with a verified signing identity.
  Pushing that tag is the publication action and needs explicit authorization.

The workflow rejects lightweight/unverified tags and tags not reachable from
main, checks exact package versions, runs the test suite, inspects package contents,
and calls the existing OIDC publisher in dependency order. It never reads npm
long-lived tokens. GitHub Release creation is part of the same authorized release.
Publication can partially succeed; inspect npm versions before retrying. The shared
publisher skips exact versions already published and does not overwrite them.

The hub README entry can be prepared here; the `splitin.net/tech-stack` entry lives
in a different product/site and remains a separately authorized publication item.

Migration note: schema 0003 adds durable prepared operations without editing older
migration checksums. Activation hashes now include sender, template and recipient
personalization data. Re-prepare preexisting draft activations after upgrade;
stale approvals are not silently grandfathered. Back up and test migration before
upgrading a production database.
