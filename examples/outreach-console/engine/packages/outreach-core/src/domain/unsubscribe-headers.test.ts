import { describe, expect, it } from 'vitest';
import { commitActivation, createCampaign, prepareActivation } from './campaigns';
import { decideApproval, listApprovals } from './approvals';
import { makeDomainEnv, PLAYBOOK, type DomainTestEnv } from './domain.test-util';

async function firstEmail(env: DomainTestEnv, playbook: string) {
  env.contact('ada@example.org');
  const { campaignId } = createCampaign(env.engine, env.operator, { name: 'Intro', playbook, providerAccountId: env.accountId });
  const preview = prepareActivation(env.engine, env.operator, campaignId);
  if (preview.approvalId) decideApproval(env.engine, env.approver, { approvalId: preview.approvalId, decision: 'approved', operationHash: preview.operationHash });
  commitActivation(env.engine, env.operator, { campaignId, operationHash: preview.operationHash });
  for (const approval of listApprovals(env.engine.db, env.approver)) {
    decideApproval(env.engine, env.approver, { approvalId: approval.id, decision: 'approved', operationHash: approval.operation_hash });
  }
  await env.drain();
  const email = env.fake.deliveries[0];
  if (!email) throw new Error('nothing was sent');
  return email;
}

describe('List-Unsubscribe', () => {
  it('reply policy: a mailto to the sending mailbox, and no one-click claim', async () => {
    const env = await makeDomainEnv();
    const email = await firstEmail(env, PLAYBOOK.replace('unsubscribe: link', 'unsubscribe: reply'));
    expect(email.headers['List-Unsubscribe']).toBe('<mailto:sender@example.com?subject=unsubscribe>');
    expect(email.headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('a link that opens a page (oneClick: false) keeps the mailto fallback but never advertises one-click', async () => {
    const env = await makeDomainEnv({ unsubscribe: { baseUrl: 'https://apps.example.com/unsub/?u=', secret: 'unsubscribe-test-secret-fixture', oneClick: false } });
    const email = await firstEmail(env, PLAYBOOK);
    expect(email.headers['List-Unsubscribe']).toMatch(/^<https:\/\/apps\.example\.com\/unsub\/\?u=[^>]+>, <mailto:sender@example\.com\?subject=unsubscribe>$/);
    expect(email.headers['List-Unsubscribe-Post']).toBeUndefined();
  });
});
