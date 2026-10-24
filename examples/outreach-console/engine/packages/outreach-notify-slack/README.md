# @splitin/outreach-notify-slack

This adapter posts the engine's notifications to Slack: replies, opt-outs, bounces, complaints and account-health changes. It implements only the `notify` port, so it never sends email. Notifications carry identifiers and routing only, never message bodies.

## Modes

The account's secret decides how the adapter posts:

| Secret | Posts with | Destination |
| --- | --- | --- |
| `https://hooks.slack.com/services/...` (incoming webhook) | the webhook | that webhook's fixed channel |
| `xoxb-...` (bot token with `chat:write`) | `chat.postMessage` | the channel id in the account's `--external-id` (invite the bot first) |

```js
// outreach.config.mjs
import { slackNotifier } from '@splitin/outreach-notify-slack';
export default { adapters: [/* email adapters */, slackNotifier()] };
```

```zsh
export SLACK_WEBHOOK='https://hooks.slack.com/services/...'
outreach account add --provider slack --external-id '#gtm' --sender-name Outreach --sender-email ops@yourdomain.com \
  --purposes transactional --secret env:SLACK_WEBHOOK
outreach notify set <that-account-id>
```

## Behaviour

- **Escaping:** all content is escaped for Slack markup (`&`, `<`, `>`). An engine value can never ping `<!channel>` or render as a link. Link buttons appear only for `https://` URLs.
- **Outcomes:** a refused connection is a transient rejection and is retried. A dropped connection or a 5xx is `unknown`, and per ADR 0002 an unknown notification is never retried. HTTP 429 and `ratelimited` map to `rate_limited`. `invalid_auth` and `token_revoked` map to `auth_revoked`. `channel_not_found`, `not_in_channel` and `is_archived` map to `forbidden`.
- **Health:** bot tokens are checked with `auth.test`. An incoming webhook cannot be checked without posting, so it reports `ok` with a note saying so.

Slack control (approve and pause buttons, `/outreach`) is a separate app in `slack-agent-hq` (BUILD_PLAN.md §11.4).
