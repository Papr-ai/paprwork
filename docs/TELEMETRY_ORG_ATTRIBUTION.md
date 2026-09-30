# Telemetry: per-customer (org) attribution

How to count real customer traction in Amplitude, and what the events guarantee.

## Why this exists

Desktop events without `organization_id` cannot be joined to a customer. We could
see that an agency's published app got N visitors, but not how many apps that
agency built, whether they came back, or whether anything kept running.

Per-customer attribution shipped in `6e53a4d8` (v2.5.6, 2026-08-26). Events
before that date resolve to `organization_id = (none)` and are not usable for
customer-level analysis. Attribution coverage is a function of client version
adoption — as of 2026-09-21, ~66% of `paprwork_job_completed` carried an org.
**Org-level numbers are therefore an undercount, not an overcount.**

## Envelope properties

`mergeTelemetryEnvelope` injects these on every event from both the gateway and
Electron main:

| Property | Source | Notes |
|---|---|---|
| `organization_id` | active workspace pointer | opaque id, e.g. `Y8D4H7Yp3Z` |
| `organization_name` | active workspace pointer | human-readable, for reports |
| `namespace_id` | active workspace pointer | workspace within the org |
| `papr_account_id` | Papr profile | Parse objectId, not an email |
| `product` / `edition` / `is_oss` / `is_packaged` | build | dev builds are `paprwork-dev` |

Empty values are omitted rather than sent as `""`, so logged-out and
pre-workspace installs do not create a fake bucket.

These are **workspace identifiers, not user identifiers** — no PII.
`sanitizeTelemetryProperties` is a blocklist; do not add any key that could
carry an email, token, or free-text body.

### Read the pointer per event, never cache it

Users switch workspace without restarting the app or the gateway. Every getter
(`getOrganizationId`, `getNamespaceId`, `getOrganizationName`) must resolve at
call time so events follow the active workspace.

## `creation_source` on `paprwork_app_created`

Raw app-creation counts are meaningless without this dimension: a single agent
session can create apps in bulk.

| Value | Meaning |
|---|---|
| `user` | a person authored it in the UI (`app:create` over websocket) |
| `agent` | the `create_app` agent tool |
| `install` | forked/tracked from the Papr Cloud catalog |
| `template` | scaffolded by `TemplateService` |

Callers declare their origin explicitly via
`createApp(..., { creationSource })`. It was previously inferred from
`createdByAgentId`, which is only set for **sub-agent** runs — so every
main-agent `create_app` call was mislabelled `user`. Data before 2026-09-21 is
affected: the `agent` bucket never fired, and `user` is inflated.

**Only `creation_source = "user"` counts as human builder activity.**

## Metric definitions

Prefer definitions that are reproducible from one query. If a number cannot be
regenerated on demand, do not put it in a deck.

### Apps live and running real work

> distinct `app_id` on `paprwork_job_completed` in the period

A completed job is an exit code, not a folder. This is strictly better than
counting repos or rows in `apps.json`, both of which include provisioned-but-
empty and test artifacts.

### Customer organizations running unattended automation

> distinct `organization_id` on `paprwork_job_completed`
> where `trigger = scheduled`, excluding internal orgs

`trigger = scheduled` means no human was present: someone configured automation
once and it kept firing. Always exclude internal orgs (`Y8D4H7Yp3Z` and any
staff second org) — internal volume dominates and including it destroys the
credibility of the number.

### Durable automation (the hard one)

> organizations with `paprwork_job_completed`, `trigger = scheduled`,
> on **>= 7 distinct days** within a calendar month, excluding internal orgs

"Still running a week later, without being touched." This is the strongest early
signal of retained value and the hardest to fake: it cannot be produced by a
burst, a demo, or a launch spike.

Amplitude does not expose distinct-active-days directly. Compute it from a daily
segmentation:

```
GET /api/2/events/segmentation
  e = {
    "event_type": "paprwork_job_completed",
    "filters": [{
      "subprop_type": "event", "subprop_key": "trigger",
      "subprop_op": "is", "subprop_value": ["scheduled"]
    }],
    "group_by": [{ "type": "event", "value": "organization_id" }]
  }
  start=YYYYMMDD  end=YYYYMMDD  m=totals  i=1
```

Then, per series, count buckets with a non-zero value and keep orgs with
`>= 7`. Apply the internal-org exclusion after grouping, never before.

### Do not report

- **App counts without `creation_source = "user"`** — inflated by agent output.
- **MoM growth on any org-scoped metric before October 2026** — August is
  almost entirely `(none)`, so any August→September comparison measures
  telemetry rollout, not customer behaviour.
- **`pushed_at` on app repos as activity** — a bulk sync backfills it.

## Adding a new event

1. Emit through `getGatewayTelemetry()` (gateway) or `telemetryClientInstance`
   (Electron main). Both wire the full envelope; a bare `fetch` will not.
2. If the event can be triggered by automation, add a dimension that separates
   human from machine — as `creation_source` does for apps and `trigger` does
   for jobs. Without it the metric will be unusable later.
3. Add a test in `tests/telemetry.test.ts` asserting the properties survive
   `sanitizeTelemetryProperties`.
