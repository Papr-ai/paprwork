import { describe, expect, it } from 'vitest';
import { decideApproval, listApprovals } from './approvals';
import { commitActivation, createCampaign, prepareActivation } from './campaigns';
import { makeDomainEnv, PLAYBOOK, type DomainTestEnv } from './domain.test-util';
import { checkAccountHealth, nextHealth, recordAccountHealth } from './health';
import { configureNotifications, registerProviderAccount } from './operations';

const MINUTE = 60_000;

async function activate(env: DomainTestEnv) {
  const { campaignId } = createCampaign(env.engine, env.operator, { name: 'Intro', playbook: PLAYBOOK, providerAccountId: env.accountId });
  const preview = prepareActivation(env.engine, env.operator, campaignId);
  if (preview.approvalId) decideApproval(env.engine, env.approver, { approvalId: preview.approvalId, decision: 'approved', operationHash: preview.operationHash });
  commitActivation(env.engine, env.operator, { campaignId, operationHash: preview.operationHash });
  for (const approval of listApprovals(env.engine.db, env.approver)) {
    decideApproval(env.engine, env.approver, { approvalId: approval.id, decision: 'approved', operationHash: approval.operation_hash });
  }
}

const health = (env: DomainTestEnv) =>
  env.engine.db.prepare('SELECT health, health_detail FROM provider_accounts WHERE id = ?').get<{ health: string; health_detail: string | null }>(env.accountId);

describe('nextHealth', () => {
  it.each([
    ['ok', { status: 'reauth_required', affirmative: true }, 'reauth_required'],
    ['ok', { status: 'degraded', affirmative: false }, 'degraded'],
    ['reauth_required', { status: 'ok', affirmative: true }, 'ok'],
    ['reauth_required', { status: 'degraded', affirmative: true }, 'reauth_required'],
    ['unhealthy', { status: 'degraded', affirmative: false }, 'unhealthy'],
    ['unhealthy', { status: 'reauth_required', affirmative: true }, 'reauth_required'],
    ['degraded', { status: 'ok', affirmative: true }, 'ok'],
  ] as const)('%s + %o -> %s', (current, observed, expected) => {
    expect(nextHealth(current, observed)).toBe(expected);
  });
});

describe('account health checker', () => {
  it('lets an account broken by a send recover only when the provider affirms ok, then sends resume', async () => {
    const env = await makeDomainEnv();
    env.contact('ada@example.org');
    await activate(env);
    env.fake.script({ kind: 'reject', errorClass: 'auth_expired' });
    await env.drain();
    expect(health(env)?.health).toBe('reauth_required');
    expect(env.fake.deliveries).toHaveLength(0);

    // A check that cannot reach a verdict must not re-enable sending.
    recordAccountHealth(env.engine.db, env.accountId, { status: 'degraded', affirmative: false, detail: 'timeout' }, env.now());
    expect(health(env)?.health).toBe('reauth_required');

    // The operator reconnects; the next check sees ok and the held send goes out.
    await checkAccountHealth(env.engine, env.accountId);
    expect(health(env)?.health).toBe('ok');
    env.advance(10 * MINUTE);
    await env.drain();
    expect(env.fake.deliveries).toHaveLength(1);
    const changes = env.engine.db.prepare(`SELECT detail FROM audit_events WHERE action = 'health_changed'`).all<{ detail: string }>();
    expect(changes.map((row) => JSON.parse(row.detail) as { to: string }).map((d) => d.to)).toEqual(['ok']);
  });

  it('runs on its interval inside the worker pass and notifies on a bad transition through another account', async () => {
    const env = await makeDomainEnv();
    const notifyId = await registerProviderAccount(env.engine, env.admin, { provider: 'fake-notify', externalAccountId: '#gtm', sender: { name: 'Ops', address: 'ops@example.com' }, purposes: ['transactional'], secretRef: 'env:FAKE_EMAIL' });
    configureNotifications(env.engine, env.admin, notifyId);
    env.fake.healthStatus = 'reauth_required';

    expect((await env.engine.runOnce()).health.checked).toBe(0); // Checked at registration; not due yet.
    env.advance(16 * MINUTE);
    const report = await env.engine.runOnce();
    expect(report.health).toEqual({ checked: 2, changed: 1 });
    expect(health(env)?.health).toBe('reauth_required');
    await env.drain();
    expect(env.notifier.published.map((n) => n.title)).toEqual(['Reconnect sending account sender@example.com']);
  });

  it('checks at registration and accepts file: secret references', async () => {
    const env = await makeDomainEnv();
    env.fake.healthStatus = 'unhealthy';
    const id = await registerProviderAccount(env.engine, env.admin, {
      provider: 'fake-email',
      externalAccountId: 'second@example.com',
      sender: { name: 'Second', address: 'second@example.com' },
      purposes: ['automated_outreach'],
      secretRef: 'file:~/.config/outreach/gmail-second@example.com.json',
    });
    const row = env.engine.db.prepare('SELECT health, secret_ref FROM provider_accounts WHERE id = ?').get<{ health: string; secret_ref: string }>(id);
    expect(row).toEqual({ health: 'unhealthy', secret_ref: 'file:~/.config/outreach/gmail-second@example.com.json' });
    await expect(registerProviderAccount(env.engine, env.admin, { provider: 'fake-email', externalAccountId: 'x', sender: { name: 'X', address: 'x@example.com' }, purposes: [], secretRef: 'plain-secret' })).rejects.toThrow(/secretRef must look like/);
  });
});
