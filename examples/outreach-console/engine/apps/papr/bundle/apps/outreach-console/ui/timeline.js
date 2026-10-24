import { $, el, empty } from './dom.js';

const HOLDS = {
  approval: ['hold', 'needs approval'],
  outside_send_window: ['hold', 'outside send window'],
  campaign_paused: ['stop', 'campaign paused'],
  enrollment_paused: ['stop', 'contact paused'],
  recipient_min_gap: ['hold', 'spacing out touches'],
};

function chipFor(action) {
  const reason = action.waitingOn || '';
  if (action.state === 'executing' || action.state === 'claimed') return el('span', { class: 'chip ready', text: 'sending now' });
  if (!reason) return el('span', { class: 'chip ready', text: 'ready' });
  if (reason.startsWith('kill_switch')) return el('span', { class: 'chip stop', text: 'kill switch' });
  if (reason.startsWith('rate_limit')) return el('span', { class: 'chip hold', text: 'daily limit' });
  if (reason.startsWith('account_')) return el('span', { class: 'chip stop', text: 'account needs attention' });
  const [tone, label] = HOLDS[reason] || ['hold', reason.replace(/_/g, ' ')];
  return el('span', { class: `chip ${tone}`, text: label });
}

export function renderTimeline(actions, act) {
  if (!actions.length) return empty('timeline', 'Nothing is scheduled to go out in the next 24 hours.');
  const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  $('timeline').replaceChildren(
    ...actions.map((a) =>
      el(
        'li',
        { class: 'slot' },
        el('time', { datetime: new Date(a.dueAt).toISOString(), text: a.dueAt <= Date.now() ? 'now' : fmt.format(a.dueAt) }),
        el('div', {}, el('div', { class: 'who', text: a.recipient || a.kind }, chipFor(a)), el('div', { class: 'what', text: `${a.subject || a.kind} · ${a.campaignName || 'no campaign'}` })),
        a.campaignId
          ? el('button', { type: 'button', class: 'ghost', onclick: (e) => act(e.currentTarget, 'campaign-pause', { campaignId: a.campaignId, reason: 'paused from Outreach Console' }, 'Campaign paused'), text: 'Pause campaign' })
          : null,
      ),
    ),
  );
}
