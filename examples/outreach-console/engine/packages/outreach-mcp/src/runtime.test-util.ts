import { createEngine, bootstrapWorkspace, authenticate, registerProviderAccount, createTemplate, addContact } from '@splitin/outreach-core';
import { FakeEmailProvider, staticSecrets, FAKE_EMAIL_SECRET } from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
export const PLAYBOOK = `
apiVersion: outreach.splitin.net/v1alpha1
kind: Playbook
metadata: { name: review }
spec:
  purpose: automated_outreach
  policy:
    approval: first_batch_then_campaign
    unsubscribe: link
  steps:
    - { id: intro, type: email.send, template: intro@1 }
`;
export async function makeDomainEnv() {
  const db = openSqliteDatabase(':memory:');
  const now = () => Date.UTC(2026, 9, 20, 14);
  const fake = new FakeEmailProvider();
  const engine = createEngine({ db, adapters: [fake.adapter()], secrets: staticSecrets({ 'env:FAKE': FAKE_EMAIL_SECRET }), workerId: 'test', now, unsubscribe: { baseUrl: 'https://example.org/u/', secret: 'synthetic-unsubscribe-test' } });
  bootstrapWorkspace(db, { workspaceId: 'ws', name: 'Test', adminRef: 'test:admin', adminName: 'Admin' }, now());
  const admin = authenticate(db, 'ws', 'test:admin', 'test', 'test');
  const accountId = await registerProviderAccount(engine, admin, { provider: 'fake-email', externalAccountId: 'sender@example.org', sender: { address: 'sender@example.org', name: 'Sender', postalAddress: '1 Example Street' }, purposes: ['automated_outreach'], secretRef: 'env:FAKE' });
  createTemplate(db, admin, { name: 'intro', channel: 'email', subject: 'Hello {{first_name}}', text: 'Hello {{first_name}}' }, now());
  createTemplate(db, admin, { name: 'social', channel: 'linkedin', text: 'Hello {{first_name}}' }, now());
  return { engine, admin, accountId, now, contact: (email: string, extra: { firstName?: string } = {}) => addContact(engine, admin, { email, fullName: 'Example Person', firstName: 'Example', consentBasis: 'consent', ...extra }) };
}
