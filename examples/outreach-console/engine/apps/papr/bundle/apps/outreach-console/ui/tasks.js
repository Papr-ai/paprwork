/* global navigator */
import { $, el, empty, toast } from './dom.js';

export function renderTasks(tasks, act) {
  if (!tasks.length) return empty('tasks', 'No manual touches waiting.');
  $('tasks').replaceChildren(
    ...tasks.map((t) =>
      el(
        'li',
        { class: 'card' },
        el('strong', { text: `${t.channel} touch` }),
        el('pre', { text: t.draft_text }),
        el(
          'div',
          { class: 'row' },
          t.target_url && /^https:\/\//.test(t.target_url) ? el('a', { href: t.target_url, target: '_blank', rel: 'noopener noreferrer', text: 'Open profile' }) : null,
          el('button', { type: 'button', text: 'Copy draft', onclick: () => navigator.clipboard.writeText(t.draft_text).then(() => toast('Draft copied')) }),
          el('button', { type: 'button', class: 'primary', text: 'I did it', onclick: (e) => act(e.currentTarget, 'task-outcome', { taskId: t.id, outcome: 'done' }, 'Recorded') }),
          el('button', { type: 'button', class: 'ghost', text: 'Skip', onclick: (e) => act(e.currentTarget, 'task-outcome', { taskId: t.id, outcome: 'skipped' }, 'Skipped') }),
        ),
      ),
    ),
  );
}
