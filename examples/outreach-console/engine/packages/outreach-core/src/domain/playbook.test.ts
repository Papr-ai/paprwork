import { describe, expect, it } from 'vitest';
import { ForbiddenError } from './auth';
import { createCampaign } from './campaigns';
import { compileIssues } from './compile';
import { PLAYBOOK, makeDomainEnv } from './domain.test-util';
import { PlaybookError, parsePlaybook } from './playbook';
import { TemplateRenderError, createTemplate, render } from './templates';

describe('parsePlaybook', () => {
  it('parses YAML and fills policy defaults', () => {
    const playbook = parsePlaybook(`
apiVersion: outreach.splitin.net/v1alpha1
kind: Playbook
metadata: { name: minimal }
spec:
  purpose: automated_outreach
  steps: [{ id: intro, type: email.send, template: intro@1 }]
`);
    expect(playbook.spec.policy).toMatchObject({ approval: 'first_batch_then_campaign', firstBatchSize: 20, unsubscribe: 'link', expireAfter: 'P14D' });
    expect(playbook.spec.policy.window).toMatchObject({ timezone: 'recipient', start: '09:30', end: '16:30' });
    expect(playbook.spec.audience).toEqual({ source: 'all', require: ['email'], eligibility: ['consent_or_legitimate_interest'] });
  });

  it('reports structural errors with paths', () => {
    const bad = PLAYBOOK.replace('duration: P3D', 'duration: three days').replace('start: "09:00"', 'start: "9am"');
    const error = (() => {
      try {
        parsePlaybook(bad);
      } catch (e) {
        return e as PlaybookError;
      }
      throw new Error('expected failure');
    })();
    expect(error).toBeInstanceOf(PlaybookError);
    expect(error.issues.join('\n')).toMatch(/steps\.1\.duration/);
    expect(error.issues.join('\n')).toMatch(/policy\.window\.start/);
  });

  it('rejects social steps that are not manual tasks and unknown fields', () => {
    expect(() => parsePlaybook(PLAYBOOK.replace('type: manual.task, channel: linkedin', 'type: linkedin.connect, channel: linkedin'))).toThrow(PlaybookError);
    expect(() => parsePlaybook(PLAYBOOK.replace('firstBatchSize: 2', 'firstBatchSize: 2\n    stealth: true'))).toThrow(PlaybookError);
  });
});

describe('compileIssues', () => {
  it('passes the reference playbook', async () => {
    const env = await makeDomainEnv();
    expect(compileIssues(env.engine, 'ws', parsePlaybook(PLAYBOOK), env.accountId)).toEqual([]);
  });

  it('finds semantic problems', async () => {
    const env = await makeDomainEnv();
    const playbook = parsePlaybook(PLAYBOOK.replace('purpose: automated_outreach', 'purpose: marketing').replace('template: intro@1', 'template: missing@3'));
    const replyFirst = parsePlaybook(PLAYBOOK.replace('type: email.send, template: intro@1', 'type: email.reply, template: intro@1'));
    const issues = compileIssues(env.engine, 'ws', playbook, env.accountId).join('\n');
    expect(issues).toMatch(/template missing@3 does not exist/);
    expect(issues).toMatch(/purpose marketing is not permitted/);
    expect(compileIssues(env.engine, 'ws', replyFirst, env.accountId).join('\n')).toMatch(/needs an earlier email.send/);
    expect(compileIssues(env.engine, 'ws', parsePlaybook(PLAYBOOK), 'nope')).toEqual(['provider account nope does not exist in this workspace']);
  });

  it('refuses to create campaigns from invalid playbooks or without the operator role', async () => {
    const env = await makeDomainEnv();
    expect(() => createCampaign(env.engine, env.operator, { name: 'x', playbook: PLAYBOOK.replace('intro@1', 'intro@9'), providerAccountId: env.accountId })).toThrow(PlaybookError);
    expect(() => createCampaign(env.engine, env.viewer, { name: 'x', playbook: PLAYBOOK, providerAccountId: env.accountId })).toThrow(ForbiddenError);
  });
});

describe('templates', () => {
  it('render fails closed and escapes HTML', () => {
    expect(render('Hi {{ first_name }}', { first_name: '<b>Ada</b>' }, 'html')).toBe('Hi &lt;b&gt;Ada&lt;/b&gt;');
    expect(render('Hi {{first_name}}', { first_name: 'Ada\r\nBcc: x@example.com' }, 'text')).toBe('Hi Ada Bcc: x@example.com');
    expect(() => render('Hi {{first_name}} at {{org_name}}', { first_name: ' ' }, 'text')).toThrow(TemplateRenderError);
  });

  it('versions immutably and rejects unknown tokens', async () => {
    const env = await makeDomainEnv();
    const v2 = createTemplate(env.engine.db, env.operator, { name: 'intro', channel: 'email', subject: 'Hi', text: 'v2 {{attr.segment}}' }, env.now());
    expect(v2.version).toBe(2);
    expect(() => createTemplate(env.engine.db, env.operator, { name: 'bad', channel: 'email', subject: 'x', text: '{{password}}' }, env.now())).toThrow(/Unknown template tokens: password/);
  });
});
