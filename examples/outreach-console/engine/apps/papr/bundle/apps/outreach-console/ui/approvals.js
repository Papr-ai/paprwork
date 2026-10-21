import { $, el, empty } from './dom.js';

export function renderApprovals(approvals, act) {
  if (!approvals.length) return empty('approvals', 'No approvals waiting.');
  $('approvals').replaceChildren(
    ...approvals.map((a) => {
      const items = (a.preview && a.preview.actions) || [];
      const summary = a.scope === 'campaign_version'
        ? `Activate "${a.preview.campaign}" for ${a.preview.audienceCount} people`
        : `${items.length} message${items.length === 1 ? '' : 's'}`;
      return el(
        'li',
        { class: 'card' },
        el('strong', { text: summary }),
        items.length ? el('pre', { text: items.slice(0, 5).map((i) => `${i.recipient} — ${i.subject || ''}`).join('\n') + (items.length > 5 ? `\n… and ${items.length - 5} more` : '') }) : null,
        el('div', { class: 'meta', text: `hash ${a.operation_hash.slice(0, 12)}… · expires ${new Date(a.expires_at).toLocaleString()}` }),
        el(
          'div',
          { class: 'row' },
          el('button', { type: 'button', class: 'primary', text: 'Approve exactly this', onclick: (e) => act(e.currentTarget, 'approval-decide', { approvalId: a.id, decision: 'approved', operationHash: a.operation_hash }, 'Approved') }),
          el('button', { type: 'button', text: 'Reject', onclick: (e) => act(e.currentTarget, 'approval-decide', { approvalId: a.id, decision: 'rejected', operationHash: a.operation_hash, reason: 'rejected in Outreach Console' }, 'Rejected') }),
        ),
      );
    }),
  );
}
