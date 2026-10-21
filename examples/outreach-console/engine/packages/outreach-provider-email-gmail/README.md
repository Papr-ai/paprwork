# @splitin/outreach-provider-email-gmail

Gmail adapter for the outreach engine. It sends as the connected mailbox user through the Gmail API. It reconciles sends whose outcome is unknown by checking the Sent folder, and it reads replies and bounces through the History API. Decision D1 in [BUILD_PLAN.md §19](../../BUILD_PLAN.md) explains why the engine uses mailbox adapters.

## How it behaves

| Concern | Behaviour |
| --- | --- |
| Send | `users.messages.send` with a MIME message the adapter builds. Non-ASCII names and subjects are RFC 2047 encoded, and bodies are base64 UTF-8. HTML becomes `multipart/alternative`. Header injection, reserved headers and odd addresses are refused before anything is sent. |
| Outcome unknown | Connection refused or DNS failure means nothing reached Google, so the send is a transient rejection. Timeouts, resets and 5xx responses may have been processed, so they are reported as `unknown` and never retried blindly (ADR 0002). |
| Reconcile | 1. `rfc822msgid:` search. 2. A walk of the Sent label (spam and trash included) that matches the `X-Outreach-Key` header, which does not depend on search indexing. The adapter answers `absent` only after that walk and only once `settleMs` (default 3 min) has passed since the attempt. |
| Threading | Replies carry `threadId`, `In-Reply-To` and `References`. The adapter reports the Message-ID Gmail actually stored, because Gmail may assign its own. If the thread was deleted, Gmail refuses the threaded send and the adapter sends unthreaded. |
| Inbound | History API with a cursor that resumes after the last processed record, `pollBudget` messages per poll. Our own sent mail is skipped. An expired cursor falls back to recent inbox mail, and events are deduplicated by id. |
| Bounces | Status, recipient and original Message-ID come from the `message/delivery-status` part. A bounce without that part is left unclassified, so it goes to the review queue and nobody is suppressed on a guess. |
| Health | `ok` only if the connected mailbox is the account's sender address. A revoked grant reports `reauth_required`. |
| Errors | 429 and quota reasons map to `rate_limited`, with Retry-After or 1 h for daily limits. 401 maps to `auth_expired` and forces a token refresh. `domainPolicy` maps to `policy_blocked`. Other 403s map to `forbidden`. A bad recipient maps to `invalid_recipient`. |

## Purposes

By default the adapter declares `manual_correspondence` only. Declare `automated_outreach` yourself, in `outreach.config.mjs`, after you have reviewed Google's terms for your account type:

```js
// outreach.config.mjs (next to your outreach.db)
import { gmailAdapter } from '@splitin/outreach-provider-email-gmail';

export default {
  adapters: [gmailAdapter({ purposes: ['manual_correspondence', 'automated_outreach'] })],
};
```

A campaign runs only if its purpose is permitted by both the adapter and the account (`outreach account add --purposes`).

## Setup (Google Workspace)

1. **Google Cloud project.** Enable the Gmail API. Set the OAuth consent screen's user type to **Internal**, which keeps it inside your Workspace and needs no Google verification. Scopes: `gmail.send` and `gmail.readonly`.
2. **OAuth client.** Create one of type *Desktop app*, then export its secret so it never appears in shell history or `ps`:
   ```zsh
   export GOOGLE_CLIENT_SECRET='...'
   ```
3. **Connect the mailbox you will send from.** The engine prints a URL. Open it on the same machine, sign in and approve. The grant is written to an owner-only (0600) file:
   ```zsh
   outreach account connect gmail --client-id <id>.apps.googleusercontent.com \
     --client-secret-env GOOGLE_CLIENT_SECRET --login-hint sam@yourdomain.com
   ```
4. **Register the account** with the `secretRef` the previous step printed:
   ```zsh
   outreach account add --provider gmail --external-id sam@yourdomain.com \
     --sender-email sam@yourdomain.com --sender-name "Sam" --postal "1 Example St, City" \
     --purposes automated_outreach --secret file:~/.config/outreach/gmail-sam@yourdomain.com.json
   ```

Use a Workspace mailbox on a secondary, warmed-up domain, not a consumer `@gmail.com` address. Workspace allows 2,000 messages a day per user, but deliverability limits you long before that. Keep the playbook's `accountPerDay` at 30–50 for cold outreach.

## Tokens from elsewhere

The adapter takes access tokens from an `AccessTokenSource`, which is the refresh-token file by default. A host that already holds the Google grant can pass its own source, for example Papr's planned server-side connectors:

```js
gmailAdapter({ tokens: { get: async (ctx) => host.tokenFor(ctx.account.externalAccountId), invalidate: () => {} } });
```

## Testing

`FakeGmailServer` in `@splitin/outreach-fakes` speaks the parts of the Gmail API and Google's OAuth endpoints this adapter uses, over real HTTP. It can drop connections before or after accepting a send, rewrite Message-IDs, lag its search index and expire history cursors. The adapter passes the email conformance kit against it. `outreach-e2e/src/gmail.e2e.test.ts` runs the engine end to end through it.
