# Source snapshot and update procedure

## Exact scope

`engine/` contains every tracked regular file below `outreach-engine/` in
[`splitintech/open-internal-tools` commit `13a7ffb75de3c5be017ce05d15e4115f191252d7`](https://github.com/splitintech/open-internal-tools/tree/13a7ffb75de3c5be017ce05d15e4115f191252d7/outreach-engine).
The mapping is `outreach-engine/<path>` to `examples/outreach-console/engine/<path>`.
There are 272 files, 1,228,930 bytes, all Git mode `100644`. No source file is omitted
or rewritten. This includes 13 packages, the `apps/papr` workspace, tests, npm
lockfile/configuration, docs, build/check scripts and original license files.

`SOURCE-SNAPSHOT.json` records both paths, sizes, Git blob SHA-1 and SHA-256.
From this example directory, verify a clean snapshot without network or dependencies:

```sh
node scripts/verify-engine-snapshot.mjs
node --test tests/*.test.mjs
```

Run the snapshot verifier before installing/building: it deliberately rejects extra
files, including generated dependencies and outputs, rather than silently ignoring drift.
It verifies local bytes against the recorded inventory; an update also requires
independent comparison of that inventory with the source repository's pinned Git tree.

## Which adapter to use

Import the outer `bundle/`. The nested `engine/apps/papr` is an exact historical source
workspace, retained so its existing tests, package metadata and lockfile stay intact.
It is not the recommended import target in this contribution.

Compared with the nested source bundle, the outer bundle adds:

1. A separate DB/network/key-free startup `ping` handler and its action declaration.
2. App-local `requirements.json` matching the manifest's server-only key declarations.
3. The job-root command `node code/run.mjs` instead of `node run.mjs`, plus corrected
   deployment-profile notes specifying the trusted gateway process environment.

The protected backend handler, browser code and optional worker implementation are
otherwise identical. The outer docs describe trusted gateway environment configuration
and the still-unverified host cancellation behavior. Do not propagate a snapshot update
over these corrections blindly; compare both bundles and rerun their tests.

## Relocation and historical references

Build, check, workspace resolution and lockfile links are local to `engine/`. Use the
development commands in the outer README rather than its historical
`cd open-internal-tools/outreach-engine` example.

The retained engine README references a logo at `../docs/brand/splitin-logo.png`; that
source-repository branding asset is not included. The retained
`engine/scripts/publish-release.mjs` refers to a source-repository
`../scripts/oidc-npm-publish.mjs` helper and protected release workflows outside this
snapshot. Those are intentionally not copied or enabled. They are not required to
build, test, or run the engine; publishing from this nested example is unsupported.
Historical ADR/release descriptions are source history, not new operational instructions.

Papr root dependencies, workspace registration, workflows and runtime entry points are
unchanged. At the pinned Papr baseline, its TS/lint/test entry points and Electron file
allowlist do not include this nested engine. Its repository-wide TypeScript line-limit
check does include the source; the added TypeScript files satisfy that convention.
Run the engine checks explicitly as well as Papr's checks before merge.

## Updating deliberately

1. Select a reviewed immutable source commit. Record its repository, commit and CI result;
   do not follow a moving branch implicitly.
2. Enumerate `git ls-tree -r <commit> -- outreach-engine/` in a verified source checkout.
   Export only that tracked subtree (for example with `git archive`), never recursively
   copy a working directory containing caches, local databases or credentials.
3. Replace the nested snapshot in a dedicated review branch. Generate a fresh inventory
   from every tracked source blob and verify paths, mode, byte size, SHA-1 and SHA-256.
   Review additions/deletions, package/lockfile changes and license notices explicitly.
4. Compare `engine/apps/papr/bundle/` with the outer `bundle/`. Reconcile the three
   documented corrections deliberately; retain one authoritative outer import target.
5. Run the clean snapshot verifier, standalone contracts, engine install/build/full check
   and fake-provider soak. Run Papr's contribution checks and applicable host acceptance
   separately. Label any pending gate and do not reuse old CI as proof of a new run.
6. Update README, NOTICE, ACCEPTANCE and this mapping together. Obtain maintainer review;
   a source refresh is not permission to publish packages, enable sending or deploy.
