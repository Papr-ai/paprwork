# ADR 0005: Zoho Mail does not become an automated sender

- Date: 2026-10-20
- Status: proposed; pending maintainer review
- Supersedes: only the assumption in BUILD_PLAN D1/M8 that a
  `manual_correspondence` label suffices for a scheduled Zoho sender

## Evidence

Zoho Mail's [usage policy](https://www.zoho.com/mail/help/usage-policy.html),
updated 2026-10-13 and reviewed 2026-10-20, excludes promotional, marketing,
bulk and automated email. An API endpoint's existence does not authorize a use
excluded by the service policy. A purpose string cannot turn a scheduled send
into a human action.

## Proposed boundary

Do not implement or advertise a Zoho automated sender. Keep the existing default
fail-closed behavior: there is no registered `zoho` email provider, and a campaign
cannot compile an email step without a permitted adapter and purpose. Do not add
an SMTP or browser fallback, call a manual step completed without a human, or
silently migrate the campaign to another Zoho product.

Normal mailbox reading or human-authored correspondence may be designed separately
with an explicitly scoped contract and current provider-policy review. Such work
must not expose the engine's `EmailSender` for automated campaigns. No OAuth grant,
account connection or message transmission is part of this change.

## Consequences

The original M8 Zoho sender checkbox remains blocked/re-scoped, not completed.
Gmail/Graph adapters and human LinkedIn tasks are unaffected. Slybroadcast is a new
channel contract and remains outside finishing the existing engine plan.
