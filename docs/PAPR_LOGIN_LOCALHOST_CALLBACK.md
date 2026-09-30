# Papr Login — Localhost OAuth Callback (v2.2.3)

Desktop Papr login now uses a **localhost redirect** instead of relying only on the `papr://` deep link. After Auth0 completes, users see a branded success page in the browser and return to Papr Work automatically.

## Flow

1. User clicks **Sign In** (Auth wall or Settings → Profile).
2. Electron starts a local callback server on `http://127.0.0.1:18791/auth/callback`.
3. Auth0 authorize URL uses that redirect URI (PKCE + state).
4. Browser completes login → Auth0 redirects to localhost.
5. Callback server shows a branded HTML success page and forwards the code to the main process.
6. Main process exchanges the code, provisions API keys, switches gateway workspace, and notifies the UI.

**Fallback:** If localhost callback is unavailable, set `PAPR_AUTH_USE_DEEPLINK=true` to use the legacy `papr://auth/callback` deep link.

## Auth0 Dashboard Setup

In your Auth0 application, add to **Allowed Callback URLs**:

```
http://127.0.0.1:18791/auth/callback
```

Optional legacy fallback:

```
papr://auth/callback
```

Optional logout (only if you want browser session cleared on logout):

```
https://papr.ai/logged-out
```

Set `AUTH0_LOGOUT_RETURN_TO` in `.env.local` when using browser logout.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUTH0_DOMAIN` | `papr.auth0.com` | Auth0 tenant |
| `AUTH0_CLIENT_ID` | (production client) | Desktop OAuth client |
| `PAPR_AUTH_USE_DEEPLINK` | `false` | Force legacy deep-link flow |
| `AUTH0_LOGOUT_RETURN_TO` | (unset) | Browser logout redirect URL |

See `.env.example` for full list.

## Login Funnel Telemetry

Each step emits `paprwork_papr_login_step` to Amplitude (when telemetry is enabled) and logs `[PaprLogin] funnel → {step}` to the console.

Steps include: `auth_wall_viewed`, `browser_opened`, `callback_received`, `token_exchanged`, `api_key_provisioned`, `gateway_switch_attempted`, `login_success_notified`, etc.

Use these events to build funnel charts and diagnose drop-off (e.g. callback never received, gateway switch failed).

## Commercial Builds

Test the auth wall locally:

```bash
npm run dev:commercial    # VITE_REQUIRE_PAPR_AUTH=true in dev
npm run start:commercial  # production build with auth wall
```

## Related Files

- `src/electron/ipc/paprAuthCallbackServer.ts` — localhost server + success HTML
- `src/electron/ipc/paprLogin.ts` — PKCE flow, token exchange, provisioning
- `src/core/telemetry/paprLoginSteps.ts` — funnel step definitions
- `ui/components/Auth/AuthWall.tsx` — auth wall UI + step tracking
- `tests/papr-login-funnel.test.ts` — funnel step unit tests
