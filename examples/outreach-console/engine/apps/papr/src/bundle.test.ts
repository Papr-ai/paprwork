import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addContact,
  addPrincipal,
  authenticate,
  bootstrapWorkspace,
  commitActivation,
  createApiToken,
  createCampaign,
  createEngine,
  createTemplate,
  prepareActivation,
  registerProviderAccount,
} from '@splitin/outreach-core';
import { FAKE_EMAIL_SECRET, FakeEmailProvider, staticSecrets } from '@splitin/outreach-fakes';
import { createApp, startServer } from '@splitin/outreach-server';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';

const bundle = resolve(dirname(fileURLToPath(import.meta.url)), '../bundle');
const read = (path: string) => readFileSync(join(bundle, path), 'utf8');

// Local contract assertions, not a replacement for the exact upstream schema or host validation.
// Pinned upstream provenance and unresolved runtime acceptance live in ../compatibility.json.
const PaprManifest = z.object({
  schemaVersion: z.literal('1.0.0'),
  bundleId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  createdAt: z.string().min(1),
  minPaprworkVersion: z.string().min(1),
  requirements: z.array(z.object({ name: z.string().min(1), service: z.string().min(1), clientAccess: z.enum(['server', 'client']) })),
  app: z.object({ id: z.string().min(1), name: z.string().min(1), version: z.string().min(1), entryFile: z.string().min(1), appPath: z.string().min(1) }),
  jobs: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), type: z.enum(['python', 'node', 'swift', 'bash', 'agent']), entryPoint: z.string().optional(), appIds: z.array(z.string()) })),
  deploymentProfiles: z.array(z.object({ id: z.string(), name: z.string(), runtimeTarget: z.enum(['local', 'cloud', 'hybrid']) })),
});

function browserSources(dir = 'apps/outreach-console'): Array<{ path: string; content: string }> {
  return readdirSync(join(bundle, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.name === 'backend') return [];
    if (entry.isDirectory()) return browserSources(path);
    return /\.(js|html|css)$/.test(entry.name) ? [{ path, content: read(path) }] : [];
  });
}

describe('bundle structure', () => {
  const manifest = PaprManifest.parse(JSON.parse(read('manifest.json')));

  it('matches the Papr manifest contract and points at real files', () => {
    expect(existsSync(join(bundle, manifest.app.appPath, manifest.app.entryFile))).toBe(true);
    for (const job of manifest.jobs) {
      expect(job.appIds).toContain(manifest.app.id);
      expect(existsSync(join(bundle, 'jobs', job.id, job.entryPoint ?? ''))).toBe(true);
    }
  });

  it('keeps the API token server-side and every backend action wired to a declared key', () => {
    const backend = JSON.parse(read(`${manifest.app.appPath}/backend/manifest.json`)) as { version: number; actions: Record<string, { handler: string; runtime: string; keys: string[] }> };
    const declared = new Set(manifest.requirements.map((r) => r.name));
    expect(manifest.requirements.every((r) => r.clientAccess === 'server')).toBe(true);
    for (const [name, action] of Object.entries(backend.actions)) {
      expect(action.runtime, name).toBe('node');
      expect(existsSync(join(bundle, manifest.app.appPath, 'backend', action.handler)), name).toBe(true);
      for (const key of action.keys) expect(declared.has(key), `${name}:${key}`).toBe(true);
    }
    // The browser never fetches credentials and never injects HTML; only the handler sees the token.
    for (const source of browserSources()) expect(source.content).not.toMatch(/api\/credentials|process\.env|innerHTML|insertAdjacentHTML/);
  });

  it('ships JavaScript that parses', () => {
    for (const file of [...browserSources().filter((f) => f.path.endsWith('.js')).map((f) => f.path), `${manifest.app.appPath}/backend/outreach.mjs`, 'jobs/outreach-worker/code/run.mjs']) {
      expect(spawnSync(process.execPath, ['--check', join(bundle, file)]).status, file).toBe(0);
    }
  });
});

