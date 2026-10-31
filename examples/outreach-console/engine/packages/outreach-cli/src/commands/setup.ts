import { PROVIDER_PURPOSES, verifyAuditChain, type ProviderPurpose } from '@splitin/outreach-contracts';
import {
  ROLES,
  addPrincipal,
  bootstrapWorkspace,
  checkAccountHealth,
  configureNotifications,
  createApiToken,
  JURISDICTION_RULES,
  readJurisdictionPolicy,
  readSendGate,
  registerProviderAccount,
  revokeApiToken,
  setJurisdictionPolicy,
  setSendGate,
  type JurisdictionRule,
  type Role,
} from '@splitin/outreach-core';
import { principalRef } from '../runtime';
import { arg, flag, required, type Command } from './types';

function parseRoles(value: string): Role[] {
  const roles = value.split(',').map((role) => role.trim());
  const bad = roles.filter((role) => !(ROLES as readonly string[]).includes(role));
  if (bad.length) throw new Error(`unknown roles: ${bad.join(', ')} (use ${ROLES.join(', ')})`);
  return roles as Role[];
}

function parseRule(value: string, name: string): JurisdictionRule {
  if (!(JURISDICTION_RULES as readonly string[]).includes(value)) throw new Error(`--${name} must be one of ${JURISDICTION_RULES.join(', ')}`);
  return value as JurisdictionRule;
}

/** `--allow US,GB --consent DE,CA --block FR` into a rules map; a country listed twice is an error. */
function parseRules(flags: Readonly<Record<string, string | boolean | undefined>>): Record<string, JurisdictionRule> {
  const rules: Record<string, JurisdictionRule> = {};
  const lists: [string, JurisdictionRule][] = [['allow', 'allow'], ['consent', 'consent_required'], ['block', 'block']];
  for (const [name, rule] of lists) {
    for (const country of (flag(flags, name) ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)) {
      if (rules[country]) throw new Error(`${country} is listed under more than one rule`);
      rules[country] = rule;
    }
  }
  return rules;
}

function parsePurposes(value: string): ProviderPurpose[] {
  const purposes = value.split(',').map((purpose) => purpose.trim());
  const bad = purposes.filter((purpose) => !(PROVIDER_PURPOSES as readonly string[]).includes(purpose));
  if (bad.length) throw new Error(`unknown purposes: ${bad.join(', ')} (use ${PROVIDER_PURPOSES.join(', ')})`);
  return purposes as ProviderPurpose[];
}

