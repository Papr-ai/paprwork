# Optional local maintenance

Both features default off. No retention period is a legal recommendation. The
operator must choose the applicable period, review exclusions, and explicitly
approve every destructive batch. These commands are not exposed to MCP or HTTP.
No real contacts or live accounts are required for the synthetic test suite.

## Backup

See [runbook](runbook.md#backup-and-restore). Configure an absolute private local
directory and explicit cadence. `worker --backup-dir /private/backups
--backup-every-hours 24` checks once per pass and creates a snapshot when due.
`backup` accepts the same flags for a one-shot. `--dry-run` does not create a
snapshot or destination files. The current database is still opened normally.
Worker downtime delays backups; it is not a system cron installation.

Atomic SQLite claim ownership is released when a process dies. A crash before
verified completion never counts as a successful backup. Unrecorded snapshots
and failed outputs remain on disk. Snapshots cover the whole database, including other workspaces, not only the CLI
workspace. Only an operator authorized for the entire database should configure
backups. Outputs contain all database PII, including
immutable audit history; no automatic rotation, deletion, or encryption is
provided. File permissions do not replace disk encryption or access policy.

Restore only to a new private path with every worker/control surface stopped and
send gates closed. Preserve the current DB and WAL; verify integrity, migrations,
audit chain, provider outcomes, and all opt-outs created since the snapshot.
Only resume after reconciliation. Restoring an older DB may resurrect PII and
forget successful sends and opt-outs. Never copy just a live WAL database's main
file. Practice on synthetic data before production.

## Explicit retention batches

1. Run `retention preview --days <operator-selected-days> --limit 100 --json`.
2. Inspect contact IDs, counts, cutoff, exclusions and exact operation hash.
3. If approved, run `retention commit <preview-id> --confirm-hash <hash>
   --acknowledge-exclusions` within 15 minutes, as the same workspace admin.
4. For another page, use the previous `nextAfterId` as `--after`. At most 1,000
   contacts are scanned and 100 selected per preview. An empty page can still
   have a cursor; finish when scanning returns zero. Each page needs new approval.

Preview records an audit event and opaque approval envelope, not a PII snapshot.
Commit re-reads current admin membership and all selected data transactionally;
any changed content/eligibility/hash, role revocation, expiry, or replay fails
closed. Failures roll back scrubbing and preserve the original suppression.
There is no automatic destructive schedule or model-controlled confirmation.

Only old opted-out contacts with every email globally suppressed qualify.
Merged contacts, recent imports/work, active or paused enrollments, open tasks,
and pending/uncertain/nonterminal actions are excluded. Any unresolved provider
event in the workspace blocks selection, since later correlation may link it to
a contact. Address comparisons use the same normalizer as suppression. This
conservative maintenance scan indexes workspace action/message history once per
preview and refuses histories above 10,000 rows per action/message/event table.
Large histories need separately reviewed offline tooling; the cap is a fail-closed
operational bound, not permission to delete history to make pruning work. Terminal
linked contact profiles, points, import rows, message address/subject fields,
action payloads/error details/receipts, event payloads, and manual-task text are
redacted. Relational IDs and terminal execution history remain for safety.
Historical payload hashes remain commitments to pre-pruning content, not hashes
of the redacted payload. Pruned terminal actions must not be retried.

A separate `suppression_fingerprints` table stores `sha256-email-v1` digests of
existing normalized email semantics. It is checked alongside legacy plaintext
suppressions. Reimporting the same address stays suppressed, across capitalization
and supported `mailto:` normalization; it does not create consent to recontact.
Fingerprint data is workspace scoped and deliberately has no expiry/removal
command. These unsalted deterministic hashes are pseudonymous personal data,
subject to dictionary guessing, not anonymization or proof of GDPR erasure.

This is partial minimization, not “keep only the hash” or full deletion. Immutable
audit history, shared approval/prepared previews, operational identifiers and
rate-limit/reservation metadata, unlinked or free-text copies, non-opt-out
suppression records, external exports, provider mailboxes and previous backups
remain. They may contain personal data. Their lifecycle needs separate explicit
policy and tooling; audit history is never edited by this feature. Previously
exported data and old backups are not retroactively scrubbed. Do not claim a
legal erasure request fulfilled solely from a successful retention command.

Updates perform logical redaction only. SQLite free pages, WAL files and storage
media may retain old bytes. This feature does not promise physical secure erasure;
any separate compaction/media lifecycle needs its own approved operational plan.

Backups require the original handle returned by `openSqliteDatabase`, with verified
open-time file identity. Adapted `fromBetterSqlite3` and arbitrary wrapped handles
are rejected rather than trusting an unverifiable pathname. File replacement
after opening fails closed. Protect the source directory from concurrent hostile
mutation; this is not a defense against a malicious same-user filesystem actor.

## Upgrade and rollback compatibility

Migration 0004 adds typed suppression fingerprints and retention envelopes without
rewriting earlier migration checksums. All send/import workers must run a version
that checks `suppression_fingerprints` before any retention is committed. Do not
run old engine binaries concurrently or downgrade after pruning: older code only
knows plaintext suppression and could recontact an opted-out address on reimport.
Stop all processes for the upgrade, verify their versions, then enable maintenance.
Reconcile suppression state before any database rollback; there is no safe
automatic down-migration of pseudonymous fingerprints back to plaintext addresses.

Later mail or provider re-sync can introduce new personal data. A previously
minimized contact becomes eligible for another explicitly approved batch when
new linked records age past the selected window, all operational safety checks
still pass, and the prior pruning marker is old enough. Its original suppression
fingerprints stay unchanged. No automatic destructive job runs; operators must
repeat previews and confirmations. Unlinked copies still cannot be attributed
reliably and remain outside this tool's scope.
