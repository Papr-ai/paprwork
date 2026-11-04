/* Waiting on (what you asked others) and the wiring for both sections: clicks, drafts, feed, toasts. */
const Waiting = {
  ago(iso) {
    if (!iso) return '';
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  },
  /** One line like the Focus proposal: who · what · due, then state and their latest word. Click to open the
      thread right there (reply, nudge, close, open chat). */
  row(w) {
    const N = Needs, e = (s) => N.esc(s), name = N.first(w.toName), prog = w.state === 'in_progress', id = e(w.id), open = N.wopen === w.id || N.writing === w.id;
    const due = (w.promised ? ` · ${w.late ? 'was due' : 'due'} ${e(w.promised)}` : w.due ? ` · due ${e(w.due)}` : '') + (w.blocks ? ` · blocks ${e(w.blocks)}` : '');
    const said = w.reply ? `${e(name)}: \u201c${e(w.reply)}\u201d` : !prog ? `asked ${this.ago(w.at)} · no reply yet` : '';
    const sub = `<span class="${w.late ? 'is-late' : ''}">${prog ? 'In progress' : 'Asked'}${said ? ` · ${said}` : ''}</span>`;
    const line = `<button type="button" class="hwait-line" data-need="wopen" data-id="${id}" aria-expanded="${open}"><span class="hwait-who">${e(name)}</span><b>${e(w.title)}${due}</b>${sub}</button>`;
    if (!open) return `<div class="hwait-row">${line}</div>`;
    const nudged = w.nudgedAt && Date.now() - Date.parse(w.nudgedAt) < 6 * 3600e3, busy = N.busy === w.id;
    const q = w.reply ? `<q class="hwait-q">${e(w.reply)}<small>${e(name)} · ${this.ago(w.replyAt)}</small></q>` : '';
    const mine = w.mine && (!w.replyAt || w.mine.at > w.replyAt) ? `<q class="hwait-q is-mine">${e(w.mine.text)}<small>You · ${this.ago(w.mine.at)}</small></q>` : '';
    const acts = N.writing === w.id
      ? `<label class="hdraft"><textarea rows="2" data-wtext="${id}" placeholder="Write to ${e(name)}">${e(N.drafts['w:' + w.id] || '')}</textarea></label>
        <div class="t3btns"><button type="button" class="t3save" data-need="wsend" data-id="${id}"${busy ? ' disabled' : ''}>${busy ? 'Sending…' : `Send to ${e(name)}`}</button>
        <button type="button" class="t3cancel" data-need="wcancel">Cancel</button></div>`
      : `<div class="hwait-acts"><button type="button" class="t3link" data-need="wreply" data-id="${id}">Reply</button>
        ${!prog || w.late ? `<button type="button" class="t3link" data-need="nudge" data-id="${id}" data-name="${e(name)}"${nudged || busy ? ' disabled' : ''}>${nudged ? 'Nudged' : 'Nudge'}</button>` : ''}
        <button type="button" class="t3link" data-need="close" data-id="${id}" title="Tell ${e(name)} you don't need it anymore">Close</button>
        ${w.chatId ? `<button type="button" class="t3link" data-need="chat" data-chat="${e(w.chatId)}" data-title="${e(w.chatTitle || 'Chat')}">Open chat</button>` : ''}</div>`;
    return `<div class="hwait-row is-open">${line}<div class="hwait-more">${q}${mine}${N.errors[w.id] ? `<p class="hneed-err" role="alert">${e(N.errors[w.id])}</p>` : ''}${acts}</div></div>`;
  },
  html() {
    const rows = Needs.feed?.waiting || [];
    if (!rows.length) return '';
    return `<section class="hsec hwait"><h4>Waiting on <em>${rows.length}</em></h4>${rows.map((w) => this.row(w)).join('')}</section>`;
  },
  /** Proof, not noise: one quiet line you can open. What cleared today before you had to touch it. */
  handled() {
    const h = Needs.feed?.handled || [], e = (s) => Needs.esc(s);
    if (!h.length) return '';
    const open = Needs.hopen;
    return `<section class="hsec hhandled"><button type="button" class="hhandled-line" data-need="hopen" aria-expanded="${!!open}"><span>Pen handled ${h.length} without you</span><em>${open ? 'Hide' : 'Show'}</em></button>
      ${open ? h.map((i) => `<p class="hhandled-row"><b>${e(i.from)}</b>${e(i.title)}</p>`).join('') : ''}</section>`;
  },
};

