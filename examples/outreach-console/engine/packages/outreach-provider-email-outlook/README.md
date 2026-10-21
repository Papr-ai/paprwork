# @splitin/outreach-provider-email-outlook

Outlook adapter for the outreach engine. It sends as the connected Exchange Online (Microsoft 365) mailbox through Microsoft Graph. Decision D1 in [BUILD_PLAN.md §19](../../BUILD_PLAN.md) explains why the engine uses mailbox adapters.

## How it behaves

| Concern | Behaviour |
| --- | --- |
| Send | Draft first, then send. The message is created from the shared MIME builder (`POST /me/messages` with base64 MIME), because Graph's `internetMessageHeaders` only accepts `X-` headers and `List-Unsubscribe` would otherwise be lost. Then `POST /me/messages/{id}/send`. |
| Outcome unknown | Creating a draft never sends anything, so every failure before the send call is a transient rejection. Only the send call can be `unknown`: a timeout, a reset or a 5xx. A refused send discards its draft. An unknown one keeps it until reconciliation decides. |
| Reconcile | 1. Sent Items filtered by our Message-ID. 2. A walk of Sent Items, newest first, that matches the `X-Outreach-Key` header, because Exchange may replace the Message-ID. The adapter answers `absent` only after that walk and after `settleMs` (default 3 min). It then deletes the orphaned draft so nobody sends it by hand later. |
| Ids | The provider message id is the `internetMessageId`. Exchange gives the Sent Items copy a new item id, so the Graph item id is not stable across the send. |
| Inbound | The Inbox is polled by `receivedDateTime`, with a 2-minute overlap for late indexing. Events are deduplicated by id. The first poll starts from now. |
| Bounces | Exchange NDRs (`postmaster@`, `MicrosoftExchange…@`, `Undeliverable:`) are read as raw MIME (`/$value`), and their delivery-status part gives status, recipient and original Message-ID. Without that part the bounce goes to review. |
| Tokens | Microsoft rotates refresh tokens on every use. The adapter writes the new one back through the secret store (`file:` secrets support this), so the grant doesn't lapse after about 90 days. With `env:` secrets it cannot write back. |
| Health | `ok` only if the connected mailbox (`mail` or `userPrincipalName`) is the account's sender address. A revoked grant reports `reauth_required`. |
| Errors | 429, `ApplicationThrottled` and quota codes map to `rate_limited`, with Retry-After or 1 h for quotas. `ErrorMessageSubmissionBlocked` maps to `policy_blocked`. Other 403s map to `forbidden`. `ErrorInvalidRecipients` maps to `invalid_recipient`. |

Only the Inbox is read, so replies that Exchange files as junk are not seen.

## Purposes

The adapter defaults to `manual_correspondence`. Declare `automated_outreach` after reviewing Microsoft's terms for your tenant:

```js
// outreach.config.mjs
import { outlookAdapter } from '@splitin/outreach-provider-email-outlook';

export default { adapters: [outlookAdapter({ purposes: ['manual_correspondence', 'automated_outreach'] })] };
```

## Setup (Microsoft Entra ID)

1. **Register an app.** Choose "Accounts in this organizational directory only" and the platform **Mobile and desktop applications**, with redirect URI `http://localhost`. No client secret is needed; this is a public client and uses PKCE.
2. **Add delegated Microsoft Graph permissions:** `Mail.Send`, `Mail.ReadWrite`, `User.Read` and `offline_access`. `Mail.ReadWrite` is required because sending starts from a draft. Grant admin consent if your tenant requires it.
3. **Connect the mailbox you will send from.** The grant is written to an owner-only (0600) file, and rotated tokens are saved back to it:
   ```zsh
   outreach account connect outlook --tenant <tenant-id-or-domain> --client-id <application-id> \
     --login-hint sam@contoso.com
   ```
4. **Register the account** with the printed `secretRef`:
   ```zsh
   outreach account add --provider outlook --external-id sam@contoso.com --sender-email sam@contoso.com \
     --sender-name "Sam" --postal "1 Example St, City" --purposes automated_outreach \
     --secret file:~/.config/outreach/outlook-sam@contoso.com.json
   ```

Exchange Online allows 10,000 recipients a day and 30 messages a minute per mailbox, and Microsoft is tightening external-recipient limits. Deliverability limits you first: keep `accountPerDay` at 30–50 for cold outreach, from a secondary warmed-up domain.

## Testing

`FakeGraphServer` in `@splitin/outreach-fakes` speaks the parts of Graph and the Microsoft identity platform this adapter uses, over real HTTP. It supports drafts, send moving the message to Sent Items under a new id, OData filters and paging, raw MIME, authorization-code and refresh grants with rotation, and forced send outcomes. The adapter passes the email conformance kit against it. `outreach-e2e/src/outlook.e2e.test.ts` covers the engine end to end: a lost send, a reply, an NDR and token rotation.
