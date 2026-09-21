# Google OAuth desktop experiment (archived)

**This approach is not used in Paprwork.** Desktop-local Google Workspace Connect was removed in favor of a future **Plugins / server-mediated OAuth** model. See `docs/CONNECTORS_PLUGINS_ROADMAP.md`.

The notes below are kept for historical reference only (GCP project, scopes, loopback redirect).

---

## Papr production GCP project (verified)

- **Project:** `gen-lang-client-0873281406`
- **APIs:** Drive, Gmail, Calendar (enabled)
- **OAuth client:** **Papr Work** (Desktop app)

Loopback redirect used in the experiment: `http://127.0.0.1:18792/oauth/google/callback`

## Distinction

- **Auth0 “Sign in with Google”** — Papr account login only; no Drive/Gmail/Calendar API scopes.
- **Gemini** — `GOOGLE_GENERATIVE_AI_API_KEY` in integration keys; unrelated to Workspace connectors.
