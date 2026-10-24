import { appendAudit, sha256Hex, ulid, type InboundMailEvent, type SqlDatabase } from '@splitin/outreach-contracts';
import { loadAccount } from '../execution/actions-repo';
import { providerContext } from '../execution/invoke';
import type { DomainEnv } from '../domain/env';

const MAX_WEBHOOK_BYTES = 1_000_000;
const SNIPPET_MAX = 500;

/** Stores events once each; webhook retries and poll overlap collapse on (account, provider event id). */
export function storeInboundEvents(db: SqlDatabase, workspaceId: string, accountId: string, events: readonly InboundMailEvent[], now: number): { stored: number; duplicates: number } {
  let stored = 0;
  const insert = db.prepare(
    `INSERT INTO provider_events (id, workspace_id, provider_account_id, provider_event_id, kind, payload, payload_digest, status, received_at)
     VALUES (?,?,?,?,?,?,?,'pending',?) ON CONFLICT (provider_account_id, provider_event_id) DO NOTHING`,
  );
  for (const event of events) {
    // Minimize what we keep: identifiers, headers and a bounded snippet; never full bodies.
    const minimized: InboundMailEvent = { ...event, ...(event.snippet ? { snippet: event.snippet.slice(0, SNIPPET_MAX) } : {}) };
    const payload = JSON.stringify(minimized);
    stored += insert.run(ulid(now), workspaceId, accountId, event.eventId, event.kind, payload, sha256Hex(payload), event.receivedAt || now).changes;
  }
  return { stored, duplicates: events.length - stored };
}

export type WebhookResult = { accepted: true; stored: number; duplicates: number } | { accepted: false; reason: string };

/**
 * Webhook ingress (BUILD_PLAN.md §8.1): size cap, then signature verification over the RAW body before
 * anything is parsed, then durable storage. Processing happens later, so the endpoint answers fast.
 */
export async function ingestWebhook(
  env: DomainEnv,
  input: { providerAccountId: string; rawBody: Uint8Array; headers: Readonly<Record<string, string>> },
): Promise<WebhookResult> {
  if (input.rawBody.byteLength > MAX_WEBHOOK_BYTES) return { accepted: false, reason: 'too_large' };
  const account = loadAccount(env.db, input.providerAccountId);
  const adapter = account ? env.adapters.get(account.provider) : undefined;
  if (!account || !adapter?.webhook || !account.webhook_secret_ref) return { accepted: false, reason: 'not_configured' };
  const secret = await env.exec.secrets.get(account.webhook_secret_ref);
  const headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
  const verified = await adapter.webhook.verify(input.rawBody, headers, secret, env.now());
  if (verified === 'reject') {
    env.db.transaction(() =>
      appendAudit(env.db, { workspaceId: account.workspace_id, at: env.now(), actorKind: 'provider', actorId: account.provider, source: 'webhook', traceId: ulid(), resourceKind: 'provider_account', resourceId: account.id, action: 'webhook_rejected', detail: {} }),
    );
    return { accepted: false, reason: 'verification_failed' };
  }
  return env.db.transaction(() => ({ accepted: true as const, ...storeInboundEvents(env.db, account.workspace_id, account.id, verified, env.now()) }));
}

/** Polling fallback: fetch changes since the durable cursor. Runs alongside webhooks to fill gaps. */
export async function pollMailbox(env: DomainEnv, providerAccountId: string): Promise<{ stored: number; duplicates: number }> {
  const account = loadAccount(env.db, providerAccountId);
  const adapter = account ? env.adapters.get(account.provider) : undefined;
  if (!account || !adapter?.mailbox) return { stored: 0, duplicates: 0 };
  const cursor = env.db.prepare('SELECT cursor FROM provider_cursors WHERE provider_account_id = ?').get<{ cursor: string | null }>(account.id);
  const result = await adapter.mailbox.readChanges(providerContext(env.exec, account, ulid(), AbortSignal.timeout(30_000)), cursor?.cursor ?? null);
  return env.db.transaction(() => {
    const now = env.now();
    const counts = storeInboundEvents(env.db, account.workspace_id, account.id, result.events, now);
    env.db.prepare(
      `INSERT INTO provider_cursors (provider_account_id, cursor, updated_at) VALUES (?,?,?)
       ON CONFLICT (provider_account_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).run(account.id, result.nextCursor, now);
    return counts;
  });
}

/** Polls every account whose adapter can read a mailbox and whose last poll is older than `intervalMs`. */
export async function pollDueMailboxes(env: DomainEnv, intervalMs: number): Promise<number> {
  const now = env.now();
  const accounts = env.db
    .prepare(
      `SELECT a.id, a.provider FROM provider_accounts a LEFT JOIN provider_cursors c ON c.provider_account_id = a.id
       WHERE a.health IN ('ok','degraded') AND (c.updated_at IS NULL OR c.updated_at <= ?)`,
    )
    .all<{ id: string; provider: string }>(now - intervalMs);
  let stored = 0;
  for (const account of accounts) {
    if (!env.adapters.get(account.provider)?.mailbox) continue;
    try {
      stored += (await pollMailbox(env, account.id)).stored;
    } catch {
      // A failing mailbox must not stop sends or other accounts; the next pass retries.
    }
  }
  return stored;
}
