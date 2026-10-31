import { $, el, empty } from './dom.js';
import { askText } from './dialog.js';

export function renderReview(actions, act) {
  if (!actions.length) return empty('review', 'Nothing needs a human right now.');
  $('review').replaceChildren(
    ...actions.map((a) =>
      el(
        'li',
        { class: 'card' },
        el('strong', { text: a.recipient_norm || a.kind }),
        el('div', { class: 'meta', text: `${(a.state_reason || '').replace(/_/g, ' ')} · ${a.attempt_count} attempt(s)` }),
        el(
          'div',
          { class: 'row' },
          el('button', { type: 'button', text: 'It went out', onclick: async (e) => {
            const button = e.currentTarget;
            const id = await askText('Provider message id from your sent folder (required to record it as sent):');
            if (id) act(button, 'review-resolve', { actionId: a.id, kind: 'sent', providerMessageId: id }, 'Recorded as sent');
          } }),
          el('button', { type: 'button', text: 'Not sent — send it', onclick: (e) => act(e.currentTarget, 'review-resolve', { actionId: a.id, kind: 'not_sent_retry' }, 'Rescheduled') }),
          el('button', { type: 'button', class: 'ghost', text: 'Drop', onclick: (e) => act(e.currentTarget, 'review-resolve', { actionId: a.id, kind: 'drop', reason: 'dropped in Outreach Console' }, 'Dropped') }),
        ),
      ),
    ),
  );
}
