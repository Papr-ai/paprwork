import { describe, expect, it } from 'vitest';
import {
  addPrincipal,
  authenticate,
  bootstrapWorkspace,
  createApiToken,
  createEngine,
  createTemplate,
  registerProviderAccount,
  revokeApiToken,
  addContact,
  type Engine,
} from '@splitin/outreach-core';
import { FAKE_EMAIL_SECRET, FakeEmailProvider, staticSecrets } from '@splitin/outreach-fakes';
import { saveMappingProfile } from '@splitin/outreach-import';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { createApp } from './app';
import { PublicBindRefusedError, startServer } from './serve';

// Response bodies are asserted field by field below; a loose type keeps the assertions readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const json = async (res: Response | Promise<Response>): Promise<Json> => (await (await res).json()) as Json;

const PLAYBOOK = `
apiVersion: outreach.splitin.net/v1alpha1
kind: Playbook
metadata: { name: api-intro }
spec:
  purpose: automated_outreach
  policy: { approval: none, window: { days: [Mon, Tue, Wed, Thu, Fri, Sat, Sun], start: "00:00", end: "23:59" } }
  steps: [{ id: intro, type: email.send, template: intro@1 }]
`;

async function setup() {
  let now = Date.parse('2025-06-03T14:00:00Z');
  const db = openSqliteDatabase(':memory:');
  const fake = new FakeEmailProvider();
  const engine: Engine = createEngine({
    db,
    adapters: [fake.adapter()],
    secrets: staticSecrets({ 'env:MAIL': FAKE_EMAIL_SECRET, 'env:HOOK': 'fake-webhook-secret-value' }),
    workerId: 'api-test',
    sendGate: { mode: 'open' },
    unsubscribe: { baseUrl: 'https://outreach.example.com/u/', secret: 'server-test-unsubscribe-fixture' },
    now: () => now,
    pollIntervalMs: 0,
  });
  bootstrapWorkspace(db, { workspaceId: 'ws', name: 'W', adminRef: 'cli:admin', adminName: 'Admin' }, now);
  const admin = authenticate(db, 'ws', 'cli:admin', 'cli', 't');
  const operatorId = addPrincipal(engine, admin, { externalRef: 'http:ops', displayName: 'Ops', roles: ['operator'] });
  const approverId = addPrincipal(engine, admin, { externalRef: 'http:approver', displayName: 'Approver', roles: ['approver'] });
  const accountId = await registerProviderAccount(engine, admin, {
    provider: 'fake-email', externalAccountId: 'x', purposes: ['automated_outreach'], secretRef: 'env:MAIL', webhookSecretRef: 'env:HOOK',
    sender: { name: 'Sam', address: 'sam@example.com', organization: 'Example', postalAddress: '1 Example St' },
  });
  createTemplate(db, admin, { name: 'intro', channel: 'email', subject: 'Hello {{first_name}}', text: 'Hi {{first_name}}' }, now);
  const tokens = {
    operator: createApiToken(engine, admin, { principalId: operatorId, name: 'ops', roleCeiling: 'operator', ttlDays: 30 }).token,
    approver: createApiToken(engine, admin, { principalId: approverId, name: 'appr', roleCeiling: 'approver', ttlDays: 30 }).token,
    readOnly: createApiToken(engine, admin, { principalId: approverId, name: 'dash', roleCeiling: 'viewer', ttlDays: 30 }),
  };
  const app = createApp({ engine });
  const call = (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
    });
  return { engine, db, fake, admin, accountId, tokens, app, call, advance: (ms: number) => { now += ms; } };
}

