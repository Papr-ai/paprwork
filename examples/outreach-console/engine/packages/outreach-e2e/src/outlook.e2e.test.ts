/**
 * The engine driving the Outlook adapter over HTTP against a fake Microsoft Graph: a send whose response is
 * lost after Exchange moved it to Sent Items (under a new id, with a replaced Message-ID) is reconciled
 * instead of repeated; a reply stops the follow-up; an Exchange NDR stops and suppresses the bounced address.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@splitin/outreach-contracts';
import {
  addContact,
  authenticate,
  bootstrapWorkspace,
  campaignStatus,
  commitActivation,
  createCampaign,
  createEngine,
  createTemplate,
  prepareActivation,
  registerProviderAccount,
} from '@splitin/outreach-core';
import { FakeGraphServer } from '@splitin/outreach-fakes';
import { microsoftRefreshTokenSource, outlookAdapter } from '@splitin/outreach-provider-email-outlook';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';

const DAY = 86_400_000;
const PLAYBOOK = `
apiVersion: outreach.splitin.net/v1alpha1
kind: Playbook
metadata: { name: outlook-e2e }
spec:
  purpose: automated_outreach
  policy:
    approval: none
    unsubscribe: reply
    window: { timezone: recipient, fallback: America/New_York, days: [Mon, Tue, Wed, Thu, Fri], start: "08:00", end: "18:00" }
    limits: { accountPerDay: 50, domainPerDay: 10, recipientMinGap: P1D }
  steps:
    - { id: intro, type: email.send, template: intro@1 }
    - { id: wait, type: wait, duration: P2D }
    - { id: bump, type: email.reply, template: bump@1, when: no_reply }
`;

const servers: FakeGraphServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('engine + Outlook adapter over HTTP', () => {
  it('reconciles a lost send, stops on a reply and on an NDR, and follows up with the rest', async () => {
    const graph = await new FakeGraphServer({ replaceMessageId: true, rotateRefreshTokens: true }).start();
    servers.push(graph);
    let now = Date.parse('2025-06-02T13:00:00Z');
    const values: Record<string, string> = { 'file:outlook.json': graph.grant() };
    const db = openSqliteDatabase(':memory:');
    const engine = createEngine({
      db,
      adapters: [outlookAdapter({ api: graph.url, tokens: microsoftRefreshTokenSource({ authority: graph.url }), purposes: ['automated_outreach'], settleMs: 0 })],
      secrets: { get: async (ref) => values[ref] ?? Promise.reject(new Error(ref)), put: async (ref, value) => void (values[ref] = value) },
      workerId: 'outlook-e2e',
      sendGate: { mode: 'open' },
      now: () => now,
      pollIntervalMs: 0,
      execution: { reconcileDelayMs: 0 },
    });
    const drain = async () => {
      for (let i = 0; i < 6; i += 1) await engine.runOnce();
    };
    bootstrapWorkspace(db, { workspaceId: 'ws', name: 'W', adminRef: 'cli:admin', adminName: 'Admin' }, now);
    const admin = authenticate(db, 'ws', 'cli:admin', 'cli', 't');
    const accountId = await registerProviderAccount(engine, admin, {
      provider: 'outlook',
      externalAccountId: graph.mailbox,
      sender: { name: 'Sam', address: graph.mailbox, postalAddress: '1 Example Street' },
      purposes: ['automated_outreach'],
      secretRef: 'file:outlook.json',
    });
    createTemplate(db, admin, { name: 'intro', channel: 'email', subject: 'Quick question, {{first_name}}', text: 'Hi {{first_name}}, worth a chat?' }, now);
    createTemplate(db, admin, { name: 'bump', channel: 'email', text: 'Bumping this, {{first_name}}.' }, now);
    for (const [name, address] of [['Ada Lovelace', 'ada@example.org'], ['Grace Hopper', 'grace@example.net'], ['Linus T', 'linus@example.com']] as const) {
      addContact(engine, admin, { fullName: name, firstName: name.split(' ')[0], email: address, timezone: 'America/New_York', consentBasis: 'legitimate_interest' });
    }
    const { campaignId } = createCampaign(engine, admin, { name: 'Outlook e2e', playbook: PLAYBOOK, providerAccountId: accountId });
    commitActivation(engine, admin, { campaignId, operationHash: prepareActivation(engine, admin, campaignId).operationHash });

    graph.force({ kind: 'unknown_after_accept' });
    await drain();
    const sent = () => graph.messages.filter((m) => m.folder === 'sentitems');
    expect(sent()).toHaveLength(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM action_attempts').get<{ n: number }>()?.n).toBe(3);
    expect(JSON.parse(values['file:outlook.json'] ?? '{}').refreshToken).not.toBe('ms-refresh-1'); // Rotation persisted.

    const toAda = sent().find((m) => m.to.includes('ada@example.org'));
    const toGrace = sent().find((m) => m.to.includes('grace@example.net'));
    graph.deliver({
      conversationId: toAda?.conversationId,
      mime: `From: ada@example.org\r\nTo: ${graph.mailbox}\r\nSubject: RE: Quick question, Ada\r\nMessage-ID: <reply-1@example.org>\r\nIn-Reply-To: ${toAda?.internetMessageId}\r\n\r\nYes, let's talk.`,
      bodyPreview: "Yes, let's talk.",
    });
    graph.deliver({
      mime: [
        `From: postmaster@contoso.example`,
        `To: ${graph.mailbox}`,
        'Subject: Undeliverable: Quick question, Grace',
        'Content-Type: multipart/report; report-type=delivery-status; boundary="nd"',
        '',
        '--nd',
        'Content-Type: message/delivery-status',
        '',
        'Final-Recipient: rfc822; grace@example.net',
        'Status: 5.1.1',
        '--nd',
        'Content-Type: text/rfc822-headers',
        '',
        `Message-ID: ${toGrace?.internetMessageId}`,
        '--nd--',
      ].join('\r\n'),
    });
    now += 2 * DAY;
    await drain();

    const bumps = sent().filter((m) => m.subject.startsWith('Re:'));
    expect(bumps.map((m) => m.to)).toEqual([['linus@example.com']]);
    expect(campaignStatus(engine, admin, campaignId).enrollments).toEqual({ replied: 1, bounced: 1, completed: 1 });
    expect(db.prepare(`SELECT reason FROM suppressions WHERE value_norm = 'grace@example.net'`).get<{ reason: string }>()?.reason).toBe('hard_bounce');
    expect(verifyAuditChain(db).ok).toBe(true);
  });
});
