/* Needs you + Waiting on, inside the brief. Papr Work feeds the list (papr-focus-feed) and runs every
   action (papr-focus-act → papr-focus-ack); this file only draws it with the brief's own styles.
   Order = the Focus proposal: stats, Monday review, Do this first (top need, else the brief's top priority),
   Your three, Also needs you, Waiting on. Outside Papr Work: nothing. */
const Needs = {
  feed: null, more: false, open: null, drafts: {}, writing: null, busy: null, errors: {}, toast: null, seq: 0, wait: {},
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  has() { return !!this.feed?.needs?.length; },
  first(n) { return String(n || '').split(/\s+/)[0] || n; },
  ini(n) { return String(n || '?').replace(/[@+].*$/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'; },
  /** A person is always a pill: photo (initials if none or it fails to load) + name. */
  pill(name) {
    const u = this.feed?.avatars?.[name], ini = this.esc(this.ini(name));
    const face = /^https:\/\//.test(u || '') ? `<i class="has-img"><img src="${this.esc(u)}" alt="" onerror="this.parentNode.classList.remove('has-img');this.remove()">${ini}</i>` : `<i>${ini}</i>`;
    return `<span class="hpill" title="${this.esc(name)}">${face}${this.esc(name)}</span>`;
  },
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
  /** The one "Do this first" slot (the Focus proposal's hero): what it is · who, the ask, Pen's work, one action + Later. */
  hero(i) {
    const m = i.mention, k = this.esc(i.key), busy = this.busy === i.key, err = this.errors[i.key];
    const kind = m?.took ? 'In progress' : m ? 'Asked of you' : '';
    const fromDup = !i.from || String(i.title).includes(String(i.from).replace(/\s*·.*$/, ''));
    const who = m ? `${this.pill(i.from)}${m.when ? `<span>${this.esc(m.when)}</span>` : ''}` : fromDup ? '' : `<span>${this.esc(i.from)}</span>`;
    const g = this.goal(i);
    let body = !m?.took && i.body ? `<p>${m ? this.pills(i.body) : this.esc(i.body)}</p>` : '';
    const P = (op, l, extra = '', dis = false) => `<button type="button" class="hfocus-primary" data-need="${op}" data-key="${k}"${extra}${dis ? ' disabled' : ''}>${l}</button>`;
    const Q = (op, l, extra = '', dis = false) => `<button type="button" class="hfocus-ghost" data-need="${op}" data-key="${k}"${extra}${dis ? ' disabled' : ''}>${l}</button>`;
    let acts;
    if (m && m.took) acts = P('answer', 'Done', ' data-status="done"', busy) + Q('answer', "Can't", ' data-status="dismissed"', busy);
    else if (m) {
      const d = this.drafts[m.itemId] ?? m.draft;
      body += m.ready ? `<label class="hdraft"><small>Pen drafted your reply</small><textarea rows="2" data-draft="${this.esc(m.itemId)}">${this.esc(d)}</textarea></label>` : '';
      acts = P('answer', busy ? 'Sending…' : "I'm on it", ' data-status="open"', busy || !m.ready) + Q('answer', "Can't", ' data-status="dismissed"', busy || !m.ready) + Q('later', 'Later');
    } else acts = P('open', this.esc(i.action)) + (i.urgent ? '' : Q('later', 'Later'));
    if (m) acts += Q('open', 'Open chat');
    return `<section class="hfocus hneed-hero${i.urgent ? ' is-urgent' : ''}"><header><small>${i.urgent ? "You're blocked" : 'Do this first'}</small>${g ? `<em class="hchip" title="Moves ${this.esc(g)}">${this.esc(g)}</em>` : ''}${this.menu(i)}</header>
      <h3>${this.esc(i.title)}</h3>${kind || who ? `<span class="hneed-from"><b>${this.esc(kind)}</b>${who}</span>` : ''}${body}${err ? `<p class="hneed-err" role="alert">${this.esc(err)}</p>` : ''}<div class="hfocus-acts">${acts}</div></section>`;
  },
  /** Which of Your three this moves. Papr Work asks Jev (i.goal: title, or null = none); until it answers,
      shared words between the item and a goal title. */
  goal(i) {
    if (i.goal !== undefined) return i.goal || '';
    const three = typeof Three !== 'undefined' ? Three.data?.three || [] : [];
    const stop = new Set(['the', 'and', 'for', 'with', 'your', 'from', 'this', 'that', 'open', 'page', 'update', 'awaiting']);
    const words = (t) => String(t || '').toLowerCase().replace(/^g\d+\s+/, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3 && !stop.has(w)).map((w) => w.replace(/s$/, ''));
    const have = new Set(words(`${i.title} ${i.body}`));
    let best = null, top = 0;
    for (const g of three) { const n = words(g.title).filter((w) => have.has(w)).length; if (n > top) { top = n; best = g; } }
    return best ? String(best.title).replace(/^G\d+\s+/, '') : '';
  },
  /** Also needs you: the same card as the Focus proposal. What it is · who, the ask, Pen's work, one action + Later. */
  row(i) {
    const k = this.esc(i.key), m = i.mention, pen = typeof AGENT_SVG !== 'undefined' ? `<i class="hpen-mk">${AGENT_SVG}</i>` : '';
    const who = m ? this.pill(i.from) : `<span>${this.esc(i.from)}</span>`;
    const draft = m?.ready && !m.took ? String(this.drafts[m.itemId] ?? m.draft ?? '').trim() : '';
    const line = draft ? `<p class="hpen">${pen}<span>Reply drafted: \u201c${this.esc(draft)}\u201d</span></p>`
      : i.body ? `<p class="hcard-body">${m ? this.pills(i.body) : this.esc(i.body)}</p>` : '';
    const g = this.goal(i), later = i.urgent ? '' : `<button type="button" class="hquiet" data-need="later" data-key="${k}">Later</button>`;
    return `<article class="hcard${i.urgent ? ' is-urgent' : ''}"><div class="hcard-t"><span class="hcard-meta"><b>${this.esc(i.reason || i.menu.source)}</b>${who}${g ? `<em class="hchip" title="Moves ${this.esc(g)}">${this.esc(g)}</em>` : ''}</span>
      <h5>${this.esc(i.title)}</h5>${line}</div>
      <div class="hcard-a"><button type="button" class="hgo" data-need="open" data-key="${k}">${this.esc(m ? 'Reply' : i.action)}</button>${later}${this.menu(i)}</div></article>`;
  },
  /** "Do this first" sits above Your three; the rest (Also needs you, muted, Later) sits under it. */
  needsHtml() {
    const f = this.feed;
    return f?.needs?.length ? this.hero(f.needs[0]) : '';
  },
  alsoHtml() {
    const f = this.feed;
    if (!f) return '';
    const rest = f.needs.slice(1), vis = this.more ? rest : rest.slice(0, 3);
    const also = rest.length ? `<section class="hsec halso"><h4>Also needs you <em>${rest.length}</em></h4>${vis.map((i) => this.row(i)).join('')}
      ${rest.length > 3 ? `<button type="button" class="t3link hneed-more" data-need="more">${this.more ? 'Show less' : `Show ${rest.length - 3} more`}</button>` : ''}</section>` : '';
    const muted = f.muted.map((m) => `<p class="hneed-note"><span>${this.esc(m.name)} muted until ${this.esc(m.until)}. Dots still show on the things.</span><button type="button" class="t3link" data-need="unmute" data-src="${this.esc(m.id)}">Unmute</button></p>`).join('');
    return also + muted;
  },
  /** Later sits at the bottom, under Waiting on (the Focus order): what you put off and when it's back. */
  laterHtml() {
    const f = this.feed;
    if (!f) return '';
    return f.later.length ? `<section class="hsec"><h4>Later <em>${f.later.length}</em></h4>${f.later.map((l) => `<div class="hrow"><span class="hrt"><b>${this.esc(l.title)}</b><span>Back ${this.esc(l.when)}</span></span>
      <button type="button" class="t3link" data-need="unlater" data-key="${this.esc(l.key)}">Bring back now</button></div>`).join('')}</section>` : '';
  },
  /** The brief's counts are from last night; once Papr Work feeds us, show live ones (same as the proposal). */
  stats(today) {
    const el = document.querySelector('#hero .hero-stats'), f = this.feed;
    if (!el || !f || !today) return;
    const n = (v, l) => `<span class="stat"><b class="stat-num">${v}</b> <span class="stat-label">${l}</span></span>`;
    el.innerHTML = n(f.needs.length, 'need you') + n((f.waiting || []).length, 'waiting on') + n(f.later.length, 'later');
  },
  paint() {
    const n = document.getElementById('needs'), al = document.getElementById('alsoneeds'), w = document.getElementById('waiting');
    if (!n || !al || !w) return;
    const today = typeof App === 'undefined' || App.idx === 0;
    const a = document.activeElement;
    if (a && a.tagName === 'TEXTAREA' && (n.contains(a) || al.contains(a) || w.contains(a))) { this.dirty = true; return; }
    n.innerHTML = today ? this.needsHtml() : '';
    const slot = document.getElementById('focus');
    if (slot) slot.hidden = today && this.has(); // one "Do this first", never two
    this.stats(today);
    al.innerHTML = today ? this.alsoHtml() : '';
    w.innerHTML = today && typeof Waiting !== 'undefined' ? Waiting.html() + this.laterHtml() + Waiting.handled() : '';
    const t = document.getElementById('hneed-toast');
    if (t) t.remove();
    if (this.toast) document.body.insertAdjacentHTML('beforeend', `<div id="hneed-toast" class="hneed-toast" role="status"><span>${this.esc(this.toast.text)}</span>${this.toast.undo ? '<button type="button" data-need="undo">Undo</button>' : ''}</div>`);
  },
};
