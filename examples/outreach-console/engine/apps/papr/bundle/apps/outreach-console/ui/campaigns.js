import { $, el, empty } from './dom.js';

const COLORS = { active: 'var(--accent)', completed: 'var(--ok)', replied: 'var(--ok)', paused: 'var(--hold)', opted_out: 'var(--muted)', bounced: 'var(--stop)', stopped: 'var(--muted)', error: 'var(--stop)' };

export function renderCampaigns(campaigns, statuses, act) {
  if (!campaigns.length) return empty('campaigns', 'No campaigns yet. Create one with `outreach campaign create`.');
  const byId = new Map(statuses.map((s) => [s.campaignId, s]));
  $('campaigns').replaceChildren(
    ...campaigns.map((c) => {
      const counts = (byId.get(c.id) || {}).enrollments || {};
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0) || 1;
      return el(
        'li',
        { class: 'campaign' },
        el('strong', { text: c.name }),
        el('div', { class: 'meta', text: `${c.status} · ${Object.entries(counts).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(' · ') || 'no enrollments'}` }),
        el('div', { class: 'bars' }, ...Object.entries(counts).map(([k, n]) => el('span', { style: `width:${(n / total) * 100}%;background:${COLORS[k] || 'var(--muted)'}` }))),
        c.status === 'paused'
          ? el('button', { type: 'button', text: 'Resume', onclick: (e) => act(e.currentTarget, 'campaign-resume', { campaignId: c.id, reason: 'resumed from Outreach Console' }, 'Resumed') })
          : null,
      );
    }),
  );
}
