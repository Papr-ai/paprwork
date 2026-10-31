/* global document */
import { el } from './dom.js';

let active = false;

// A real modal <dialog> stays inside the iframe and supplies browser focus trapping.
// A concurrent request, Escape, Cancel, page hide or unsupported dialog never approves.
function request(message, needsText) {
  if (active) return Promise.resolve(null);
  active = true;
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const dialog = el('dialog', { class: 'decision-dialog', 'aria-labelledby': 'decision-title', 'aria-describedby': 'decision-message' });
    const input = needsText ? el('input', { type: 'text', required: '', maxlength: '500', 'aria-label': 'Provider message ID', autocomplete: 'off' }) : null;
    const cancel = el('button', { type: 'button', text: 'Cancel' });
    const submit = el('button', { type: 'submit', class: needsText ? 'primary' : 'danger', text: needsText ? 'Record message ID' : 'Stop all sending' });
    const form = el('form', {}, el('h2', { id: 'decision-title', text: needsText ? 'Record sent message' : 'Confirm stop' }), el('p', { id: 'decision-message', text: message }), input, el('div', { class: 'row' }, cancel, submit));
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      globalThis.removeEventListener('pagehide', dismiss);
      if (dialog.open) dialog.close();
      dialog.remove();
      active = false;
      const focusTarget = previousFocus?.isConnected ? previousFocus : document.getElementById('refresh');
      focusTarget?.focus();
      resolve(value);
    }
    const dismiss = () => finish(null);
    cancel.addEventListener('click', dismiss);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); dismiss(); });
    dialog.addEventListener('close', dismiss);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input && !input.value.trim()) { input.focus(); return; }
      finish(input ? input.value.trim() : true);
    });
    dialog.append(form);
    document.body.append(dialog);
    globalThis.addEventListener('pagehide', dismiss, { once: true });
    try {
      dialog.showModal();
      (input || cancel).focus();
    } catch {
      dismiss();
    }
  });
}

export function askText(message) { return request(message, true); }
export async function askConfirm(message) { return (await request(message, false)) === true; }