describe('backend handler against a live engine API', () => {
  const PLAYBOOK = `
apiVersion: outreach.splitin.net/v1alpha1
kind: Playbook
metadata: { name: papr-demo }
spec:
  purpose: automated_outreach
  policy: { unsubscribe: reply, window: { days: [Mon, Tue, Wed, Thu, Fri, Sat, Sun], start: "00:00", end: "23:59" } }
  steps: [{ id: intro, type: email.send, template: intro@1 }]
`;
  let url = '';
  let approverToken = '';
  let viewerToken = '';
  let close: () => void = () => {};
  type Handle = (action: string, params?: Record<string, string>) => Promise<{ ok: boolean; data?: Record<string, never>; error?: string; status?: number }>;
  let handle: Handle;

  beforeAll(async () => {
    const db = openSqliteDatabase(':memory:');
    const engine = createEngine({ db, adapters: [new FakeEmailProvider().adapter()], secrets: staticSecrets({ 'env:MAIL': FAKE_EMAIL_SECRET }), workerId: 'papr-test', sendGate: { mode: 'open' } });
    bootstrapWorkspace(db, { workspaceId: 'ws', name: 'W', adminRef: 'cli:admin', adminName: 'Admin' });
    const admin = authenticate(db, 'ws', 'cli:admin', 'cli', 't');
    const approverId = addPrincipal(engine, admin, { externalRef: 'papr:console', displayName: 'Console', roles: ['approver'] });
    approverToken = createApiToken(engine, admin, { principalId: approverId, name: 'console', roleCeiling: 'approver', ttlDays: 7 }).token;
    viewerToken = createApiToken(engine, admin, { principalId: approverId, name: 'wall', roleCeiling: 'viewer', ttlDays: 7 }).token;
    const account = await registerProviderAccount(engine, admin, { provider: 'fake-email', externalAccountId: 'x', purposes: ['automated_outreach'], secretRef: 'env:MAIL', sender: { name: 'Sam', address: 'sam@example.com', postalAddress: '1 Example St' } });
    createTemplate(db, admin, { name: 'intro', channel: 'email', subject: 'Hi {{first_name}}', text: 'Hello {{first_name}}' }, Date.now());
    addContact(engine, admin, { fullName: 'Ada Lovelace', firstName: 'Ada', email: 'ada@example.org', consentBasis: 'legitimate_interest' });
    const { campaignId } = createCampaign(engine, admin, { name: 'Papr demo', playbook: PLAYBOOK, providerAccountId: account });
    const preview = prepareActivation(engine, admin, campaignId);
    // Leave the campaign-version approval pending so the console has something to show.
    expect(preview.requiresApproval).toBe(true);
    expect(() => commitActivation(engine, admin, { campaignId, operationHash: preview.operationHash })).toThrow();
    const started = await startServer(createApp({ engine }), { port: 0 });
    url = started.url;
    close = () => started.server.close();
    ({ handle } = (await import(join(bundle, 'apps/outreach-console/backend/outreach.mjs'))) as { handle: Handle });
  });
  afterAll(() => close());

  const withEnv = async <T>(token: string, run: () => Promise<T>): Promise<T> => {
    process.env.OUTREACH_API_URL = url;
    process.env.OUTREACH_API_TOKEN = token;
    try {
      return await run();
    } finally {
      delete process.env.OUTREACH_API_URL;
      delete process.env.OUTREACH_API_TOKEN;
    }
  };

  it('returns the overview the console renders', async () => {
    const result = await withEnv(approverToken, () => handle('overview'));
    expect(result.ok).toBe(true);
    expect(Object.keys(result.data ?? {}).sort()).toEqual(['approvals', 'campaigns', 'review', 'statuses', 'tasks', 'upcoming']);
    expect((result.data as unknown as { approvals: unknown[] }).approvals).toHaveLength(1);
  });

  it('validates inputs before calling the API and allowlists actions', async () => {
    expect(await withEnv(approverToken, () => handle('approval-decide', { approvalId: '../../v1/kill-switches', decision: 'approved', operationHash: 'x' }))).toEqual({ ok: false, error: 'invalid or missing approvalId' });
    expect(await withEnv(approverToken, () => handle('delete-everything'))).toEqual({ ok: false, error: 'unknown action delete-everything' });
    expect((await handle('overview')).error).toMatch(/OUTREACH_API_URL and OUTREACH_API_TOKEN/);
  });

  it('passes the engine’s authorization through (viewer tokens cannot stop sending)', async () => {
    const result = await withEnv(viewerToken, () => handle('kill-switch', { scope: 'workspace', engaged: 'true', reason: 'test' }));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('speaks the Papr backend contract as a subprocess (PAPR_ACTION in, one JSON line out)', () => {
    const run = spawnSync(process.execPath, [join(bundle, 'apps/outreach-console/backend/outreach.mjs')], {
      env: { ...process.env, PAPR_ACTION: 'task-outcome', PAPR_ACTION_PARAMS: JSON.stringify({ taskId: 'bad', outcome: 'done' }), OUTREACH_API_URL: url, OUTREACH_API_TOKEN: approverToken },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({ ok: false, error: 'invalid or missing taskId' });
  });
});
