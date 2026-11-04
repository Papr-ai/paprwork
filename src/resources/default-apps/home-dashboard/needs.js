/* Needs you + Waiting on, inside the brief. Papr Work feeds the list (papr-focus-feed) and runs every
   action (papr-focus-act → papr-focus-ack); this file only draws it with the brief's own styles.
   Needs you takes the "Do this first" slot; Waiting on sits under Your three. Outside Papr Work: nothing. */
const Needs = {
  feed: null, more: false, open: null, drafts: {}, writing: null, busy: null, errors: {}, toast: null, seq: 0, wait: {},
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  has() { return !!this.feed?.needs?.length; },
  first(n) { return String(n || '').split(/\s+/)[0] || n; },
  ini(n) { return String(n || '?').replace(/[@+].*$/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'; },
  /** A person is always a pill: initials + name. */
  pill(name) { return `<span class="hpill" title="${this.esc(name)}"><i>${this.esc(this.ini(name))}</i>${this.esc(name)}</span>`; },
  /** "@amir+1 knows the copy" → the @name as a pill. Known full names first, then one token. */
  pills(text) {
    const names = (this.feed?.people || []).slice().sort((a, b) => b.length - a.length);
    let out = this.esc(text);
    const hit = (n) => out.includes('@' + this.esc(n));
    names.filter(hit).forEach((n) => { out = out.split('@' + this.esc(n)).join(`\u0000${n}\u0001`); });
    out = out.replace(/(^|\s)@([\p{L}\p{N}._+-]+)/gu, (_, sp, n) => `${sp}\u0000${n}\u0001`);
    return out.replace(/\u0000([^\u0001]*)\u0001/g, (_, n) => this.pill(n.replace(/&amp;/g, '&')));
  },
  act(op, args = {}) {
    const id = `a${++this.seq}`;
    window.parent.postMessage({ type: 'papr-focus-act', id, op, args }, '*');
    return new Promise((res) => { this.wait[id] = res; setTimeout(() => { if (this.wait[id]) { delete this.wait[id]; res({ ok: false, error: 'Papr Work did not answer. Try again.' }); } }, 20000); });
  },
  menu(i) {
    const m = i.menu, k = this.esc(i.key), b = (op, l, sub, extra = '') => `<button type="button" role="menuitem" data-need="${op}" data-key="${k}"${extra}>${l}${sub ? `<em>${sub}</em>` : ''}</button>`;
    const body = i.urgent ? `<p>Always on: this reaches you until it's fixed.</p>` : b('later', 'Later', `Back ${this.esc(m.laterWhen)}`)
      + b('mute', `Mute ${this.esc(m.source)} for 1 hour`, 'No desktop notifications, out of this list')
      + (m.focus ? b('focus', `Always show ${this.esc(m.source)} in Focus`, 'Right away, without waiting for Pen', ' data-mode="always"')
        + b('focus', `Keep ${this.esc(m.source)} off Focus`, `Stays as a dot on ${this.esc(m.source)}`, ' data-mode="never"') : '')
      + b('turnoff', `Turn off ${this.esc(m.type)}`, '');
    return `<div class="hmenu"><button type="button" class="hmenu-dots" data-need="menu" data-key="${k}" aria-label="Options" aria-expanded="${this.open === i.key}">&hellip;</button>
      ${this.open === i.key ? `<div class="hmenu-pop" role="menu">${body}<button type="button" role="menuitem" class="is-link" data-need="settings" data-key="${k}">${this.esc(m.source)} notification settings</button></div>` : ''}</div>`;
  },
  hero(i) {
    const m = i.mention, k = this.esc(i.key), busy = this.busy === i.key, err = this.errors[i.key];
    const label = i.urgent ? "You're blocked" : m?.took ? 'In progress' : m ? 'Asked of you' : 'Do this first';
    const who = m ? `${this.pill(i.from)}<span>${m.took ? '' : 'asked you'}${m.when ? ` · ${this.esc(m.when)}` : ''}</span>` : `<span>${this.esc(i.from)}${i.reason ? ` · ${this.esc(i.reason)}` : ''}</span>`;
    let body = !m?.took && i.body ? `<p>${m ? this.pills(i.body) : this.esc(i.body)}</p>` : '';
    let acts;
    if (m && m.took) acts = `<button type="button" class="t3save" data-need="answer" data-status="done" data-key="${k}"${busy ? ' disabled' : ''}>Done</button>
      <button type="button" class="t3cancel" data-need="answer" data-status="dismissed" data-key="${k}"${busy ? ' disabled' : ''}>Can't</button>`;
    else if (m) {
      const d = this.drafts[m.itemId] ?? m.draft;
      body += m.ready ? `<label class="hdraft"><small>Pen drafted your reply</small><textarea rows="2" data-draft="${this.esc(m.itemId)}">${this.esc(d)}</textarea></label>` : '';
      acts = `<button type="button" class="t3save" data-need="answer" data-status="open" data-key="${k}"${busy || !m.ready ? ' disabled' : ''}>${busy ? 'Sending…' : "I'm on it"}</button>
        <button type="button" class="t3cancel" data-need="answer" data-status="dismissed" data-key="${k}"${busy || !m.ready ? ' disabled' : ''}>Can't</button>
        <button type="button" class="t3cancel" data-need="later" data-key="${k}">Later</button>`;
    } else acts = `<button type="button" class="t3save" data-need="open" data-key="${k}">${this.esc(i.action)}</button>`;
    if (m) acts += `<button type="button" class="t3cancel" data-need="open" data-key="${k}">Open chat</button>`;
    return `<div class="hneed${i.urgent ? ' is-urgent' : ''}"><header><small>${label}</small><span class="hneed-from">${who}</span>${this.menu(i)}</header>
      <b class="hneed-t">${this.esc(i.title)}</b>${body}${err ? `<p class="hneed-err" role="alert">${this.esc(err)}</p>` : ''}<div class="t3btns">${acts}</div></div>`;
  },
  row(i) {
    const k = this.esc(i.key), from = i.mention ? this.pill(i.from) : this.esc(i.from);
    return `<div class="hrow hneed-row"><i class="hneed-dot" aria-hidden="true"></i><span class="hrt"><b>${this.esc(i.title)}</b><span>${from}${i.reason ? ` · ${this.esc(i.reason)}` : ''}</span></span>
      <button type="button" class="t3link" data-need="open" data-key="${k}">${this.esc(i.mention ? 'Reply' : i.action)}</button>${this.menu(i)}</div>`;
  },
  needsHtml() {
    const f = this.feed;
    if (!f) return '';
    const [first, ...rest] = f.needs, vis = this.more ? rest : rest.slice(0, 3);
    const also = rest.length ? `<section class="hsec"><h4>Also needs you <em>${rest.length}</em></h4>${vis.map((i) => this.row(i)).join('')}
      ${rest.length > 3 ? `<button type="button" class="t3link hneed-more" data-need="more">${this.more ? 'Show less' : `Show ${rest.length - 3} more`}</button>` : ''}</section>` : '';
    const muted = f.muted.map((m) => `<p class="hneed-note"><span>${this.esc(m.name)} muted until ${this.esc(m.until)}. Dots still show on the things.</span><button type="button" class="t3link" data-need="unmute" data-src="${this.esc(m.id)}">Unmute</button></p>`).join('');
    const later = f.later.length ? `<section class="hsec"><h4>Later <em>${f.later.length}</em></h4>${f.later.map((l) => `<div class="hrow"><span class="hrt"><b>${this.esc(l.title)}</b><span>Back ${this.esc(l.when)}</span></span>
      <button type="button" class="t3link" data-need="unlater" data-key="${this.esc(l.key)}">Bring back now</button></div>`).join('')}</section>` : '';
    const top = first ? `<section class="hsec hneeds"><h4>Needs you <em>${f.needs.length}</em></h4>${this.hero(first)}</section>` : '';
    return top + also + muted + later;
  },
  paint() {
    const n = document.getElementById('needs'), w = document.getElementById('waiting');
    if (!n || !w) return;
    const today = typeof App === 'undefined' || App.idx === 0;
    const a = document.activeElement;
    if (a && a.tagName === 'TEXTAREA' && (n.contains(a) || w.contains(a))) { this.dirty = true; return; }
    n.innerHTML = today ? this.needsHtml() : '';
    w.innerHTML = today && typeof Waiting !== 'undefined' ? Waiting.html() : '';
    const t = document.getElementById('hneed-toast');
    if (t) t.remove();
    if (this.toast) document.body.insertAdjacentHTML('beforeend', `<div id="hneed-toast" class="hneed-toast" role="status"><span>${this.esc(this.toast.text)}</span>${this.toast.undo ? '<button type="button" data-need="undo">Undo</button>' : ''}</div>`);
  },
};
