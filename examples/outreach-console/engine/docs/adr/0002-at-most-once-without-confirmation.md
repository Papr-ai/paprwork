# ADR 0002 — At most once without confirmation

- Status: Accepted
- Date: 2026-09-28

## Context

The original plan deduplicated sends by inserting an event key "before any external side
effect" and skipping on conflict. That loses sends when a process dies between the
insert and the provider call, and duplicates them when the call succeeds but the process
dies before recording the receipt, or when a timeout hides an accepted send. Most email
and notification providers cannot guarantee exactly-once delivery, and many do not
honour client idempotency keys.

## Decision

The engine guarantees that an action is executed **at most once unless the provider
confirms it was not executed**.

- An action moves `scheduled → claimed` under a lease. A crash while `claimed` returns it
  to `scheduled`; no attempt was started, so this is safe.
- Before the provider call, one committed transaction re-checks every precondition and
  moves the action to `executing` with an `action_attempts(pending)` row.
- A provider result of accepted, rejected-retryable or rejected-permanent is recorded in
  a second transaction.
- A timeout or connection loss after the request may have left the process, or an
  expired lease while `executing`, moves the action to `uncertain`. It is never retried
  automatically.
- The reconciler asks the provider (by our generated `Message-ID`, then idempotency key,
  then recipient and time window). `found` means succeeded; `absent` means it may be
  rescheduled; repeated `still_unknown` sends it to a human review queue.
- Adapters must return `absent` only when the provider can affirm it. The conformance kit
  enforces this.
- Transitions live in one table in `@splitin/outreach-contracts`; the store rejects any
  transition not in it. A property test asserts that no path reaches a second provider
  call without an intervening `absent` or `rejected`.

## Consequences

- We never claim exactly-once delivery.
- Some legitimate sends wait in review when a provider cannot be queried. That is the
  price of never double-contacting a person, and it is visible in the UI.
- The only race we cannot close is a reply that arrives while a send is already in
  flight; it is bounded by one provider call and documented in the runbook.
