import type { CapabilitySnapshot, SenderIdentity, SqlDatabase } from '@splitin/outreach-contracts';
import { enqueueAction } from '../execution/enqueue';
import type { Actor } from '../execution/actions-repo';
import type { EmailPayload, ManualPayload } from '../execution/invoke';
import { addDuration, nextSlot, resolveZone, durationMs } from './calendar';
import { loadCampaign, loadEnrollment, loadVersion, type CampaignRow, type CampaignVersionRow, type DomainEnv, type EnrollmentRow } from './env';
import type { Policy, Step } from './playbook';
import { createUnsubscribeToken, stopEnrollment } from './suppressions';
import { ForbiddenError } from './auth';
import { TemplateRenderError, escapeHtml, findTemplate, render } from './templates';

/** Control surfaces must not silently change compliance content while freezing actions. */
export function assertMaterializationRuntime(env: DomainEnv, workspaceId: string, policy: Policy, steps: readonly Step[]): void {
  if (env.unsubscribe) return;
  const needsLink = policy.unsubscribe === 'link' && steps.some((step) => step.type === 'email.send' || step.type === 'email.reply');
  const usesToken = steps.some((step) => 'template' in step && findTemplate(env.db, workspaceId, step.template)?.required_tokens.includes('unsubscribe_url'));
  if (needsLink || usesToken) throw new ForbiddenError('configured unsubscribe runtime is required; use the configured CLI or API to commit');
}

export interface StepContext {
  readonly enrollment: EnrollmentRow;
  readonly campaign: CampaignRow;
  readonly version: CampaignVersionRow;
  readonly steps: readonly Step[];
  readonly policy: Policy;
}

interface ContactView {
  full_name: string;
  first_name: string | null;
  title: string | null;
  timezone: string | null;
  attributes: string;
  org_name: string | null;
  org_domain: string | null;
  email: string;
  profile_url: string | null;
}

export function loadStepContext(db: SqlDatabase, enrollmentId: string): StepContext | null {
  const enrollment = loadEnrollment(db, enrollmentId);
  if (!enrollment) return null;
  const campaign = loadCampaign(db, enrollment.workspace_id, enrollment.campaign_id);
  const version = loadVersion(db, enrollment.campaign_version_id);
  if (!campaign || !version) return null;
  const sequence = db.prepare('SELECT spec FROM sequence_versions WHERE id = ?').get<{ spec: string }>(version.sequence_version_id);
  if (!sequence) return null;
  const spec = JSON.parse(sequence.spec) as { steps: Step[] };
  return { enrollment, campaign, version, steps: spec.steps, policy: JSON.parse(version.policy) as Policy };
}

function loadContact(db: SqlDatabase, enrollment: EnrollmentRow): ContactView | undefined {
  return db
    .prepare(
      `SELECT c.full_name, c.first_name, c.title, c.timezone, c.attributes, o.name AS org_name, o.domain_norm AS org_domain,
         cp.value_norm AS email,
         (SELECT value_norm FROM contact_points s WHERE s.contact_id = c.id AND s.kind = 'social_profile' LIMIT 1) AS profile_url
       FROM contacts c JOIN contact_points cp ON cp.id = ? LEFT JOIN organizations o ON o.id = c.organization_id
       WHERE c.id = ?`,
    )
    .get<ContactView>(enrollment.contact_point_id, enrollment.contact_id);
}

function senderOf(db: SqlDatabase, accountId: string): { sender: SenderIdentity; caps: Partial<CapabilitySnapshot> } {
  const row = db.prepare('SELECT sender_identity, capabilities FROM provider_accounts WHERE id = ?').get<{ sender_identity: string; capabilities: string }>(accountId);
  if (!row) throw new Error(`provider account ${accountId} not found`);
  return { sender: JSON.parse(row.sender_identity) as SenderIdentity, caps: JSON.parse(row.capabilities) as Partial<CapabilitySnapshot> };
}

