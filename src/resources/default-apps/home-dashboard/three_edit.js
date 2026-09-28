/* Edit your three — keep, edit or swap. Pen proposes, you dispose: never a blank page, never more
   than three. Edits stay in a local draft until Save / Lock in, which PUTs /api/workspace/focus.
   "Not now" keeps Pen's picks as they are (they were already quietly accepted). */
const ThreeEdit = {
  draft: null, pool: null, editing: '', swapping: '', saving: false,
  esc(s) { return Three.esc(s); },
  reset(focusId) {
    const d = Three.data || { three: [], candidates: [] };
    this.draft = d.three.map((g) => ({ ...g, origTitle: g.title }));
    this.pool = d.candidates.map((g) => ({ ...g, origTitle: g.title }));
    this.editing = focusId || ''; this.swapping = '';
  },
  firstRun() { return Three.data?.source === 'pen' && !Three.data?.confirmed; },
  editor(g, own) {
    const v = (s) => (own ? '' : this.esc(s || ''));
    return `<div class="t3edit">
      <label><span>Outcome</span><input id="te-t" value="${v(g.title)}" placeholder="Close Tranche 2" /></label>
      <div class="t3pair"><label><span>Done when</span><input id="te-m" value="${v(g.target)}" placeholder="$1.25M raised" /></label>
        <label><span>By</span><input id="te-d" value="${v(g.due)}" placeholder="Nov 30" /></label></div>
      <p class="t3tip">Name a result you can count, not an activity. "$1.25M raised" beats "work on the raise".</p>
      <div class="t3btns"><button type="button" class="t3save" data-three="save" data-gid="${this.esc(g.id)}">Save</button>
        <button type="button" class="t3cancel" data-three="cancel">Cancel</button></div></div>`;
  },
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
    const acts = editing ? '' : `<div class="t3acts"><button type="button" data-three="edit-one" data-gid="${this.esc(g.id)}">Edit</button>
      <button type="button" class="${this.swapping === g.id ? 'on' : ''}" data-three="swap" data-gid="${this.esc(g.id)}">Swap</button></div>`;
    return `<article class="t3card${editing ? ' editing' : ''}"><span class="t3num">${i + 1}</span>
      <div class="t3body">${body}${this.swapping === g.id ? this.swapList(g) : ''}</div>${acts}</article>`;
  },
  render() {
    if (!this.draft) this.reset();
    const first = this.firstRun();
    const sub = first ? `${this.esc(Three.data?.evidence || 'From your goals')}. Keep them, edit one, or swap it out.` : "Change what's changed. Pen keeps the rest as is.";
    return `<div class="t3wrap">
      <p class="hero-date">${first ? "Pen's picks" : 'Edit Focus'}</p>
      <h2 class="hero-title">${first ? 'Pen picked your three.' : 'Your three.'}</h2><p class="t3sub">${sub}</p>
      <div class="t3cards">${this.draft.map((g, i) => this.card(g, i)).join('')}</div>
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
    if (act === 'edit-one') { this.editing = this.editing === gid ? '' : gid; this.swapping = ''; }
    else if (act === 'swap') { this.swapping = this.swapping === gid ? '' : gid; this.editing = ''; }
    else if (act === 'cancel') this.editing = '';
    else if (act === 'own') { this.editing = `own:${gid}`; this.swapping = ''; }
    else if (act === 'use' && i >= 0) {
      const j = this.pool.findIndex((c) => c.id === b.dataset.cid);
      if (j >= 0) { const [picked] = this.pool.splice(j, 1); this.pool.unshift(this.draft[i]); this.draft[i] = picked; }
      this.swapping = '';
    } else if (act === 'save' && i >= 0) {
      const own = this.editing === `own:${gid}`;
      const f = { title: this.val('te-t'), target: this.val('te-m'), due: this.val('te-d') };
      if (!f.title) return;
      if (own) {
        this.pool.unshift(this.draft[i]);
        this.draft[i] = { id: `F-${Date.now()}`, title: f.title, target: f.target, due: f.due, why: 'Written by you', origin: 'custom', signals: {} };
      } else Object.assign(this.draft[i], f);
      this.editing = '';
    } else if (act === 'lock') {
      const picks = this.draft.map((g) => g.origin === 'custom'
        ? { id: g.id, title: g.title, target: g.target, due: g.due }
        : { id: g.id, goalId: g.id, title: g.title !== g.origTitle ? g.title : undefined, target: g.target, due: g.due });
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