(function wireNeeds() {
  if (window.parent === window) return; // opened on its own: no Papr Work, no feed
  const N = Needs;
  const flash = (t) => { N.toast = t; N.paint(); if (t) setTimeout(() => { if (N.toast === t) { N.toast = null; N.paint(); } }, 6000); };
  const run = async (key, op, args, after) => {
    N.busy = key; delete N.errors[key]; N.paint();
    const r = await N.act(op, args);
    N.busy = null;
    if (!r.ok) N.errors[key] = r.error || "Couldn't send. Try again.";
    else if (after) after();
    if (r.toast) flash(r.toast); else N.paint();
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (m?.type === 'papr-focus-feed') { N.feed = m.feed; N.paint(); }
    if (m?.type === 'papr-focus-ack' && N.wait[m.id]) { N.wait[m.id](m); delete N.wait[m.id]; }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset?.draft) N.drafts[t.dataset.draft] = t.value;
    if (t.dataset?.wtext) N.drafts['w:' + t.dataset.wtext] = t.value;
  });
  document.addEventListener('focusout', () => setTimeout(() => { if (N.dirty && !document.activeElement?.closest?.('#needs, #alsoneeds, #waiting')) { N.dirty = false; N.paint(); } }, 0));
  document.addEventListener('mousedown', (e) => { if (N.open && !e.target.closest('.hmenu')) { N.open = null; N.paint(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && N.open) { N.open = null; N.paint(); } });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-need]');
    if (!b || b.disabled) return;
    e.stopPropagation();
    const op = b.dataset.need, key = b.dataset.key, item = N.feed?.needs.find((i) => i.key === key), id = b.dataset.id;
    if (op !== 'menu') N.open = null;
    switch (op) {
      case 'menu': N.open = N.open === key ? null : key; return N.paint();
      case 'more': N.more = !N.more; return N.paint();
      case 'hopen': N.hopen = !N.hopen; return N.paint();
      case 'undo': { const u = N.toast?.undo; N.toast = null; N.paint(); if (u) N.act(u.op, u.args); return; }
      case 'answer': {
        const m = item?.mention; if (!m) return;
        const d = (N.drafts[m.itemId] ?? m.draft).trim(), status = b.dataset.status;
        const reply = status === 'open' ? d : status === 'dismissed' && d && d !== m.draft ? d : undefined;
        if (status === 'open' && !reply) return;
        return run(key, 'answer', { itemId: m.itemId, status, reply });
      }
      case 'wopen': N.wopen = N.wopen === id ? null : id; if (N.writing && N.writing !== N.wopen) N.writing = null; return N.paint();
      case 'wreply': N.writing = id; N.paint(); return document.querySelector(`[data-wtext="${CSS.escape(id)}"]`)?.focus();
      case 'wcancel': N.writing = null; return N.paint();
      case 'wsend': { const t = (N.drafts['w:' + id] || '').trim(); if (!t) return; return run(id, 'followup', { itemId: id, kind: 'reply', text: t }, () => { N.writing = null; delete N.drafts['w:' + id]; }); }
      case 'nudge': return run(id, 'followup', { itemId: id, kind: 'nudge', name: b.dataset.name });
      case 'close': return run(id, 'followup', { itemId: id, kind: 'close' });
      case 'chat': return N.act('chat', { chatId: b.dataset.chat, title: b.dataset.title });
      case 'unmute': return N.act('unmute', { sourceId: b.dataset.src });
      case 'focus': return run(key, 'focus', { key, mode: b.dataset.mode });
      case 'later': case 'mute': return run(key, op, { key });
      default: return N.act(op, { key });
    }
  }, true);
  window.parent.postMessage({ type: 'papr-focus-ready' }, '*');
})();
