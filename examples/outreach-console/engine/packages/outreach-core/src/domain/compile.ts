import { purposePermitted, type ProviderPurpose, type SenderIdentity } from '@splitin/outreach-contracts';
import type { DomainEnv } from './env';
import type { Playbook } from './playbook';
import { findTemplate } from './templates';

/**
 * Semantic checks that need the database and adapters (BUILD_PLAN.md §7.2). Structural checks already
 * ran in parsePlaybook. Returns human-readable issues; an empty list means the playbook can run.
 */
export function compileIssues(env: DomainEnv, workspaceId: string, playbook: Playbook, providerAccountId: string): string[] {
  const issues: string[] = [];
  const { steps, policy, purpose } = playbook.spec;

  const seen = new Set<string>();
  let sentBefore = false;
  steps.forEach((step, index) => {
    const at = `steps[${index}] (${step.id})`;
    if (seen.has(step.id)) issues.push(`${at}: duplicate step id`);
    seen.add(step.id);
    if (step.type === 'email.reply' && !sentBefore) issues.push(`${at}: email.reply needs an earlier email.send to reply to`);
    if (step.type === 'email.send') sentBefore = true;
    if (step.type === 'wait') {
      if (index === steps.length - 1) issues.push(`${at}: a trailing wait has no effect`);
      return;
    }
    const template = findTemplate(env.db, workspaceId, step.template);
    if (!template) {
      issues.push(`${at}: template ${step.template} does not exist`);
      return;
    }
    const expected = step.type === 'manual.task' ? [step.channel, 'manual'] : ['email'];
    if (!expected.includes(template.channel)) issues.push(`${at}: template ${step.template} is for channel ${template.channel}`);
    if (step.type === 'email.send' && !template.subject) issues.push(`${at}: template ${step.template} has no subject (only reply templates may omit it)`);
    const tokens = JSON.parse(template.required_tokens) as string[];
    if (tokens.includes('unsubscribe_url') && !env.unsubscribe) issues.push(`${at}: uses {{unsubscribe_url}} but no unsubscribe URL is configured`);
  });
  if (!steps.some((step) => step.type !== 'wait')) issues.push('steps: no actionable step');

  const account = env.db
    .prepare('SELECT provider, purposes, sender_identity FROM provider_accounts WHERE workspace_id = ? AND id = ?')
    .get<{ provider: string; purposes: string; sender_identity: string }>(workspaceId, providerAccountId);
  const sendsEmail = steps.some((step) => step.type === 'email.send' || step.type === 'email.reply');
  if (!account) {
    issues.push(`provider account ${providerAccountId} does not exist in this workspace`);
    return issues;
  }
  if (sendsEmail) {
    const adapter = env.adapters.get(account.provider);
    if (!adapter) issues.push(`no adapter registered for provider ${account.provider}`);
    else if (!adapter.email) issues.push(`provider ${account.provider} cannot send email`);
    else if (!purposePermitted(purpose, adapter.purposes, JSON.parse(account.purposes) as ProviderPurpose[])) {
      issues.push(`purpose ${purpose} is not permitted by both provider ${account.provider} and the account`);
    }
    const sender = JSON.parse(account.sender_identity) as SenderIdentity;
    if (policy.requirePostalAddress && !sender.postalAddress) issues.push('policy.requirePostalAddress: the sending account has no postal address');
    if (policy.unsubscribe === 'link' && !env.unsubscribe) issues.push('policy.unsubscribe is "link" but no unsubscribe URL is configured (use "reply" or configure one)');
  }
  return issues;
}
