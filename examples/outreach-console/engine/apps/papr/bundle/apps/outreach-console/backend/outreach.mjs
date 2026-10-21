// Papr backend handler for the Outreach Console (ADR 0004). Node 18+, no dependencies.
// Maps a FIXED set of action names to FIXED engine API routes. It never forwards arbitrary paths or
// methods, and the API token stays server-side (declared as a manifest key, never sent to the browser).

import { pathToFileURL } from 'node:url';

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HASH = /^[0-9a-f]{64}$/;

class BadInput extends Error {}

function need(params, name, pattern) {
  const value = params[name];
  if (typeof value !== 'string' || value === '' || (pattern && !pattern.test(value))) throw new BadInput(`invalid or missing ${name}`);
  return value;
}

function optional(params, name, max = 500) {
  const value = params[name];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new BadInput(`invalid ${name}`);
  return value;
}

async function api(method, path, body) {
  const base = (process.env.OUTREACH_API_URL ?? '').replace(/\/+$/, '');
  const token = process.env.OUTREACH_API_TOKEN ?? '';
  if (!base || !token) throw new BadInput('OUTREACH_API_URL and OUTREACH_API_TOKEN must be set in Settings → Integration Keys');
  const url = new URL(path, `${base}/`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new BadInput('OUTREACH_API_URL must be http(s)');
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message ?? `engine answered ${res.status}`);
    error.status = res.status;
    error.issues = data.issues;
    throw error;
  }
  return data;
}

const ACTIONS = {
  async overview() {
    const [campaigns, approvals, review, tasks, upcoming] = await Promise.all([
      api('GET', 'v1/campaigns'),
      api('GET', 'v1/approvals'),
      api('GET', 'v1/review'),
      api('GET', 'v1/tasks'),
      api('GET', 'v1/actions/upcoming?hours=24'),
    ]);
    const live = campaigns.campaigns.filter((c) => c.status === 'active' || c.status === 'paused').slice(0, 20);
    const statuses = await Promise.all(live.map((c) => api('GET', `v1/campaigns/${encodeURIComponent(c.id)}`)));
    return { campaigns: campaigns.campaigns, statuses, approvals: approvals.approvals, review: review.actions, tasks: tasks.tasks, upcoming: upcoming.actions };
  },
  'approval-decide': (p) =>
    api('POST', `v1/approvals/${need(p, 'approvalId', ID)}/decide`, {
      decision: need(p, 'decision', /^(approved|rejected)$/),
      operationHash: need(p, 'operationHash', HASH),
      ...(optional(p, 'reason') ? { reason: optional(p, 'reason') } : {}),
    }),
  'task-outcome': (p) =>
    api('POST', `v1/tasks/${need(p, 'taskId', ID)}/outcome`, {
      outcome: need(p, 'outcome', /^(done|skipped)$/),
      ...(optional(p, 'note', 1000) ? { note: optional(p, 'note', 1000) } : {}),
    }),
  'review-resolve': (p) => {
    const kind = need(p, 'kind', /^(sent|not_sent_retry|drop)$/);
    const body = kind === 'sent' ? { kind, providerMessageId: need(p, 'providerMessageId') } : kind === 'drop' ? { kind, reason: need(p, 'reason') } : { kind };
    return api('POST', `v1/review/${need(p, 'actionId', ID)}/resolve`, body);
  },
  'campaign-pause': (p) => api('POST', `v1/campaigns/${need(p, 'campaignId', ID)}/pause`, { reason: need(p, 'reason') }),
  'campaign-resume': (p) => api('POST', `v1/campaigns/${need(p, 'campaignId', ID)}/resume`, { reason: need(p, 'reason') }),
  'kill-switch': (p) =>
    api('POST', 'v1/kill-switches', {
      scope: need(p, 'scope', /^(workspace|provider_account|campaign)$/),
      engaged: need(p, 'engaged', /^(true|false)$/) === 'true',
      reason: need(p, 'reason'),
      ...(optional(p, 'targetId') ? { targetId: need(p, 'targetId', ID) } : {}),
    }),
};

export async function handle(action, params) {
  const run = ACTIONS[action];
  if (!run) return { ok: false, error: `unknown action ${action}` };
  try {
    return { ok: true, data: await run(params ?? {}) };
  } catch (error) {
    return { ok: false, error: error.message, ...(error.status ? { status: error.status } : {}), ...(error.issues ? { issues: error.issues } : {}) };
  }
}

// Run as a Papr backend action: PAPR_ACTION + PAPR_ACTION_PARAMS in, one JSON line on stdout.
if (process.env.PAPR_ACTION && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let params = {};
  try {
    params = JSON.parse(process.env.PAPR_ACTION_PARAMS ?? '{}');
  } catch {
    params = {};
  }
  const result = await handle(process.env.PAPR_ACTION, params);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