export const setupCommands: Command[] = [
  {
    name: 'init',
    usage: 'outreach init [--name <workspace name>]',
    summary: 'Create the database and workspace; you become its admin.',
    flags: { name: 'string' },
    async run({ options, flags, out, runtime, env }) {
      const rt = await runtime();
      const exists = rt.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(options.workspace);
      if (exists) {
        out.result({ workspace: options.workspace, created: false });
        return;
      }
      bootstrapWorkspace(rt.db, { workspaceId: options.workspace, name: flag(flags, 'name') ?? options.workspace, adminRef: principalRef(env), adminName: principalRef(env) }, rt.engine.now());
      out.result({ workspace: options.workspace, created: true, admin: principalRef(env), sendGate: 'closed (empty allowlist)' });
    },
  },
  {
    name: 'principal add',
    usage: 'outreach principal add <external-ref> --roles operator[,approver] [--name <display name>]',
    summary: 'Register a person or integration (e.g. slack:T1:U2, http:dashboard).',
    flags: { roles: 'string', name: 'string' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      const ref = arg(args, 0, 'external-ref');
      const id = addPrincipal(rt.engine, rt.ctx(), { externalRef: ref, displayName: flag(flags, 'name') ?? ref, roles: parseRoles(required(flags, 'roles')) });
      out.result({ principalId: id, externalRef: ref });
    },
  },
  {
    name: 'token create',
    usage: 'outreach token create <principal-ref> --name <label> [--role viewer|operator|approver|admin] [--days 90]',
    summary: 'Issue an API bearer token. It is printed once and never stored.',
    flags: { name: 'string', role: 'string', days: 'string' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      const ctx = rt.ctx();
      const ref = arg(args, 0, 'principal-ref');
      const principal = rt.db.prepare('SELECT id, roles FROM principals WHERE workspace_id = ? AND external_ref = ?').get<{ id: string; roles: string }>(ctx.workspaceId, ref);
      if (!principal) throw new Error(`principal ${ref} not found`);
      const [role] = parseRoles(flag(flags, 'role') ?? 'viewer');
      const created = createApiToken(rt.engine, ctx, { principalId: principal.id, name: required(flags, 'name'), roleCeiling: role ?? 'viewer', ttlDays: Number(flag(flags, 'days') ?? 90) });
      out.result({ tokenId: created.id, token: created.token, expiresAt: new Date(created.expiresAt).toISOString(), note: 'Store this token now; it cannot be shown again.' });
    },
  },
  {
    name: 'token revoke',
    usage: 'outreach token revoke <token-id>',
    summary: 'Revoke an API token immediately.',
    async run({ args, out, runtime }) {
      const rt = await runtime();
      revokeApiToken(rt.engine, rt.ctx(), arg(args, 0, 'token-id'));
      out.result({ revoked: true });
    },
  },
  {
    name: 'account add',
    usage: 'outreach account add --provider <adapter> --external-id <id> --sender-name <n> --sender-email <e> --purposes <p,...> --secret env:NAME|file:PATH [--org <o>] [--postal <address>] [--webhook-secret env:NAME]',
    summary: 'Register a provider account; purposes are what your contract with the provider allows.',
    flags: { provider: 'string', 'external-id': 'string', 'sender-name': 'string', 'sender-email': 'string', purposes: 'string', secret: 'string', org: 'string', postal: 'string', 'webhook-secret': 'string' },
    async run({ flags, out, runtime }) {
      const rt = await runtime();
      const id = await registerProviderAccount(rt.engine, rt.ctx(), {
        provider: required(flags, 'provider'),
        externalAccountId: required(flags, 'external-id'),
        sender: {
          name: required(flags, 'sender-name'),
          address: required(flags, 'sender-email'),
          ...(flag(flags, 'org') ? { organization: flag(flags, 'org') as string } : {}),
          ...(flag(flags, 'postal') ? { postalAddress: flag(flags, 'postal') as string } : {}),
        },
        purposes: parsePurposes(required(flags, 'purposes')),
        secretRef: required(flags, 'secret'),
        ...(flag(flags, 'webhook-secret') ? { webhookSecretRef: flag(flags, 'webhook-secret') as string } : {}),
      });
      out.result({ providerAccountId: id });
    },
  },
  {
    name: 'account check',
    usage: 'outreach account check <provider-account-id>',
    summary: 'Ask the provider for the account health now (a revoked grant shows reauth_required).',
    async run({ args, out, runtime }) {
      const rt = await runtime();
      rt.ctx();
      out.result(await checkAccountHealth(rt.engine, arg(args, 0, 'provider-account-id')));
    },
  },
  {
    name: 'gate show',
    usage: 'outreach gate show',
    summary: 'Show the live-send gate for this workspace.',
    async run({ out, runtime, options }) {
      const rt = await runtime();
      rt.ctx();
      out.result(readSendGate(rt.db, options.workspace));
    },
  },
  {
    name: 'gate allowlist',
    usage: 'outreach gate allowlist <address|@domain>... --reason <why>',
    summary: 'Allow live email only to these recipients (admin).',
    flags: { reason: 'string' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      setSendGate(rt.engine, rt.ctx(), { mode: 'allowlist', allow: [...args] }, required(flags, 'reason'));
      out.result({ mode: 'allowlist', allow: args });
    },
  },
  {
    name: 'gate open',
    usage: 'outreach gate open --reason <decision record, e.g. D1 provider + legal sign-off>',
    summary: 'Allow live email to any eligible recipient (admin, audited).',
    flags: { reason: 'string' },
    async run({ flags, out, runtime }) {
      const rt = await runtime();
      setSendGate(rt.engine, rt.ctx(), { mode: 'open' }, required(flags, 'reason'));
      out.result({ mode: 'open' });
    },
  },
  {
    name: 'jurisdiction show',
    usage: 'outreach jurisdiction show',
    summary: 'Show where email may go and who signed that off (decision D5).',
    async run({ out, runtime, options }) {
      const rt = await runtime();
      rt.ctx();
      out.result(readJurisdictionPolicy(rt.db, options.workspace) ?? { policy: null, note: 'no policy recorded; the live-send gate cannot open' });
    },
  },
  {
    name: 'jurisdiction set',
    usage:
      'outreach jurisdiction set [--allow US,GB] [--consent DE,CA] [--block FR] --default <allow|consent_required|block> ' +
      '--unknown <allow|consent_required|block> --signed-off-by <name> --reference <memo or ticket>',
    summary: 'Record per-country sending rules and their legal sign-off (admin, audited). Replaces the whole policy.',
    flags: { allow: 'string', consent: 'string', block: 'string', default: 'string', unknown: 'string', 'signed-off-by': 'string', reference: 'string' },
    async run({ flags, out, runtime }) {
      const rt = await runtime();
      const saved = setJurisdictionPolicy(
        rt.engine,
        rt.ctx(),
        { rules: parseRules(flags), default: parseRule(required(flags, 'default'), 'default'), unknown: parseRule(required(flags, 'unknown'), 'unknown') },
        { by: required(flags, 'signed-off-by'), reference: required(flags, 'reference') },
      );
      out.result(saved);
    },
  },
  {
    name: 'notify set',
    usage: 'outreach notify set <provider-account-id> | outreach notify set --off',
    summary: 'Route reply/opt-out/bounce/complaint notices to a notification account.',
    flags: { off: 'boolean' },
    async run({ args, flags, out, runtime }) {
      const rt = await runtime();
      const target = flags.off ? null : arg(args, 0, 'provider-account-id');
      configureNotifications(rt.engine, rt.ctx(), target);
      out.result({ notifyAccountId: target });
    },
  },
  {
    name: 'audit verify',
    usage: 'outreach audit verify',
    summary: 'Recompute the audit hash chain; non-zero exit if it was tampered with.',
    async run({ out, runtime }) {
      const rt = await runtime();
      const result = verifyAuditChain(rt.db);
      out.result(result);
      return result.ok ? 0 : 3;
    },
  },
];
