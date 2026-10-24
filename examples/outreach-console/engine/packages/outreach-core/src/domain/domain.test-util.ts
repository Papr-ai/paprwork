import { FAKE_EMAIL_SECRET, FakeEmailProvider, FakeNotifier, staticSecrets } from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { DateTime } from 'luxon';
import { bootstrapWorkspace, createEngine, type Engine } from '../engine';
import type { SendGate } from '../execution/types';
import { authenticate, type AuthContext } from './auth';
import type { UnsubscribeConfig } from './env';
import { addContact, addPrincipal, registerProviderAccount } from './operations';
import { createTemplate } from './templates';

/** Tuesday 2025-03-04 14:00 UTC = 09:00 in New York: inside a 09:00-17:00 window. */
export const TUESDAY_9AM_NY = DateTime.fromISO('2025-03-04T09:00:00', { zone: 'America/New_York' }).toMillis();

export interface DomainTestEnv {
  readonly engine: Engine;
  readonly fake: FakeEmailProvider;
  readonly notifier: FakeNotifier;
  readonly admin: AuthContext;
  readonly operator: AuthContext;
  readonly approver: AuthContext;
  readonly viewer: AuthContext;
  readonly accountId: string;
  now(): number;
  advance(ms: number): void;
  setNow(ms: number): void;
  /** Runs worker passes until nothing changes (bounded). */
  drain(passes?: number): Promise<void>;
  contact(email: string, extra?: Partial<Parameters<typeof addContact>[2]>): string;
}

export const PLAYBOOK = `
apiVersion: outreach.splitin.net/v1alpha1
kind: Playbook
metadata: { name: b2b-intro }
spec:
  purpose: automated_outreach
  policy:
    approval: first_batch_then_campaign
    firstBatchSize: 2
    unsubscribe: link
    window: { timezone: recipient, fallback: America/New_York, days: [Mon, Tue, Wed, Thu, Fri], start: "09:00", end: "17:00" }
    limits: { accountPerDay: 50, domainPerDay: 50, recipientMinGap: P1D }
  steps:
    - { id: intro, type: email.send, template: intro@1 }
    - { id: wait1, type: wait, duration: P3D }
    - { id: followup, type: email.reply, template: followup@1, when: no_reply }
    - { id: social, type: manual.task, channel: linkedin, template: social@1, when: no_reply }
    - { id: close, type: email.reply, template: close@1, when: no_reply }
`;

export async function makeDomainEnv(options: { sendGate?: SendGate; start?: number; unsubscribe?: UnsubscribeConfig } = {}): Promise<DomainTestEnv> {
  const db = openSqliteDatabase(':memory:');
  const fake = new FakeEmailProvider();
  const notifier = new FakeNotifier();
  let now = options.start ?? TUESDAY_9AM_NY;
  const engine = createEngine({
    db,
    adapters: [fake.adapter(), notifier.adapter()],
    secrets: staticSecrets({ 'env:FAKE_EMAIL': FAKE_EMAIL_SECRET, 'env:FAKE_WEBHOOK': 'fake-webhook-secret-value' }),
    workerId: 'worker-1',
    sendGate: options.sendGate ?? { mode: 'open' },
    unsubscribe: options.unsubscribe ?? { baseUrl: 'https://outreach.example.com/u/', secret: 'unsubscribe-test-secret-fixture' },
    now: () => now,
    execution: { reconcileDelayMs: 0 },
    pollIntervalMs: 0,
    random: () => 0.5,
  });
  bootstrapWorkspace(db, { workspaceId: 'ws', name: 'Test', adminRef: 'test:admin', adminName: 'Admin' }, now);
  const admin = authenticate(db, 'ws', 'test:admin', 'test', 't-admin');
  addPrincipal(engine, admin, { externalRef: 'test:operator', displayName: 'Operator', roles: ['operator'] });
  addPrincipal(engine, admin, { externalRef: 'test:approver', displayName: 'Approver', roles: ['approver'] });
  addPrincipal(engine, admin, { externalRef: 'test:viewer', displayName: 'Viewer', roles: ['viewer'] });
  const operator = authenticate(db, 'ws', 'test:operator', 'test', 't-op');
  const approver = authenticate(db, 'ws', 'test:approver', 'test', 't-ap');
  const viewer = authenticate(db, 'ws', 'test:viewer', 'test', 't-view');
  const accountId = await registerProviderAccount(engine, admin, {
    provider: 'fake-email',
    externalAccountId: 'sender@example.com',
    sender: { name: 'Sam Sender', address: 'sender@example.com', organization: 'Example Co', postalAddress: '1 Example Street, Springfield' },
    purposes: ['automated_outreach'],
    secretRef: 'env:FAKE_EMAIL',
    webhookSecretRef: 'env:FAKE_WEBHOOK',
  });
  createTemplate(db, operator, { name: 'intro', channel: 'email', subject: 'Quick question, {{first_name}}', text: 'Hi {{first_name}}, I saw {{org_name}} is growing. Worth a chat?\n{{sender_name}}' }, now);
  createTemplate(db, operator, { name: 'followup', channel: 'email', text: 'Following up on my note, {{first_name}}.' }, now);
  createTemplate(db, operator, { name: 'social', channel: 'linkedin', text: 'Hi {{first_name}}, sent you an email about {{org_name}}.' }, now);
  createTemplate(db, operator, { name: 'close', channel: 'email', text: 'Last note from me, {{first_name}}.' }, now);

  const env: DomainTestEnv = {
    engine,
    fake,
    notifier,
    admin,
    operator,
    approver,
    viewer,
    accountId,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    setNow: (ms) => {
      now = ms;
    },
    drain: async (passes = 5) => {
      for (let i = 0; i < passes; i += 1) {
        const report = await engine.runOnce();
        if (report.execute.claimed === 0 && report.reconcile.found + report.reconcile.absent === 0 && report.inbound.processed === 0) return;
      }
    },
    contact: (email, extra = {}) =>
      addContact(engine, operator, {
        fullName: 'Ada Lovelace',
        firstName: 'Ada',
        email,
        timezone: 'America/New_York',
        organization: { name: 'Analytical Engines', domain: email.split('@')[1] ?? 'example.org' },
        consentBasis: 'legitimate_interest',
        ...extra,
      }),
  };
  return env;
}