function tokenValues(env: DomainEnv, sc: StepContext, contact: ContactView, sender: SenderIdentity): Record<string, string | undefined> {
  const attributes = JSON.parse(contact.attributes) as Record<string, unknown>;
  const values: Record<string, string | undefined> = {
    first_name: contact.first_name ?? undefined,
    full_name: contact.full_name,
    title: contact.title ?? undefined,
    org_name: contact.org_name ?? undefined,
    org_domain: contact.org_domain ?? undefined,
    sender_name: sender.name,
    sender_email: sender.address,
    sender_org: sender.organization ?? undefined,
    sender_address: sender.postalAddress ?? undefined,
  };
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' || typeof value === 'number') values[`attr.${key.toLowerCase()}`] = String(value);
  }
  if (env.unsubscribe) {
    values.unsubscribe_url = `${env.unsubscribe.baseUrl}${createUnsubscribeToken(env.unsubscribe.secret, {
      w: sc.enrollment.workspace_id,
      cp: sc.enrollment.contact_point_id,
      c: sc.campaign.id,
    })}`;
  }
  return values;
}

function footer(sc: StepContext, sender: SenderIdentity, unsubscribeUrl: string | undefined): string[] {
  const lines: string[] = [];
  if (sc.policy.requirePostalAddress) lines.push(`${sender.organization ?? sender.name}, ${sender.postalAddress ?? ''}`.trim());
  if (sc.policy.unsubscribe === 'link' && unsubscribeUrl) lines.push(`Unsubscribe: ${unsubscribeUrl}`);
  else lines.push('Reply "unsubscribe" and we will not contact you again.');
  return lines;
}

