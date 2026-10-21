/**
 * The engine driving the real Gmail adapter over HTTP against a fake Gmail API: a send whose response is lost
 * is reconciled instead of repeated, a reply in the thread stops the sequence before the follow-up, and
 * Gmail's own Unsubscribe button (a mailto List-Unsubscribe to the sending mailbox) opts the recipient out
 * with no public URL (BUILD_PLAN.md §19 D3).
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
import { FakeGmailServer, staticSecrets } from '@splitin/outreach-fakes';
import { gmailAdapter, googleRefreshTokenSource } from '@splitin/outreach-provider-email-gmail';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';

const DAY = 86_400_000;
const PLAYBOOK = `
apiVersion: outreach.splitin.net/v1alpha1
kind: Playbook
metadata: { name: gmail-e2e }
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

const servers: FakeGmailServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('engine + Gmail adapter over HTTP', () => {
  it('reconciles a lost send instead of repeating it, and a threaded reply stops the follow-up', async () => {
    const gmail = await new FakeGmailServer({ replaceMessageId: true, searchLag: true }).start();
    servers.push(gmail);
    let now = Date.parse('2025-06-02T13:00:00Z'); // Monday 09:00 in New York.
    const db = openSqliteDatabase(':memory:');
    const engine = createEngine({
      db,
      adapters: [gmailAdapter({ api: gmail.url, tokens: googleRefreshTokenSource({ tokenUrl: `${gmail.url}/token` }), purposes: ['automated_outreach'], settleMs: 0 })],
      secrets: staticSecrets({ 'env:GMAIL': gmail.grant() }),
      workerId: 'gmail-e2e',
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
      provider: 'gmail',
      externalAccountId: gmail.mailbox,
      sender: { name: 'Sam Sender', address: gmail.mailbox, postalAddress: '1 Example Street' },
      purposes: ['automated_outreach'],
      secretRef: 'env:GMAIL',
    });
    createTemplate(db, admin, { name: 'intro', channel: 'email', subject: 'Quick question, {{first_name}}', text: 'Hi {{first_name}}, worth a chat?' }, now);
    createTemplate(db, admin, { name: 'bump', channel: 'email', text: 'Bumping this, {{first_name}}.' }, now);
    for (const [name, address] of [['Ada Lovelace', 'ada@example.org'], ['Grace Hopper', 'grace@example.net'], ['Linus T', 'linus@example.com']] as const) {
      addContact(engine, admin, { fullName: name, firstName: name.split(' ')[0], email: address, timezone: 'America/New_York', consentBasis: 'legitimate_interest' });
    }
    const { campaignId } = createCampaign(engine, admin, { name: 'Gmail e2e', playbook: PLAYBOOK, providerAccountId: accountId });
    const preview = prepareActivation(engine, admin, campaignId);
    commitActivation(engine, admin, { campaignId, operationHash: preview.operationHash });

    // The first send's response is lost after Gmail stored it; search has not indexed it either.
    gmail.force({ kind: 'unknown_after_accept' });
    await drain();
    const sent = () => gmail.messages.filter((message) => message.labelIds.includes('SENT'));
    expect(sent()).toHaveLength(3);
    const attempts = db.prepare('SELECT COUNT(*) AS n FROM action_attempts').get<{ n: number }>()?.n;
    expect(attempts).toBe(3);
    const unsubscribe = sent()[0]?.headers.find((h) => h.name === 'List-Unsubscribe')?.value;
    expect(unsubscribe).toBe(`<mailto:${gmail.mailbox}?subject=unsubscribe>`);
    // One of the two went through uncertain -> reconciling -> succeeded, found via the Sent folder.
    const path = db.prepare(`SELECT action FROM audit_events WHERE resource_kind = 'action' AND action IN ('executing->uncertain', 'reconciling->succeeded')`).all<{ action: string }>();
    expect(path.map((row) => row.action).sort()).toEqual(['executing->uncertain', 'reconciling->succeeded']);

    // Ada replies in the thread, referencing the Message-ID Gmail assigned.
    const toAda = sent().find((message) => message.headers.some((h) => h.name === 'To' && h.value.includes('ada@example.org')));
    const gmailMessageId = toAda?.headers.find((h) => h.name === 'Message-ID')?.value ?? '';
    expect(gmailMessageId).toMatch(/@mail\.gmail\.com>$/);
    gmail.deliver({
      threadId: toAda?.threadId,
      snippet: 'Sure, Thursday works.',
      headers: { From: 'Ada <ada@example.org>', To: gmail.mailbox, Subject: 'Re: Quick question, Ada', 'Message-ID': '<reply-1@example.org>', 'In-Reply-To': gmailMessageId, References: gmailMessageId },
    });
    // Grace presses Gmail's Unsubscribe: Gmail mails the List-Unsubscribe target, outside any thread.
    gmail.deliver({ snippet: 'This message was automatically generated by Gmail.', headers: { From: 'grace@example.net', To: gmail.mailbox, Subject: 'unsubscribe', 'Message-ID': '<unsub-1@mail.gmail.com>' } });
    now += 2 * DAY;
    await drain();

    const bumps = sent().filter((message) => message.headers.some((h) => h.name === 'Subject' && h.value.startsWith('Re:')));
    expect(bumps.map((message) => message.headers.find((h) => h.name === 'To')?.value)).toEqual([expect.stringContaining('linus@example.com')]);
    expect(campaignStatus(engine, admin, campaignId).enrollments).toEqual({ replied: 1, opted_out: 1, completed: 1 });
    const suppressed = db.prepare(`SELECT reason FROM suppressions WHERE value_norm = 'grace@example.net'`).get<{ reason: string }>();
    expect(suppressed?.reason).toBe('opt_out');
    expect(verifyAuditChain(db).ok).toBe(true);
  });
});
