# Claude onboarding — test before release

Use this checklist in **dev** (`npm start`) before cutting a Mac/Windows release. PKG auto-launch is covered in `docs/AUTO_LAUNCH_POST_INSTALL.md`.

---

## Automated (no Anthropic sign-in)

From repo root with Node 24:

```bash
nvm use 24
npm run test:claude-cli-on-demand
npx vitest run tests/claude-setup-token-cli-provider.test.ts --project unit-backend
```

**Expect:**

- CLI downloads via HTTPS (no npm).
- `getSetupTokenShellCommand` does **not** contain `npm`.
- When `claude` is **not** on PATH, command includes `node` + path to cached `cli.js`.
- Launcher script test passes (contains `setup-token` + cli path).

Optional — confirm global `claude` is not on PATH for a realistic run:

```bash
which claude || echo "OK: no global claude (cached-CLI path will be used)"
```

---

## Manual — full onboarding (Settings or Connect AI)

**Setup:** Disconnect Claude in Settings → AI Models if already connected. For a clean PATH test, use a Mac user or shell where `which claude` fails (or temporarily rename `/usr/local/bin/claude` only on a test machine).

| Step | Action | Pass criteria |
|------|--------|----------------|
| 0 Check | Run check | If only Papr cache exists: **does not** skip install; message mentions downloaded copy. If `claude` on PATH: install skipped. |
| 1 Install | Install for me | Succeeds; message says PATH optional when using Papr copy. |
| 2 Sign in | Open Terminal and run it | **Terminal opens and comes to front**; script runs (see banner “Papr Work — Claude sign-in”). Browser OAuth if needed. UI stays on step 2 until **“I finished sign-in — paste token”**. |
| 3 Paste | Read instructions | Copy mentions finding the **Terminal** window (Dock / ⌘Tab). Example box matches `sk-ant-oat01-`. |
| 3 Paste | Paste token | Verify succeeds → Connected. |
| 3 Paste | Auto-detect | “Connect automatically” works after CLI writes credentials (optional). |

**Failure signals:**

- Jump straight to paste without Terminal → regression on step 2 flow.
- Step 0 says “already installed — skipped” but `claude setup-token` fails in Terminal → PATH vs cache bug.
- “Could not open Terminal” → check macOS Automation permissions for Papr Work / Electron.

---

## Manual — Settings “Guided setup”

Same stepper from **Settings → AI Models → Claude → Guided setup**. Confirm identical behavior to onboarding.

---

## PKG conclusion (release build only)

After `npm run dist:mac` (or CI artifact):

1. Install PKG on a test Mac (or VM).
2. On last screen: **Open Papr Work** link visible; **Close** triggers auto-launch when possible.
3. If app does not open: link opens `/Applications/Papr Work.app`.
4. Check `/var/log/paprwork-postinstall.log` for launch attempts.

---

## Sign-off

- [ ] Automated tests green
- [ ] Manual table completed on macOS (cached CLI + Terminal path)
- [ ] Optional: manual on Windows (PowerShell sign-in)
- [ ] PKG tested on clean install (release candidate only)
