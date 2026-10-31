import { afterEach, describe, expect, it } from 'vitest';
import { digestCanonical, sha256Hex, ulid } from '@splitin/outreach-contracts';
import { PLAYBOOK, makeDomainEnv, type DomainTestEnv } from './domain.test-util';
import { prepareRetention, commitRetention } from './retention';
import { addSuppression, createUnsubscribeToken, isSuppressed } from './suppressions';
import { enqueueAction } from '../execution/enqueue';
import { actorOf } from './auth';

import { decideApproval, listApprovals } from './approvals';
import { createCampaign, prepareActivation, commitActivation } from './campaigns';
import { handleUnsubscribe } from '../inbound/unsubscribe';
import type { FakeDelivery } from '@splitin/outreach-fakes';

const open: DomainTestEnv[] = [];
afterEach(() => { for (const env of open.splice(0)) env.engine.db.close(); });
async function fixture() {
  const env = await makeDomainEnv(); open.push(env);
  const id = env.contact('person@example.org');
  addSuppression(env.engine.db, { workspaceId: 'ws', scope: 'global', value: 'person@example.org', reason: 'opt_out', source: 'synthetic-test' }, env.now());
  env.advance(40 * 86_400_000);
  return { env, id };
}
function action(env: DomainTestEnv) {
  return enqueueAction(env.engine.db, {
    workspaceId: 'ws', kind: 'email.send', providerAccountId: env.accountId, purpose: 'automated_outreach',
    recipient: 'person@example.org', idempotencyKey: `test:${env.now()}`, dueAt: env.now() - 1000,
    payload: { from: { address: 'sender@example.com' }, to: [{ address: 'person@example.org' }], subject: 'Synthetic', text: 'test', headers: {} },
  }, actorOf(env.admin), env.now()).action.id;
}
describe('explicit contact retention', () => {
  it('previews without pruning; commits once and preserves normalized suppression after reimport', async () => {
    const { env, id } = await fixture(); const db = env.engine.db;
    const preview = prepareRetention(env.engine, env.admin, { days: 30 });
    expect(preview.contactIds).toEqual([id]);
    expect(db.prepare('SELECT full_name FROM contacts WHERE id = ?').get<{ full_name: string }>(id)?.full_name).toBe('Ada Lovelace');
    expect(commitRetention(env.engine, env.admin, preview.id, preview.operationHash)).toEqual({ contacts: 1 });
    expect(db.prepare('SELECT full_name FROM contacts WHERE id = ?').get<{ full_name: string }>(id)?.full_name).toBe('[pruned]');
    expect(db.prepare('SELECT * FROM suppressions').all()).toHaveLength(0);
    expect(db.prepare('SELECT scheme, digest FROM suppression_fingerprints').get()).toEqual({ scheme: 'sha256-email-v1', digest: sha256Hex('person@example.org') });
    expect(isSuppressed(db, 'ws', ' mailto:PERSON@example.org ', null)).toBe('global:opt_out');
    expect(isSuppressed(db, 'other', 'person@example.org', null)).toBeNull();
    const reimported = env.contact('person@example.org'); expect(reimported).not.toBe(id);
    const a = action(env); await env.engine.runOnce();
    expect(db.prepare('SELECT state FROM scheduled_actions WHERE id = ?').get<{ state: string }>(a)?.state).toBe('cancelled');
    expect(env.fake.deliveries).toHaveLength(0);
    expect(() => commitRetention(env.engine, env.admin, preview.id, preview.operationHash)).toThrow(/consumed/);
  });
  it('requires explicit valid windows and current admin role, caller and workspace', async () => {
    const { env } = await fixture();
    expect(() => prepareRetention(env.engine, env.admin, { days: 0 })).toThrow(/days/);
    expect(() => prepareRetention(env.engine, env.operator, { days: 30 })).toThrow(/admin/);
    const p = prepareRetention(env.engine, env.admin, { days: 30 });
    expect(() => commitRetention(env.engine, { ...env.admin, workspaceId: 'other' }, p.id, p.operationHash)).toThrow();
    expect(() => commitRetention(env.engine, { ...env.admin, principalId: env.operator.principalId }, p.id, p.operationHash)).toThrow();
    env.engine.db.prepare('UPDATE principals SET roles = ? WHERE id = ?').run('["viewer"]', env.admin.principalId);
    expect(() => commitRetention(env.engine, env.admin, p.id, p.operationHash)).toThrow(/admin/);
  });
  it('rejects changed content, tampered policy, wrong hash and expired previews', async () => {
    const { env, id } = await fixture();
    const p = prepareRetention(env.engine, env.admin, { days: 30 });
    expect(() => commitRetention(env.engine, env.admin, p.id, '0'.repeat(64))).toThrow(/changed/);
    env.engine.db.prepare('UPDATE contacts SET first_name = ? WHERE id = ?').run('Changed', id);
    expect(() => commitRetention(env.engine, env.admin, p.id, p.operationHash)).toThrow(/changed/);
    const q = prepareRetention(env.engine, env.admin, { days: 30 });
    env.engine.db.prepare('UPDATE retention_previews SET policy = ? WHERE id = ?').run(JSON.stringify({ ...q.policy, days: 1 }), q.id);
    expect(() => commitRetention(env.engine, env.admin, q.id, q.operationHash)).toThrow(/changed/);
    const r = prepareRetention(env.engine, env.admin, { days: 30 }); env.advance(16 * 60_000);
    expect(() => commitRetention(env.engine, env.admin, r.id, r.operationHash)).toThrow(/expired/);
  });
  it('rejects newly scheduled work atomically and excludes uncertain or recent work', async () => {
    const { env, id } = await fixture(); const p = prepareRetention(env.engine, env.admin, { days: 30 });
    const a = action(env);
    expect(prepareRetention(env.engine, env.admin, { days: 30 }).contactIds).toEqual([]);
    expect(() => commitRetention(env.engine, env.admin, p.id, p.operationHash)).toThrow(/changed/);
    expect(env.engine.db.prepare('SELECT full_name FROM contacts WHERE id = ?').get<{ full_name: string }>(id)?.full_name).not.toBe('[pruned]');
    env.engine.db.prepare("UPDATE scheduled_actions SET state = 'uncertain', updated_at = ? WHERE id = ?").run(env.now() - 40 * 86_400_000, a);
    expect(prepareRetention(env.engine, env.admin, { days: 30 }).contactIds).toEqual([]);
  });
  it('rolls back all redaction and retains the suppression if any step fails', async () => {
    const { env, id } = await fixture(); const p = prepareRetention(env.engine, env.admin, { days: 30 });
    env.engine.db.exec("CREATE TRIGGER fail_retention BEFORE INSERT ON retained_contacts BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    expect(() => commitRetention(env.engine, env.admin, p.id, p.operationHash)).toThrow(/synthetic failure/);
    expect(env.engine.db.prepare('SELECT full_name FROM contacts WHERE id = ?').get<{ full_name: string }>(id)?.full_name).toBe('Ada Lovelace');
    expect(isSuppressed(env.engine.db, 'ws', 'person@example.org', null)).toBe('global:opt_out');
    expect(env.engine.db.prepare('SELECT committed_at FROM retention_previews WHERE id = ?').get<{ committed_at: null }>(p.id)?.committed_at).toBeNull();
  });
  it('keeps unexpired opt-outs, unsuppressed alternate addresses and legacy scopes out of pruning', async () => {
    const { env } = await fixture();
    expect(prepareRetention(env.engine, env.admin, { days: 60 }).contactIds).toEqual([]);
    const other = env.contact('unsubscribed-later@example.org');
    expect(prepareRetention(env.engine, env.admin, { days: 30 }).contactIds).not.toContain(other);
    addSuppression(env.engine.db, { workspaceId: 'ws', scope: 'domain', value: 'blocked.example', reason: 'manual', source: 'test' }, env.now());
    expect(isSuppressed(env.engine.db, 'ws', 'p@blocked.example', null)).toBe('domain:manual');
  });
  it('redacts old terminal payloads and supports later reimports using the typed fingerprint', async () => {
    const { env, id } = await fixture(); const db = env.engine.db;
    const a = action(env); await env.engine.runOnce(); env.advance(40 * 86_400_000);
    const p = prepareRetention(env.engine, env.admin, { days: 30 });
    expect(p.counts.actions).toBe(1);
    commitRetention(env.engine, env.admin, p.id, p.operationHash);
    expect(db.prepare('SELECT payload, recipient_norm FROM scheduled_actions WHERE id = ?').get(a))
      .toEqual({ payload: '{"retained":true}', recipient_norm: null });
    const reimported = env.contact('person@example.org'); expect(reimported).not.toBe(id);
    env.advance(40 * 86_400_000);
    const q = prepareRetention(env.engine, env.admin, { days: 30 });
    expect(q.contactIds).toEqual([reimported]);
    commitRetention(env.engine, env.admin, q.id, q.operationHash);
    expect(db.prepare('SELECT * FROM suppression_fingerprints').all()).toHaveLength(1);
    expect(isSuppressed(db, 'ws', 'PERSON@example.org', null)).toBe('global:opt_out');
  });
  it('bounds pages deterministically and never selects a contact already pruned', async () => {
    const { env, id } = await fixture();
    const other = env.contact('second@example.org');
    addSuppression(env.engine.db, { workspaceId: 'ws', scope: 'global', value: 'second@example.org', reason: 'opt_out', source: 'test' }, env.now());
    env.advance(40 * 86_400_000);
    const p = prepareRetention(env.engine, env.admin, { days: 30, limit: 1 });
    expect(p.contactIds).toHaveLength(1); expect(p.scanned).toBe(1);
    const q = prepareRetention(env.engine, env.admin, { days: 30, limit: 1, afterId: p.nextAfterId! });
    expect(new Set([...p.contactIds, ...q.contactIds])).toEqual(new Set([id, other]));
    commitRetention(env.engine, env.admin, p.id, p.operationHash);
    const fresh = prepareRetention(env.engine, env.admin, { days: 30 });
    expect(fresh.contactIds).not.toContain(p.contactIds[0]);
  });

  it('excludes noncanonical direct recipients and all unresolved inbound correlations', async () => {
    const { env } = await fixture(); const db = env.engine.db;
    const a = action(env);
    db.prepare("UPDATE scheduled_actions SET recipient_norm = ' mailto:PERSON@EXAMPLE.ORG ', state = 'uncertain' WHERE id = ?").run(a);
    expect(prepareRetention(env.engine, env.admin, { days: 30 }).contactIds).toEqual([]);
    db.prepare("UPDATE scheduled_actions SET state = 'cancelled', updated_at = ? WHERE id = ?").run(env.now() - 40 * 86_400_000, a);
    expect(prepareRetention(env.engine, env.admin, { days: 30 }).contactIds).toHaveLength(1);
    const event = { eventId: 'synthetic-bounce', kind: 'bounce', providerMessageId: 'synthetic-message', from: 'postmaster@example.net', to: ['sender@example.com'], references: [], receivedAt: env.now(), headers: {}, dsn: { status: '5.1.1', recipient: 'person@example.org' } };
    db.prepare("INSERT INTO provider_events (id,workspace_id,provider_account_id,provider_event_id,kind,payload,payload_digest,status,received_at) VALUES (?,?,?,?,?,?,?,'pending',?)")
      .run(ulid(env.now()), 'ws', env.accountId, event.eventId, 'bounce', JSON.stringify(event), digestCanonical(event), env.now());
    expect(prepareRetention(env.engine, env.admin, { days: 30 }).contactIds).toEqual([]);
    db.prepare("UPDATE provider_events SET status = 'processed', processed_at = ?").run(env.now());
    expect(prepareRetention(env.engine, env.admin, { days: 30 }).contactIds).toEqual([]);
    env.advance(40 * 86_400_000);
    const p = prepareRetention(env.engine, env.admin, { days: 30 }); expect(p.counts.events).toBe(1);
    commitRetention(env.engine, env.admin, p.id, p.operationHash);
    expect(db.prepare('SELECT payload FROM provider_events').get()).toEqual({ payload: '{"retained":true}' });
  });

  it('fails closed on history above the bounded maintenance scan', async () => {
    const { env } = await fixture(); const db = env.engine.db;
    db.transaction(() => {
      const insert = db.prepare("INSERT INTO provider_events (id,workspace_id,provider_account_id,provider_event_id,kind,payload,payload_digest,status,received_at) VALUES (?,?,?,?,?,'{}','synthetic','ignored',?)");
      for (let i = 0; i <= 10000; i += 1) insert.run(`event-${i}`, 'ws', env.accountId, `provider-${i}`, 'message', env.now());
    });
    expect(() => prepareRetention(env.engine, env.admin, { days: 30 })).toThrow(/10000/);
    expect(db.prepare('SELECT * FROM retention_previews').all()).toHaveLength(0);
  });

  it('revisits aged late replies linked to a pruned identity without losing suppression', async () => {
    const env = await makeDomainEnv(); open.push(env); const db = env.engine.db;
    const id = env.contact('person@example.org');
    const { campaignId } = createCampaign(env.engine, env.operator, { name: 'Late reply', playbook: PLAYBOOK, providerAccountId: env.accountId });
    const activation = prepareActivation(env.engine, env.operator, campaignId);
    decideApproval(env.engine, env.approver, { approvalId: activation.approvalId!, decision: 'approved', operationHash: activation.operationHash });
    const { batchApprovalId } = commitActivation(env.engine, env.operator, { campaignId, operationHash: activation.operationHash });
    const batch = listApprovals(db, env.approver).find((r) => r.id === batchApprovalId)!;
    decideApproval(env.engine, env.approver, { approvalId: batch.id, decision: 'approved', operationHash: batch.operation_hash });
    await env.drain(); const first = env.fake.deliveries[0] as FakeDelivery;
    const point = db.prepare('SELECT id FROM contact_points WHERE contact_id = ?').get<{ id: string }>(id)!;
    handleUnsubscribe(env.engine, createUnsubscribeToken(env.engine.unsubscribe!.secret, { w: 'ws', cp: point.id, c: campaignId }));
    env.advance(40 * 86_400_000);
    const p = prepareRetention(env.engine, env.admin, { days: 30 }); expect(p.contactIds).toContain(id);
    commitRetention(env.engine, env.admin, p.id, p.operationHash);
    const fingerprints = db.prepare('SELECT * FROM suppression_fingerprints').all();
    env.fake.reply(first, { at: env.now(), subject: 'Person private subject' }); await env.engine.runOnce();
    expect(prepareRetention(env.engine, env.admin, { days: 30 }).contactIds).toEqual([]);
    env.advance(40 * 86_400_000);
    const q = prepareRetention(env.engine, env.admin, { days: 30 }); expect(q.contactIds).toEqual([id]);
    db.prepare('UPDATE retained_contacts SET pruned_at = pruned_at - 1 WHERE contact_id = ?').run(id);
    expect(() => commitRetention(env.engine, env.admin, q.id, q.operationHash)).toThrow(/changed/);
    const fresh = prepareRetention(env.engine, env.admin, { days: 30 });
    commitRetention(env.engine, env.admin, fresh.id, fresh.operationHash);
    expect(db.prepare("SELECT from_addr, subject FROM messages WHERE direction = 'inbound'").get()).toEqual({ from_addr: '', subject: null });
    expect(db.prepare('SELECT * FROM suppression_fingerprints').all()).toEqual(fingerprints);
    expect(isSuppressed(db, 'ws', 'person@example.org', null)).toBe('global:opt_out');
    env.advance(40 * 86_400_000);
    expect(prepareRetention(env.engine, env.admin, { days: 30 }).contactIds).toEqual([]);
  });

  it('does not grandfather an unsuppressed email newly linked to an already pruned identity', async () => {
    const { env, id } = await fixture(); const db = env.engine.db;
    const p = prepareRetention(env.engine, env.admin, { days: 30 }); commitRetention(env.engine, env.admin, p.id, p.operationHash);
    const other = env.contact('fresh@example.org');
    db.prepare('UPDATE contact_points SET contact_id = ? WHERE contact_id = ?').run(id, other);
    env.advance(40 * 86_400_000);
    expect(prepareRetention(env.engine, env.admin, { days: 30 }).contactIds).not.toContain(id);
    expect(isSuppressed(db, 'ws', 'person@example.org', null)).toBe('global:opt_out');
    expect(isSuppressed(db, 'ws', 'fresh@example.org', null)).toBeNull();
  });

});
