# Testing on-device code search (papr-embed-code-1-0.6b)

What it is: when the agent greps inside a Papr app or job, `bash.ts` also asks the on-device model
(`src/core/tools/codeEmbed/`) and puts a `=== Semantic code search (papr-embed-code, …) ===` block above the normal
grep output. ONNX int8 in a worker thread first, then CoreML on the Neural Engine on Apple Silicon. Grep output is
never changed.

## 1. Unit tests (CI, every PR; no model, no network)

    npm run test:code-embed

Covers: device tiers, chunking (every chunk fits the Neural Engine's 1024 tokens), rename/edit/delete, cloud
fallback, background indexing, ONNX → Neural Engine swap, time budget, self-test, grep detection of quoted phrases,
project id from the path, and the merge into the pointer ranking. Runs in CI as part of `unit-backend`
("Vitest + CI sequential tier", a required check on `development`).

## 2. Live tests (real model, on your machine; required evidence for changes to codeEmbed/ or the grep path)

Install the model once (≈600 MB ONNX + tokenizer, +1.2 GB CoreML on Apple Silicon):

    export PAPR_CODE_EMBED_MODEL_ROOT=~/papr-embed-test
    PAPR_CODE_EMBED_LIVE_DOWNLOAD=1 npm run test:code-embed:live

Later runs:

    sh native/papr-embed-coreml/build.sh        # Apple Silicon: builds the Neural Engine helper
    npm run test:code-embed:live

The 9 tests check: 1024-d unit vectors; each query ranks its own snippet first by > 0.1; worker and in-thread ONNX
give identical vectors and the event loop stays free; queries get the instruction prefix; CoreML matches ONNX
(cosine > 0.995) and its query latency; cold grep is not slowed; after indexing a natural-language grep with no
literal match is answered by the model with the right file first; a file just written is found on the next grep;
`PAPR_CODE_EMBED=0` turns it off and grep still works. Without the model the suite is skipped, not failed.

Paste the `Tests  9 passed (9)` summary (and the `[live] CoreML query latency` line) into the PR.

## 3. By hand in Papr dev

1. `npm run build && npm run dev`, sign in, open any mini-app.
2. First grep in a session downloads the model in the background (watch `data/models/papr-embed-code-1-0.6b/`
   under the workspace) and the gateway log prints `[codeEmbed] tier=local (...)`.
3. Ask the agent to search the app in words, e.g. *"grep this app for where we handle failed uploads"*. The bash
   result shows `=== Semantic code search (papr-embed-code, Neural Engine) ===` (or `on device`) with
   `file:lines (score)` above `=== Grep Results ===`, even when grep itself matches nothing.
4. Edit a file, grep again in words: the edited file shows up by its new content.
5. `PAPR_CODE_EMBED=0 npm run dev` turns it off; grep behaves exactly as before.

Switches: `PAPR_CODE_EMBED=0` off · `PAPR_CODE_EMBED_COREML=0` ONNX only · `PAPR_CODE_EMBED_DOWNLOAD=0` never
download · `PAPR_CODE_EMBED_CLOUD_SYNC=0` never upload vectors.
