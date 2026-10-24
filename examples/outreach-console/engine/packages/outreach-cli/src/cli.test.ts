import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from './main';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'outreach-cli-'));
  dirs.push(dir);
  const env = { OUTREACH_PRINCIPAL: 'cli:tester', OUTREACH_DB: join(dir, 'outreach.db'), OUTREACH_WORKSPACE: 'demo' };
  const file = (name: string, content: string) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };
  const run = async (...argv: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await main(argv, { env, write: (t) => { stdout += t; }, writeError: (t) => { stderr += t; } });
    return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
  };
  return { dir, env, file, run };
}

describe('outreach CLI', () => {
  it('runs setup -> import -> campaign -> worker -> audit with fake providers', async () => {
    const w = workspace();
    expect((await w.run('init', '--fake', '--json')).json()).toMatchObject({ workspace: 'demo', created: true, admin: 'cli:tester' });
    expect((await w.run('init', '--fake', '--json')).json()).toMatchObject({ created: false });
    const account = await w.run('account', 'add', '--fake', '--json', '--provider', 'fake-email', '--external-id', 'hello@example.com', '--sender-name', 'Sam',
      '--sender-email', 'hello@example.com', '--org', 'Example Co', '--postal', '1 Example St', '--purposes', 'automated_outreach', '--secret', 'env:MAIL');
    expect(account.code).toBe(0);
    const accountId = account.json().providerAccountId as string;
    expect((await w.run('gate', 'show', '--json')).json()).toEqual({ mode: 'allowlist', allow: [] });
    expect((await w.run('gate', 'allowlist', '@example.org', '--reason', 'pilot with our own addresses')).code).toBe(0);

    const profile = await w.run('profile', 'add', 'crm', w.file('profile.json', JSON.stringify({ columns: { email: 'Email', full_name: 'Name' }, consent: { basis: 'legitimate_interest' } })), '--json');
    const preview = await w.run('import', 'preview', w.file('leads.csv', 'Name,Email\nAda Lovelace,ada@example.org\nBad,nope\n'), '--profile', profile.json().profileId as string, '--json');
    const previewBody = preview.json();
    expect(previewBody.counts).toMatchObject({ create: 1, reject: 1 });
    const commit = await w.run('import', 'commit', previewBody.batchId as string, '--hash', previewBody.previewHash as string, '--key', 'k1', '--json');
    expect(commit.json()).toMatchObject({ created: 1 });

    await w.run('template', 'add', 'intro', '--channel', 'email', '--subject', 'Hi {{first_name}}', '--text-file', w.file('intro.txt', 'Hello {{first_name}}'));
    const playbook = w.file('playbook.yaml', `
apiVersion: outreach.splitin.net/v1alpha1
kind: Playbook
metadata: { name: cli-intro }
spec:
  purpose: automated_outreach
  policy: { approval: none, unsubscribe: reply, window: { days: [Mon, Tue, Wed, Thu, Fri, Sat, Sun], start: "00:00", end: "23:59" } }
  steps: [{ id: intro, type: email.send, template: intro@1 }]
`);
    expect((await w.run('playbook', 'compile', playbook, '--account', accountId, '--fake', '--json')).json()).toMatchObject({ issues: [] });
    const created = (await w.run('campaign', 'create', 'CLI', '--playbook', playbook, '--account', accountId, '--fake', '--json')).json();
    const prepared = (await w.run('campaign', 'prepare', created.campaignId as string, '--json')).json();
    expect(prepared).toMatchObject({ audienceCount: 1, requiresApproval: false });
    expect((await w.run('campaign', 'activate', created.campaignId as string, '--hash', prepared.operationHash as string, '--json')).json()).toMatchObject({ enrolled: 1 });

    const worker = (await w.run('worker', '--once', '--fake', '--json')).json() as { execute: { executed: number } };
    expect(worker.execute.executed).toBe(1);
    expect((await w.run('campaign', 'status', created.campaignId as string, '--json')).json()).toMatchObject({ enrollments: { completed: 1 } });
    const audit = await w.run('audit', 'verify', '--json');
    expect(audit.code).toBe(0);
    expect(audit.json()).toMatchObject({ ok: true });
  });

  it('prints help, rejects unknown commands and flags, and reports errors with exit codes', async () => {
    const w = workspace();
    const help = await w.run('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/campaign activate/);
    expect((await w.run('campaign', 'activate', '--help')).stdout).toMatch(/--hash <operation-hash>/);
    expect((await w.run('launch', 'rockets')).code).toBe(2);
    const badFlag = await w.run('campaign', 'list', '--hash', 'x');
    expect(badFlag.code).toBe(2);
    expect(badFlag.stderr).toMatch(/unknown option for "campaign list": --hash/);
    const noWorkspace = await w.run('campaign', 'list');
    expect(noWorkspace.code).toBe(1);
    expect(noWorkspace.stderr).toMatch(/unknown principal cli:tester/);
    await w.run('init');
    const invalid = await w.run('playbook', 'compile', w.file('bad.yaml', 'kind: Nope'), '--account', 'x');
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/Invalid playbook/);
  });

  it('refuses to open the gate without a written reason and issues tokens once', async () => {
    const w = workspace();
    await w.run('init');
    expect((await w.run('gate', 'open', '--reason', 'yolo')).stderr).toMatch(/written reason/);
    expect((await w.run('gate', 'open', '--reason', 'provider chosen, going live')).stderr).toMatch(/jurisdiction policy/);
    expect((await w.run('jurisdiction', 'set', '--allow', 'US,GB', '--consent', 'de', '--block', 'DE', '--default', 'block', '--unknown', 'allow',
      '--signed-off-by', 'Counsel', '--reference', 'LEGAL-12')).stderr).toMatch(/DE is listed under more than one rule/);
    expect((await w.run('jurisdiction', 'set', '--allow', 'US', '--default', 'maybe', '--unknown', 'allow', '--signed-off-by', 'Counsel', '--reference', 'LEGAL-12')).stderr)
      .toMatch(/--default must be one of/);
    const policy = await w.run('jurisdiction', 'set', '--allow', 'US,GB', '--consent', 'DE,CA', '--default', 'block', '--unknown', 'allow',
      '--signed-off-by', 'Counsel', '--reference', 'LEGAL-12 outreach memo', '--json');
    expect(policy.json()).toMatchObject({ rules: { US: 'allow', GB: 'allow', DE: 'consent_required', CA: 'consent_required' }, default: 'block', signoff: { by: 'Counsel' } });
    expect((await w.run('jurisdiction', 'show', '--json')).json()).toMatchObject({ unknown: 'allow' });
    expect((await w.run('gate', 'open', '--reason', 'provider chosen, going live')).code).toBe(0);
    await w.run('principal', 'add', 'http:dashboard', '--roles', 'viewer');
    const token = (await w.run('token', 'create', 'http:dashboard', '--name', 'dash', '--json')).json();
    expect(token.token).toMatch(/^oet_[0-9A-Z]{26}\.[A-Za-z0-9_-]{43}$/);
    expect((await w.run('principal', 'add', 'x', '--roles', 'root')).stderr).toMatch(/unknown roles: root/);
  });
});
