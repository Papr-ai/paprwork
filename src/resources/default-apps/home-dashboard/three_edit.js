/* Edit your three — keep, edit or swap. Pen proposes, you dispose: never a blank page, never more
   than three. Edits stay in a local draft until Save / Lock in, which PUTs /api/workspace/focus.
   "Not now" keeps Pen's picks as they are (they were already quietly accepted). */
const ThreeEdit = {
  draft: null, pool: null, editing: '', swapping: '', saving: false,
  /** Goal id being promoted from outside the three: each card offers "Replace with this". */
  promote: '',
  esc(s) { return Three.esc(s); },
  reset(focusId) {
    const d = Three.data || { three: [], candidates: [] };
    this.draft = d.three.map((g) => ({ ...g, origTitle: g.title }));
    this.pool = d.candidates.map((g) => ({ ...g, origTitle: g.title }));
    this.editing = focusId || ''; this.swapping = ''; this.promote = '';
  },
  /** "I'll tell you": open a blank slot (a new one when there's room, else slot 1) ready to type. */
  startOwn() {
    if (!this.draft) this.reset();
    let slot = this.draft[0];
    if (this.draft.length < 3) {
      slot = { id: `F-new-${Date.now()}`, title: '', why: 'Written by you', origin: 'custom', signals: {} };
      this.draft.push(slot);
    }
    this.editing = `own:${slot.id}`; this.swapping = '';
    this.paint();
    document.getElementById('te-t')?.focus();
  },
  /** PUT body for a set of goals — custom ones carry their text, Pen's carry the goal id. */
  picksFrom(goals) {
    return goals.filter((g) => g.title).map((g) => g.origin === 'custom'
      ? { id: g.id, title: g.title, target: g.target, due: g.due, repeat: g.repeat, scope: g.scope }
      : { id: g.id, goalId: g.id, title: g.edited || (g.origTitle && g.title !== g.origTitle) ? g.title : undefined, target: g.target, due: g.due, repeat: g.repeat, scope: g.scope });
  },
  firstRun() { return Three.data?.source === 'pen' && !Three.data?.confirmed; },
  editor(g, own) { return ThreeForm.html(g, own, (x) => this.esc(x)); },
  swapList(g) {
    const c = this.pool.map((x) => `<button type="button" class="t3cand" data-three="use" data-gid="${this.esc(g.id)}" data-cid="${this.esc(x.id)}">
      <b>${this.esc(x.title)}</b><span>${this.esc(x.why)}</span></button>`).join('');
    return `<div class="t3swap"><small>Swap for</small>${c}<button type="button" class="t3cand own" data-three="own" data-gid="${this.esc(g.id)}"><b>Write my own</b></button></div>`;
  },
  card(g, i) {
    const own = this.editing === `own:${g.id}`;
    const editing = own || this.editing === g.id;
    const body = editing ? this.editor(g, own) : `<h3>${this.esc(g.title)}</h3>${Three.sub(g) ? `<p class="t3done">${this.esc(Three.sub(g))}</p>` : ''}
      <p class="t3why">${Three.SPARK}${this.esc(g.why)}</p>`;
    const pr = this.promote && this.pool.find((x) => x.id === this.promote);
    if (pr && !editing) {
      return `<article class="t3card"><span class="t3num">${i + 1}</span><div class="t3body"><h3>${this.esc(g.title)}</h3>${Three.sub(g) ? `<p class="t3done">${this.esc(Three.sub(g))}</p>` : ''}</div>
        <div class="t3acts"><button type="button" class="on" data-three="use" data-gid="${this.esc(g.id)}" data-cid="${this.esc(pr.id)}">Replace with this</button></div></article>`;
    }
    const acts = editing ? '' : `<div class="t3acts"><button type="button" data-three="edit-one" data-gid="${this.esc(g.id)}">Edit</button>
      <button type="button" class="${this.swapping === g.id ? 'on' : ''}" data-three="swap" data-gid="${this.esc(g.id)}">Swap</button></div>`;
    return `<article class="t3card${editing ? ' editing' : ''}"><span class="t3num">${i + 1}</span>
      <div class="t3body">${body}${this.swapping === g.id ? this.swapList(g) : ''}</div>${acts}</article>`;
  },
  render() {
    if (!this.draft) this.reset();
    const first = this.firstRun();
    const blank = !Three.has();
    const pr = this.promote && this.pool.find((x) => x.id === this.promote);
    const sub = pr ? `Pick the goal "${this.esc(pr.title)}" replaces. Three at most.` : blank ? 'Name up to three outcomes you want to move. Pen builds your brief around them.' : first ? `${this.esc(Three.data?.evidence || 'From your goals')}. Keep them, edit one, or swap it out.` : "Change what's changed. Pen keeps the rest as is.";
    return `<div class="t3wrap">
      <p class="hero-date">${first ? "Pen's picks" : 'Edit Focus'}</p>
      <h2 class="hero-title">${first ? 'Pen picked your three.' : 'Your three.'}</h2><p class="t3sub">${sub}</p>
      <div class="t3cards">${this.draft.map((g, i) => this.card(g, i)).join('')}</div>
      ${this.draft.length < 3 && !this.editing ? '<button type="button" class="t3add" data-three="add">Add a goal</button>' : ''}
      <footer class="t3foot"><button type="button" class="hfocus-primary" data-three="lock"${this.saving ? ' disabled' : ''}>${first ? 'Lock in my three' : 'Save'}</button>
        <button type="button" class="hfocus-ghost" data-three="close">${first ? 'Not now' : 'Cancel'}</button></footer>
      <p class="t3note">Three at most. Pen never changes them on its own. <button type="button" class="t3link" data-three="repick">Let Pen pick again</button></p>
    </div>`;
  },
  paint() { document.getElementById('view-three').innerHTML = this.render(); },
  val(id) { return (document.getElementById(id)?.value || '').trim(); },
  async put(url, method, body) {
    this.saving = true; this.paint();
    try {
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (r.ok) Three.data = await r.json();
      else console.warn('[home] focus save failed:', r.status);
    } catch (err) { console.warn('[home] focus save failed:', err?.message || err); }
    this.saving = false; this.draft = null;
  },
  async act(act, b) {
    const gid = b.dataset.gid;
    const i = this.draft ? this.draft.findIndex((g) => g.id === gid) : -1;
    if (act === 'repeat') { ThreeForm.setRepeat(b); return; }
    if (act === 'edit-one') { this.editing = this.editing === gid ? '' : gid; this.swapping = ''; }
    else if (act === 'swap') { this.swapping = this.swapping === gid ? '' : gid; this.editing = ''; }
    else if (act === 'cancel') { this.editing = ''; this.draft = this.draft.filter((g) => g.title); }
    else if (act === 'add') { this.startOwn(); return; }
    else if (act === 'own') { this.editing = `own:${gid}`; this.swapping = ''; }
    else if (act === 'use' && i >= 0) {
      const j = this.pool.findIndex((c) => c.id === b.dataset.cid);
      if (j >= 0) { const [picked] = this.pool.splice(j, 1); this.pool.unshift(this.draft[i]); this.draft[i] = picked; }
      this.swapping = ''; this.promote = '';
    } else if (act === 'save' && i >= 0) {
      const own = this.editing === `own:${gid}`;
      const f = ThreeForm.read();
      if (!f.title) return;
      if (own) {
        if (this.draft[i].title) this.pool.unshift(this.draft[i]);
        this.draft[i] = { id: `F-${Date.now()}`, ...f, why: 'Written by you', origin: 'custom', signals: {} };
      } else Object.assign(this.draft[i], f);
      this.editing = '';
    } else if (act === 'lock') {
      const picks = this.picksFrom(this.draft);
      if (!picks.length) return;
      await this.put('/api/workspace/focus', 'PUT', { picks, confirm: true });
      Three.close(); return;
    } else if (act === 'repick') {
      await this.put('/api/workspace/focus/repick', 'POST');
      this.reset(); this.paint(); return;
    }
    this.paint();
    if (act === 'edit-one' || act === 'own') document.getElementById('te-t')?.focus();
  },
};
