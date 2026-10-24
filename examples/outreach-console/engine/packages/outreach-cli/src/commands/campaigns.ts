import { readFileSync } from 'node:fs';
import {
  campaignStatus,
  commitActivation,
  createCampaign,
  decideApproval,
  listApprovals,
  listCampaigns,
  listManualTasks,
  listReview,
  prepareActivation,
  recordManualOutcome,
  requestBatchApproval,
  resolveReview,
  setCampaignStatus,
  setKillSwitchAs,
  type ApprovalDecision,
  type KillSwitchScope,
  type ReviewResolution,
} from '@splitin/outreach-core';
import { arg, flag, required, type Command } from './types';

const decide = (decision: 'approved' | 'rejected'): Command => ({
  name: decision === 'approved' ? 'approvals approve' : 'approvals reject',
  usage: `outreach approvals ${decision === 'approved' ? 'approve' : 'reject'} <approval-id> --hash <operation-hash> [--reason <r>]`,
  summary: decision === 'approved' ? 'Approve exactly the content you reviewed (approver).' : 'Reject; affected actions are cancelled.',
  flags: { hash: 'string', reason: 'string' },
  async run({ args, flags, out, runtime }) {
    const rt = await runtime();
    const reason = flag(flags, 'reason');
    const row = decideApproval(rt.engine, rt.ctx(), { approvalId: arg(args, 0, 'approval-id'), decision, operationHash: required(flags, 'hash'), ...(reason ? { reason } : {}) });
    out.result({ approvalId: row.id, decision: row.decision });
  },
});

const setStatus = (status: 'paused' | 'active'): Command => ({
  name: status === 'paused' ? 'campaign pause' : 'campaign resume',
  usage: `outreach campaign ${status === 'paused' ? 'pause' : 'resume'} <campaign-id> --reason <r>`,
  summary: status === 'paused' ? 'Hold every pending send of a campaign.' : 'Resume a paused campaign.',
  flags: { reason: 'string' },
  async run({ args, flags, out, runtime }) {
    const rt = await runtime();
    setCampaignStatus(rt.engine, rt.ctx(), arg(args, 0, 'campaign-id'), status, required(flags, 'reason'));
    out.result({ status });
  },
});

const task = (outcome: 'done' | 'skipped'): Command => ({
  name: outcome === 'done' ? 'tasks done' : 'tasks skip',
  usage: `outreach tasks ${outcome === 'done' ? 'done' : 'skip'} <task-id> [--note <n>]`,
  summary: outcome === 'done' ? 'Record that you completed a manual task yourself.' : 'Skip a manual task; the sequence continues.',
  flags: { note: 'string' },
  async run({ args, flags, out, runtime }) {
    const rt = await runtime();
    recordManualOutcome(rt.engine, rt.ctx(), arg(args, 0, 'task-id'), outcome, flag(flags, 'note'));
    out.result({ status: outcome });
  },
});

const kill = (engaged: boolean): Command => ({
  name: engaged ? 'kill engage' : 'kill release',
  usage: `outreach kill ${engaged ? 'engage' : 'release'} global|workspace|provider_account|campaign [--target <id>] --reason <r>`,
  summary: engaged ? 'Stop all matching sends now.' : 'Release a kill switch (approver; global needs admin).',
  flags: { target: 'string', reason: 'string' },
  async run({ args, flags, out, runtime }) {
    const rt = await runtime();
    const scope = arg(args, 0, 'scope') as KillSwitchScope;
    const target = flag(flags, 'target');
    setKillSwitchAs(rt.engine, rt.ctx(), { scope, engaged, reason: required(flags, 'reason'), ...(target ? { targetId: target } : {}) });
    out.result({ scope, engaged });
  },
});