function buildEmail(env: DomainEnv, sc: StepContext, step: Extract<Step, { type: 'email.send' | 'email.reply' }>, contact: ContactView): EmailPayload {
  const { db } = env;
  const template = findTemplate(db, sc.campaign.workspace_id, step.template);
  if (!template) throw new TemplateRenderError([`template:${step.template}`]);
  const { sender, caps } = senderOf(db, sc.version.provider_account_id);
  const values = tokenValues(env, sc, contact, sender);
  const unsubscribeUrl = sc.policy.unsubscribe === 'link' ? values.unsubscribe_url : undefined;
  const lines = footer(sc, sender, unsubscribeUrl);
  const text = `${render(template.body_text, values, 'text')}\n\n--\n${lines.join('\n')}`;
  const html = template.body_html
    ? `${render(template.body_html, values, 'html')}<hr><p>${lines.map(escapeHtml).join('<br>')}</p>`
    : undefined;
  const headers: Record<string, string> = {};
  if (caps.customHeaders) {
    // The mailto target is the sending mailbox, which the engine polls: a mailbox provider's "Unsubscribe"
    // button then arrives as an opt-out even with no public URL (BUILD_PLAN.md §19 D3).
    const targets = [...(unsubscribeUrl ? [unsubscribeUrl] : []), `mailto:${sender.address}?subject=unsubscribe`];
    headers['List-Unsubscribe'] = targets.map((target) => `<${target}>`).join(', ');
    if (unsubscribeUrl && env.unsubscribe?.oneClick !== false) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  let subject = template.subject ? render(template.subject, values, 'text') : '';
  const base = {
    from: { address: sender.address, name: sender.name },
    to: [{ address: contact.email, name: contact.full_name }],
    ...(sender.replyTo ? { replyTo: { address: sender.replyTo } } : {}),
    text,
    ...(html ? { html } : {}),
    headers,
  };
  if (step.type === 'email.send') return { ...base, subject };
  const previous = db
    .prepare(`SELECT * FROM messages WHERE enrollment_id = ? AND direction = 'outbound' ORDER BY at DESC LIMIT 1`)
    .get<{ rfc_message_id: string | null; references_ids: string; provider_thread_id: string | null; subject: string | null }>(sc.enrollment.id);
  if (!previous?.rfc_message_id) throw new TemplateRenderError(['previous_message']);
  if (!subject) subject = /^re:/i.test(previous.subject ?? '') ? (previous.subject ?? '') : `Re: ${previous.subject ?? ''}`;
  const references = [...(JSON.parse(previous.references_ids) as string[]), previous.rfc_message_id];
  return {
    ...base,
    subject,
    inReplyTo: previous.rfc_message_id,
    references,
    ...(previous.provider_thread_id ? { providerThreadId: previous.provider_thread_id } : {}),
  };
}

function renderManual(env: DomainEnv, sc: StepContext, ref: string, contact: ContactView): string {
  const template = findTemplate(env.db, sc.campaign.workspace_id, ref);
  if (!template) throw new TemplateRenderError([`template:${ref}`]);
  return render(template.body_text, tokenValues(env, sc, contact, senderOf(env.db, sc.version.provider_account_id).sender), 'text');
}

export interface MaterializeOptions {
  /** During activation: collect the first N email actions for one batch approval. */
  readonly batch?: { ids: string[]; size: number };
  /** Creates an action-scope approval for an action (every_action policy, or step approval: always). */
  readonly requestActionApproval: (actionId: string, contentHash: string) => string;
}

export type MaterializeResult = 'created' | 'completed' | 'error' | 'not_live';

/** Creates the next actionable step after `afterIndex`, honouring waits and the send window. */
export function materializeNext(
  env: DomainEnv,
  sc: StepContext,
  afterIndex: number,
  from: number,
  actor: Actor,
  options: MaterializeOptions,
): MaterializeResult {
  const { db } = env;
  const now = env.now();
  if (sc.enrollment.status !== 'active') return 'not_live';
  const contact = loadContact(db, sc.enrollment);
  if (!contact) return 'error';
  const window = sc.policy.window;
  const zone = resolveZone(window, contact.timezone);
  let due = from;
  for (let index = afterIndex + 1; index < sc.steps.length; index += 1) {
    const step = sc.steps[index];
    if (!step) break;
    if (step.type === 'wait') {
      due = addDuration(due, step.duration, step.calendar, window, zone);
      continue;
    }
    const dueAt = nextSlot(Math.max(due, now), window, zone);
    try {
      const payload: EmailPayload | ManualPayload =
        step.type === 'manual.task'
          ? {
              channel: step.channel,
              draft: renderManual(env, sc, step.template, contact),
              ...(contact.profile_url ? { targetUrl: contact.profile_url } : {}),
            }
          : buildEmail(env, sc, step, contact);
      const isEmail = step.type !== 'manual.task';
      const collectForBatch = isEmail && !!options.batch && options.batch.ids.length < options.batch.size;
      const perAction = isEmail && (sc.policy.approval === 'every_action' || step.approval === 'always') && !collectForBatch;
      const { action } = enqueueAction(
        db,
        {
          workspaceId: sc.enrollment.workspace_id,
          kind: step.type,
          payload,
          idempotencyKey: `seq:${sc.enrollment.id}:${step.id}`,
          dueAt,
          notAfter: dueAt + durationMs(sc.policy.expireAfter),
          providerAccountId: isEmail ? sc.version.provider_account_id : null,
          purpose: sc.campaign.purpose,
          recipient: isEmail ? contact.email : null,
          enrollmentId: sc.enrollment.id,
          campaignId: sc.campaign.id,
          stepId: step.id,
          contactPointId: sc.enrollment.contact_point_id,
          senderDomain: senderOf(db, sc.version.provider_account_id).sender.address.split('@')[1] ?? 'outreach.invalid',
          awaitingApproval: collectForBatch || perAction,
          approvalId: isEmail && !collectForBatch && !perAction && sc.policy.approval !== 'none' ? sc.version.approval_id : null,
        },
        actor,
        now,
      );
      if (collectForBatch) options.batch?.ids.push(action.id);
      if (perAction) {
        const approvalId = options.requestActionApproval(action.id, action.content_hash);
        db.prepare('UPDATE scheduled_actions SET approval_id = ? WHERE id = ?').run(approvalId, action.id);
      }
      db.prepare('UPDATE enrollments SET current_step_id = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?').run(step.id, now, sc.enrollment.id);
      return 'created';
    } catch (error) {
      if (!(error instanceof TemplateRenderError)) throw error;
      stopEnrollment(db, sc.enrollment.id, 'error', `template_missing:${error.missing.join(',')}`.slice(0, 200), actor, now);
      return 'error';
    }
  }
  db.prepare(`UPDATE enrollments SET status = 'completed', stop_reason = 'sequence_finished', row_version = row_version + 1, updated_at = ? WHERE id = ? AND status = 'active'`).run(now, sc.enrollment.id);
  return 'completed';
}

export function stepIndex(sc: StepContext, stepId: string | null): number {
  return sc.steps.findIndex((step) => step.id === stepId);
}


