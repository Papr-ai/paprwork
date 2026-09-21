# Connectors & plugins (planned)

**Status:** Not shipped. Desktop-local Google OAuth was removed (2026-09) in favor of a ChatGPT-style model later.

## Target UX

- A **Plugins** (or **Connectors**) area in Settings — browse/install Gmail, Google Drive, Calendar, GitHub, Slack, etc.
- User clicks **Connect** → browser OAuth on Google/GitHub/etc.
- Tokens stored and refreshed **on Papr infrastructure** (server-mediated OAuth), not baked client secrets in the Electron app.
- Desktop app uses Papr-issued connection handles; scopes and revocation are centralized.

## Why not desktop-local OAuth

- Google **Desktop** clients require a **client secret** at token exchange.
- Shipping that secret in installers is extractable and unlike SaaS connector hubs (e.g. ChatGPT plugins).
- Per-user Google refresh tokens in the local keychain alone do not match the long-term **plugin catalog + cloud sync** story.

## Implementation sketch (future)

1. **Papr platform OAuth broker** — authorize + token exchange on `dashboard.papr.ai` (or dedicated auth service).
2. **Connection records** — per user/workspace; linked from desktop via Papr login session.
3. **Plugins UI** — list installed connectors, connect/disconnect, scope summary.
4. **Agent/tools** — call Papr APIs or proxied Google APIs using stored connections (not raw `${GOOGLE_OAUTH_*}` keys in vault for most users).

## Legacy note

An experimental desktop loopback flow was documented in `docs/GOOGLE_OAUTH_DESKTOP_SETUP.md` (archived). Do not re-enable without revisiting this roadmap.