export const campaignCommands: Command[] = [
  {
    name: 'campaign create',
    usage: 'outreach campaign create <name> --playbook <file.yaml> --account <provider-account-id>',
    summary: 'Validate a playbook and create a draft campaign.',
    flags: { playbook: 'string', account: 'string' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      out.result(createCampaign(rt.engine, rt.ctx(), { name: arg(args, 0, 'name'), playbook: readFileSync(required(flags, 'playbook'), 'utf8'), providerAccountId: required(flags, 'account') }));
    },
  },
  {
    name: 'campaign list',
    usage: 'outreach campaign list',
    summary: 'List campaigns.',
    async run({ out, runtime }) {
      const rt = await runtime();
      out.result(listCampaigns(rt.engine, rt.ctx()));
    },
  },
  {
    name: 'campaign status',
    usage: 'outreach campaign status <campaign-id>',
    summary: 'Enrollment and action counts, open tasks.',
    async run({ args, out, runtime }) {
      const rt = await runtime();
      out.result(campaignStatus(rt.engine, rt.ctx(), arg(args, 0, 'campaign-id')));
    },
  },
  {
    name: 'campaign prepare',
    usage: 'outreach campaign prepare <campaign-id>',
    summary: 'Snapshot the audience and show the exact activation hash (and approval, if required).',
    async run({ args, out, runtime }) {
      const rt = await runtime();
      const preview = prepareActivation(rt.engine, rt.ctx(), arg(args, 0, 'campaign-id'));
      out.result(preview);
      out.line(`\nActivate with: outreach campaign activate ${arg(args, 0, 'campaign-id')} --hash ${preview.operationHash}`);
    },
  },
  {
    name: 'campaign activate',
    usage: 'outreach campaign activate <campaign-id> --hash <operation-hash>',
    summary: 'Enroll exactly the prepared (and approved) audience.',
    flags: { hash: 'string' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      out.result(commitActivation(rt.engine, rt.ctx(), { campaignId: arg(args, 0, 'campaign-id'), operationHash: required(flags, 'hash') }));
    },
  },
  setStatus('paused'),
  setStatus('active'),
  {
    name: 'approvals list',
    usage: 'outreach approvals list [--decision pending|approved|rejected|revoked|expired]',
    summary: 'List approvals with their exact previews.',
    flags: { decision: 'string' },
    async run({ flags, out, runtime }) {
      const rt = await runtime();
      const rows = listApprovals(rt.db, rt.ctx(), (flag(flags, 'decision') ?? 'pending') as ApprovalDecision);
      out.result(rows.map((row) => ({ id: row.id, scope: row.scope, operationHash: row.operation_hash, expiresAt: new Date(row.expires_at).toISOString(), preview: JSON.parse(row.preview) as unknown })));
    },
  },
  decide('approved'),
  decide('rejected'),
  {
    name: 'approvals batch',
    usage: 'outreach approvals batch <campaign-id>',
    summary: 'Gather actions waiting without a live approval into one new batch.',
    async run({ args, out, runtime }) {
      const rt = await runtime();
      out.result(requestBatchApproval(rt.engine, rt.ctx(), arg(args, 0, 'campaign-id')) ?? { count: 0 });
    },
  },
  {
    name: 'tasks list',
    usage: 'outreach tasks list',
    summary: 'Open manual tasks (e.g. social touches you do yourself).',
    async run({ out, runtime }) {
      const rt = await runtime();
      out.result(listManualTasks(rt.engine, rt.ctx()).map((t) => ({ id: t.id, channel: t.channel, target: t.target_url, draft: t.draft_text })));
    },
  },
  task('done'),
  task('skipped'),
  {
    name: 'review list',
    usage: 'outreach review list',
    summary: 'Actions a human must decide (uncertain sends, gated recipients, unsupported capabilities).',
    async run({ out, runtime }) {
      const rt = await runtime();
      out.result(listReview(rt.engine, rt.ctx()).map((a) => ({ id: a.id, kind: a.kind, recipient: a.recipient_norm, reason: a.state_reason, attempts: a.attempt_count })));
    },
  },
  {
    name: 'review resolve',
    usage: 'outreach review resolve <action-id> --as sent|not_sent|drop [--provider-id <id>] [--reason <r>]',
    summary: 'Record what really happened to a review item.',
    flags: { as: 'string', 'provider-id': 'string', reason: 'string' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      const as = required(flags, 'as');
      const resolution: ReviewResolution =
        as === 'sent' ? { kind: 'sent', providerMessageId: required(flags, 'provider-id') } : as === 'not_sent' ? { kind: 'not_sent_retry' } : { kind: 'drop', reason: required(flags, 'reason') };
      resolveReview(rt.engine, rt.ctx(), arg(args, 0, 'action-id'), resolution);
      out.result({ resolved: as });
    },
  },
  kill(true),
  kill(false),
];
