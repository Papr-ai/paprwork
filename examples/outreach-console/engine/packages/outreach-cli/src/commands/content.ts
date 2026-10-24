import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { compileIssues, createTemplate, parsePlaybook, requireRole, suppress, type SuppressionReason, type SuppressionScope } from '@splitin/outreach-core';
import { commitImport, previewImport, saveMappingProfile } from '@splitin/outreach-import';
import { arg, flag, required, type Command } from './types';

export const contentCommands: Command[] = [
  {
    name: 'profile add',
    usage: 'outreach profile add <name> <profile.json>',
    summary: 'Store a new version of an import mapping profile.',
    async run({ args, out, runtime }) {
      const rt = await runtime();
      const ctx = rt.ctx();
      requireRole(ctx, 'operator');
      const spec = JSON.parse(readFileSync(arg(args, 1, 'profile.json'), 'utf8')) as unknown;
      const saved = rt.db.transaction(() => saveMappingProfile(rt.db, ctx.workspaceId, arg(args, 0, 'name'), spec, rt.engine.now()));
      out.result({ profileId: saved.id, name: saved.name, version: saved.version });
    },
  },
  {
    name: 'import preview',
    usage: 'outreach import preview <file> --profile <profile-id>',
    summary: 'Parse, validate and stage a lead file. Creates no contacts.',
    flags: { profile: 'string' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      const ctx = rt.ctx();
      requireRole(ctx, 'operator');
      const file = arg(args, 0, 'file');
      const preview = await previewImport(rt.db, { workspaceId: ctx.workspaceId, principalId: ctx.principalId, source: 'cli', traceId: ctx.traceId }, {
        fileName: basename(file),
        bytes: readFileSync(file),
        profileId: required(flags, 'profile'),
        now: rt.engine.now(),
      });
      out.result(preview);
      out.line(`\nCommit with: outreach import commit ${preview.batchId} --hash ${preview.previewHash} --key <idempotency-key>`);
    },
  },
  {
    name: 'import commit',
    usage: 'outreach import commit <batch-id> --hash <preview-hash> --key <idempotency-key>',
    summary: 'Create or update exactly the previewed contacts. Never enrolls or sends.',
    flags: { hash: 'string', key: 'string' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      const ctx = rt.ctx();
      requireRole(ctx, 'operator');
      out.result(commitImport(rt.db, { workspaceId: ctx.workspaceId, principalId: ctx.principalId, source: 'cli', traceId: ctx.traceId }, {
        batchId: arg(args, 0, 'batch-id'),
        previewHash: required(flags, 'hash'),
        idempotencyKey: required(flags, 'key'),
        now: rt.engine.now(),
      }));
    },
  },
  {
    name: 'template add',
    usage: 'outreach template add <name> --channel email|<social> --text-file <file> [--subject <s>] [--html-file <file>]',
    summary: 'Create the next immutable version of a template.',
    flags: { channel: 'string', subject: 'string', 'text-file': 'string', 'html-file': 'string' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      const html = flag(flags, 'html-file');
      const subject = flag(flags, 'subject');
      const row = createTemplate(rt.db, rt.ctx(), {
        name: arg(args, 0, 'name'),
        channel: required(flags, 'channel'),
        text: readFileSync(required(flags, 'text-file'), 'utf8'),
        ...(subject ? { subject } : {}),
        ...(html ? { html: readFileSync(html, 'utf8') } : {}),
      }, rt.engine.now());
      out.result({ template: `${row.name}@${row.version}`, tokens: JSON.parse(row.required_tokens) as string[] });
    },
  },
  {
    name: 'playbook compile',
    usage: 'outreach playbook compile <playbook.yaml> --account <provider-account-id>',
    summary: 'Validate a playbook against this workspace without creating anything.',
    flags: { account: 'string' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      const ctx = rt.ctx();
      const playbook = parsePlaybook(readFileSync(arg(args, 0, 'playbook.yaml'), 'utf8'));
      const issues = compileIssues(rt.engine, ctx.workspaceId, playbook, required(flags, 'account'));
      out.result({ name: playbook.metadata.name, steps: playbook.spec.steps.length, issues });
      return issues.length ? 1 : 0;
    },
  },
  {
    name: 'suppress',
    usage: 'outreach suppress <email|domain> --reason manual|do_not_contact|legal|opt_out [--scope global|channel|domain]',
    summary: 'Never contact this address or domain again.',
    flags: { reason: 'string', scope: 'string' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      const value = arg(args, 0, 'email|domain');
      const scope = (flag(flags, 'scope') ?? (value.includes('@') ? 'global' : 'domain')) as SuppressionScope;
      suppress(rt.engine, rt.ctx(), { scope, value, reason: required(flags, 'reason') as SuppressionReason, ...(scope === 'channel' ? { channel: 'email' } : {}) });
      out.result({ suppressed: value, scope });
    },
  },
];
