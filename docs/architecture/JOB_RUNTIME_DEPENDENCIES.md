# Job runtime dependencies — declare, don't install

**Status:** Phase 1 implemented (this PR). Phases 2–3 proposed.
**Driver:** Launch Video Studio needs numpy/pillow (Python), ffmpeg + Node (tools), and vite/playwright (npm).
Before this change the platform installed packages only for `python` and `node` jobs; `bash`, `shell`
and `agent` jobs got nothing, so every app author reinvented installation inside their own scripts.

## The rule

A job **declares** what it needs in its own folder. The platform makes it real before launch, for every
job type. Scripts and agents never install anything themselves.

| File in the job folder | Meaning |
|---|---|
| `requirements.txt` | Python packages (existing convention — `create_job`/`update_job` already write it) |
| `runtime.json` | `{ "python": [...], "node": [...], "tools": ["ffmpeg", "node"] }` — merged with `requirements.txt` |

Both travel with the job folder, so forks, copies and catalog installs inherit them.

## What happens at launch (`ensureJobRuntime`)

1. **Python:** `.venv` in the job folder + `pip install -r` of the merged list. A marker file makes an
   unchanged re-run a no-op (~0.3 s measured vs ~22 s first install).
2. **Node:** declared packages install once into a shared, content-addressed folder
   `~/.paprwork-v2/runtimes/node/<hash-of-sorted-packages>` — two jobs asking for the same packages share
   one install, and it is outside the synced workspace so `node_modules` is never committed or synced.
3. **PATH injection** (`VIRTUAL_ENV`, `NODE_PATH`, venv + `.bin` prepended to `PATH`): a bare `python3`,
   `pip` or `vite` resolves to the declared environment. This works for shell scripts **and** for the shell an
   agent job's `bash` tool opens — no `source activate` rewriting.
4. **Tool preflight:** each name in `tools` is looked up on the job's resolved `PATH`.
5. **Failure is structured:** `MissingDependencyError { code: "missing_dependency", items: [{kind, name,
   installHint}] }`, logged as one `PAPR_ERROR {json}` line and classified *permanent* (no pointless retries).
   A UI can render an Install button from it; an agent no longer improvises `brew install`.

Legacy `python` jobs keep their old behaviour on pip failure (log and let the job try).

## Why not Docker (locally)?

Docker Desktop is a heavy, admin-requiring daemon, unavailable on many corporate/locked-down machines,
and the jobs here need the user's real files, GPU-less ffmpeg, a real browser and the local gateway.
Containers add an install step bigger than the problem. Local = user-space, pinned, no daemon.

For **cloud** a container is the right unit, and the repo already ships `Dockerfile.cloud-*`. The same
manifest should feed the image build (Phase 3), so local and cloud are provisioned from one declaration
instead of two drifting recipes. Sandboxing untrusted *shared* apps is a separate question from dependency
management; for that the credible options are microVMs (Firecracker-style, as used by Lambda/Fly) in the
cloud and OS sandboxes (macOS `sandbox-exec`/Apple's Containerization, Linux bubblewrap/Landlock) locally.

## Phases

- **Phase 1 (this PR):** the mechanism above, for every job type; `runtime.json`; structured error; tests.
- **Phase 2:** managed tool store (pinned static ffmpeg, Playwright Chromium in one shared
  `PLAYWRIGHT_BROWSERS_PATH`, `uv` for Python) so `tools` can be *provided*, not just checked; a setup card at
  app install/import showing everything about to be installed; "prepare workspace" for a user's repo
  (separate `git worktree`, `npm ci`, free port) instead of touching their dev checkout.
- **Phase 3:** shared hash-keyed Python caches (uv), manifest → cloud image, `validate_job` warning when code
  imports/calls something undeclared.

## Verification

- `tests/job-runtime-deps.test.ts` — 13 hermetic tests (spec merge, tool lookup, venv/pip/node via a fake
  installer, no-reinstall, failure classification).
- `npx tsx scripts/e2e-job-runtime.ts <job folder>` — real venv, real pip, real PATH injection through the
  actual `CommandJobExecutor`, run against a copy of Launch Video Studio's Studio Engine job.
