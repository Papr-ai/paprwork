# Ad-hoc / manual test scripts

One-off debugging scripts moved from the repo root. **Not part of CI or `npm run test:sequential`.**

These are kept for reproducing specific bugs (PAPR sync, message history, SDK queries). Run individually when debugging.

## Scripts

| File | Purpose | Requires |
|------|---------|----------|
| `test-papr-query.mjs` | Query session history with varying limits | `PAPR_API_KEY`, `PAPR_TEST_CHAT_ID` |
| `test-papr-messages.mjs` | Papr message retrieval debug | `PAPR_API_KEY` |
| `test-papr-assistant-messages.mjs` | Assistant message sync debug | `PAPR_API_KEY` |
| `test-message-sync.mjs` | Reproduce failed PAPR message sync | `PAPR_API_KEY`, `/tmp/test-message-content.txt` |
| `test-find-message.mjs` | Find messages by PAPR IDs | `PAPR_API_KEY` |
| `test-full-summary.mjs` | Summary retrieval debug | `PAPR_API_KEY` |
| `test-detailed-messages.mjs` | Detailed message dump | `PAPR_API_KEY` |
| `test-check-summary.mjs` | Summary check | `PAPR_API_KEY` |
| `test-parse-direct.mjs` | Direct parse test | env vars |
| `test-sdk-detailed.mjs` | SDK detailed test | `PAPR_API_KEY` |
| `test-context-management.ts` | Adaptive truncation / graceful errors | `node --import tsx tests/manual/test-context-management.ts` |
| `test-python-sdk.py` | Python SDK smoke | Python + API key |
| `test_loop.py` | Python loop test | Python |
| `test-electron-cjs.cjs` | Electron require probe | Electron |
| `test-chat-integration.html` | Browser chat integration | Manual browser |
| `test-zombie-fix.mjs` | Zombie process fix verification | Manual |

## Example

```bash
# From repo root
node tests/manual/test-papr-query.mjs
node --import tsx tests/manual/test-context-management.ts
```

Auth resolution uses `scripts/lib/testEnv.mjs` (same as E2E scripts).