describe('authentication', () => {
  it('rejects missing, malformed, revoked and expired tokens identically', async () => {
    const t = await setup();
    for (const token of [null, 'nope', `${t.tokens.operator}x`]) {
      const res = await t.call('GET', '/v1/me', token);
      expect(res.status).toBe(403);
      expect((await json(res)).message).toBe('invalid or expired token');
    }
    revokeApiToken(t.engine, t.admin, t.tokens.readOnly.id);
    expect((await t.call('GET', '/v1/me', t.tokens.readOnly.token)).status).toBe(403);
    t.advance(31 * 86_400_000);
    expect((await t.call('GET', '/v1/me', t.tokens.operator)).status).toBe(403);
  });

  it('caps a token at its role ceiling', async () => {
    const t = await setup();
    const me = await json(t.call('GET', '/v1/me', t.tokens.readOnly.token));
    expect(me.roles).toEqual(['viewer']);
    const res = await t.call('POST', '/v1/kill-switches', t.tokens.readOnly.token, { scope: 'workspace', engaged: true, reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('sets trace and safety headers', async () => {
    const t = await setup();
    const res = await t.call('GET', '/v1/me', t.tokens.operator);
    expect(res.headers.get('x-trace-id')).toMatch(/^[0-9A-Z]{26}$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('campaign flow over HTTP', () => {
  it('imports, creates, prepares, commits and reports status; approval decisions need the approver', async () => {
    const t = await setup();
    const profile = t.db.transaction(() => saveMappingProfile(t.db, 'ws', 'p', { columns: { email: 'Email', full_name: 'Name' }, consent: { basis: 'legitimate_interest' } }, Date.now()));
    const preview = await t.call('POST', `/v1/imports/preview?profileId=${profile.id}&fileName=a.csv`, t.tokens.operator, new TextEncoder().encode('Name,Email\nAda Lovelace,ada@example.org\n'), { 'content-type': 'text/csv' });
    expect(preview.status).toBe(201);
    const previewBody = await json(preview);
    const committed = await t.call('POST', `/v1/imports/${previewBody.batchId}/commit`, t.tokens.operator, { previewHash: previewBody.previewHash, idempotencyKey: 'k' });
    expect(await json(committed)).toMatchObject({ created: 1 });

    const created = await t.call('POST', '/v1/campaigns', t.tokens.operator, { name: 'API', playbook: PLAYBOOK, providerAccountId: t.accountId });
    expect(created.status).toBe(201);
    const { campaignId } = await json(created);
    const prepared = await json(t.call('POST', `/v1/campaigns/${campaignId}/activation/prepare`, t.tokens.operator));
    expect(prepared).toMatchObject({ audienceCount: 1, requiresApproval: false });
    const stale = await t.call('POST', `/v1/campaigns/${campaignId}/activation/commit`, t.tokens.operator, { operationHash: '0'.repeat(64) });
    expect(stale.status).toBe(409);
    const activated = await t.call('POST', `/v1/campaigns/${campaignId}/activation/commit`, t.tokens.operator, { operationHash: prepared.operationHash });
    expect(await json(activated)).toEqual({ enrolled: 1, batchApprovalId: null });
    await t.engine.runOnce();
    expect(t.fake.deliveries).toHaveLength(1);
    const status = await json(t.call('GET', `/v1/campaigns/${campaignId}`, t.tokens.readOnly.token));
    expect(status.enrollments).toEqual({ completed: 1 });
    expect((await json(t.call('GET', '/v1/campaigns', t.tokens.readOnly.token))).campaigns).toHaveLength(1);
  });

  it('validates bodies and maps domain errors', async () => {
    const t = await setup();
    const bad = await t.call('POST', '/v1/campaigns', t.tokens.operator, { name: 'x', playbook: PLAYBOOK, providerAccountId: t.accountId, extra: 1 });
    expect(bad.status).toBe(400);
    const invalid = await t.call('POST', '/v1/campaigns', t.tokens.operator, { name: 'x', playbook: PLAYBOOK.replace('intro@1', 'nope@1'), providerAccountId: t.accountId });
    expect(invalid.status).toBe(422);
    expect((await json(invalid)).issues[0]).toMatch(/nope@1 does not exist/);
    expect((await t.call('GET', '/v1/campaigns/missing', t.tokens.operator)).status).toBe(404);
    const tooBig = await t.call('POST', '/v1/campaigns', t.tokens.operator, { name: 'x'.repeat(300_000), playbook: '', providerAccountId: 'x' });
    expect(tooBig.status).toBe(413);
    expect((await t.call('GET', '/v1/nothing', t.tokens.operator)).status).toBe(404);
  });
});

describe('public routes', () => {
  it('accepts signed webhooks and rejects forged ones without a bearer token', async () => {
    const t = await setup();
    const event = t.fake.pushInbound({ kind: 'message', references: [], from: 'x@example.org', to: [], headers: {}, at: t.engine.now() });
    const signed = t.fake.signWebhook([event], t.engine.now());
    const ok = await t.call('POST', `/v1/webhooks/${t.accountId}`, null, signed.rawBody, signed.headers);
    expect(await json(ok)).toEqual({ accepted: true, stored: 1, duplicates: 0 });
    const forged = await t.call('POST', `/v1/webhooks/${t.accountId}`, null, signed.rawBody, { ...signed.headers, 'x-fake-signature': 'ab'.repeat(32) });
    expect(forged.status).toBe(401);
    expect((await t.call('POST', '/v1/webhooks/unknown', null, signed.rawBody, signed.headers)).status).toBe(404);
  });

  it('shows a confirmation on GET and unsubscribes only on POST', async () => {
    const t = await setup();
    addContact(t.engine, t.admin, { fullName: 'Ada', firstName: 'Ada', email: 'ada@example.org', consentBasis: 'legitimate_interest' });
    const created = await t.call('POST', '/v1/campaigns', t.tokens.operator, { name: 'U', playbook: PLAYBOOK, providerAccountId: t.accountId });
    const { campaignId } = await json(created);
    const prepared = await json(t.call('POST', `/v1/campaigns/${campaignId}/activation/prepare`, t.tokens.operator));
    await t.call('POST', `/v1/campaigns/${campaignId}/activation/commit`, t.tokens.operator, { operationHash: prepared.operationHash });
    await t.engine.runOnce();
    const token = /\/u\/([^>]+)>/.exec(t.fake.deliveries[0]?.headers['List-Unsubscribe'] ?? '')?.[1] ?? '';
    const get = await t.app.request(`/u/${token}`);
    expect(await get.text()).toMatch(/<form method="post">/);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM suppressions').get<{ n: number }>()?.n).toBe(0);
    const post = await t.app.request(`/u/${token}`, { method: 'POST' });
    expect(await post.text()).toMatch(/You are unsubscribed/);
    expect(t.db.prepare('SELECT reason FROM suppressions').get()).toEqual({ reason: 'opt_out' });
    expect((await t.app.request('/u/forged.token', { method: 'POST' })).status).toBe(400);
  });

  it('refuses to bind a public address unless explicitly allowed', async () => {
    const t = await setup();
    expect(() => startServer(t.app, { host: '0.0.0.0', port: 0 })).toThrow(PublicBindRefusedError);
    const { server, url } = await startServer(t.app, { port: 0 });
    const res = await fetch(`${url}/healthz`);
    expect(await json(res)).toEqual({ ok: true });
    server.close();
  });
});
