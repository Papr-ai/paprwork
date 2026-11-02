# paprwork

`@splitin/paprwork-cli` is a local launcher for the pinned [Papr Work](https://github.com/Papr-ai/paprwork) desktop app.

Pinned commit: b34b6c4090adfb64109004d1a25645a3d3a2bd66

- Branch recorded for the Outreach Console: `development`
- Release baseline: `2.7.2`
- Source: `outreach-engine/apps/papr/compatibility.json`, dated 2026-10-20
- Required Node version: 24 or newer
- Default checkout: `~/Papr/src/paprwork`

Papr Work source remains in its own checkout; this launcher does not vendor it. Papr Work is AGPL-3.0. The launcher is MIT.

## Commands

- `paprwork version`
- `paprwork doctor [--dir <checkout>]`
- `paprwork checkout [--dir <checkout>] [--commit <40-char sha>]`
- `paprwork start [--dir <checkout>] [--print-only]`

`checkout` clones Papr Work and detaches the recorded commit. It does not install dependencies. The person runs `npm install` in the checkout. `start` runs `npm start` after dependencies are installed and opens the Papr Work desktop app. The launcher does not print secrets.

## Test

```bash
npm test
```
