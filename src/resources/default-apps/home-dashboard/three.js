/* Your three — the goals Pen picked (or you chose), from /api/workspace/focus.
   Pen ranks IDENTITY.md goals + onboarding OKRs by where your time went (chats, daily logs,
   open tasks, linked apps). Its picks are quietly accepted; Edit / Swap any time (three_edit.js).
   One goal opens a detail view: what it needs, what moves it, one tap to work on it with Pen. */
const Three = {
  data: null, loadedAt: 0, view: 'page', gid: null,
  SPARK: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z"/></svg>',
  BACK: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  CHEV: '<svg class="t3chev" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ARROW: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  async load() {
    try {
      const r = await fetch('/api/workspace/focus', { credentials: 'same-origin' });
      this.data = r.ok ? await r.json() : null;
    } catch { this.data = null; }
    this.loadedAt = Date.now();
    return this.data;
  },
  has() { return !!this.data?.three?.length; },
  /** Any ranked goal — one of the three or one outside it (so every goal has a detail view). */
  find(id) { return [...(this.data?.three || []), ...(this.data?.candidates || [])].find((g) => g.id === id) || null; },
  inThree(id) { return (this.data?.three || []).some((g) => g.id === id); },
  /** Moved = real time went in this week; touched = a little; none = the goal sat still. */
  pace(s = {}) { return s.hours7 >= 1 ? ['on', 'Moved'] : s.hours7 > 0 || s.logDays ? ['risk', 'Barely touched'] : ['off', 'No time']; },
  pendingOpen: null,
  /** Deep link from the rail peek: open one goal once Home has its data. */
  openGoal(id) {
    if (!this.loadedAt || typeof App === 'undefined' || !App.ready) { this.pendingOpen = id; return; }
    this.pendingOpen = null;
    if (this.find(id)) this.show('goal', id);
  },
  /** Short name for task chips: "Tranche 2" rather than "G1". Null when the goal isn't one of the three. */
  label(goalId) {
    const g = goalId && (this.data?.three || []).find((x) => x.id === goalId);
    if (!g) return null;
    const words = g.title
      .replace(/^(close|ship|land|grow|fix|validate|prevent|build|launch|finish|get|make|reach|hit)\s+/i, '')
      .split(/\s+(?:and|for|on|with|via|to|in|by|\+|&)\s+/i)[0]
      .split(/\s+/)
      .filter((w, i, all) => !(i < all.length - 1 && /^(a|an|the|our|my|validated|new)$/i.test(w)));
    return words.slice(0, 3).join(' ');
  },
  fmtDue(due) {
    if (!due) return '';
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T12:00` : due);
    return Number.isNaN(d.getTime()) ? `by ${due}` : `by ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  },
  daysLeft(due) {
    const d = due && new Date(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T12:00` : due);
    if (!d || Number.isNaN(d.getTime())) return null;
    return Math.max(0, Math.round((d - new Date().setHours(12, 0, 0, 0)) / 86400000));
  },
  hours(h) { return !h ? '0h' : h >= 10 ? `${Math.round(h)}h` : h >= 1 ? `${Math.round(h * 10) / 10}h` : `${Math.max(1, Math.round(h * 60))}m`; },
  /** "Every day" / "Every week" for habit goals, '' for one-time ones. */
  every(g) { return g.repeat === 'daily' ? 'Every day' : g.repeat === 'weekly' ? 'Every week' : ''; },
  sub(g) {
    const when = g.repeat ? this.every(g) : this.fmtDue(g.due);
    return [g.target, when].filter(Boolean).join(' · ') || (g.nextStep ? `Next: ${g.nextStep}` : '');
  },
  /** Today: the three rows under "Do this first". */
  section() {
    if (!this.has()) return '';
    const d = this.data;
    const rows = d.three.map((g, i) => {
      const s = g.signals || {};
      const meta = s.hours7 >= 0.1 ? `${this.hours(s.hours7)} this week` : s.chats30 ? `${s.chats30} chats` : '';
      return `<button type="button" class="t3row" data-three="open" data-gid="${this.esc(g.id)}"><i>${i + 1}</i>
        <span><b>${this.esc(g.title)}</b>${this.sub(g) ? `<em>${this.esc(this.sub(g))}</em>` : ''}</span>${meta ? `<small>${meta}</small>` : '<small></small>'}${this.CHEV}</button>`;
    }).join('');
    const aligned = d.alignedPct == null ? '' : `<p class="t3aligned"><span class="t3bar"><i style="width:${Math.min(100, d.alignedPct)}%"></i></span><b>${d.alignedPct}%</b> of this week's chat time went to these</p>`;
    const pick = d.source === 'pen' && !d.confirmed ? '<em class="t3pick" title="Pen picked these from your goals and activity. Edit any time.">Pen\'s picks</em>' : '';
    const review = typeof WeekReview !== 'undefined' ? WeekReview.banner() : '';
    return `${review}<section class="hthree"><header><h2 class="section-title">Your three ${pick}</h2>
      <button type="button" class="t3link" data-three="edit">Edit</button></header>${rows}${aligned}</section>`;
  },
  /** One goal: where it stands, what moves it, and one tap to work on it. */
  detail(g) {
    const left = this.daysLeft(g.due);
    const done = g.repeat ? this.sub(g)
      : [g.target, g.due ? `${this.fmtDue(g.due)}${left != null ? ` · ${left} days left` : ''}` : ''].filter(Boolean).join(' · ');
    // The server says which tasks move this goal (tag, entity or Jev). Matching by id alone leaked
    // G4's MHAR tasks into a goal the user had rewritten as "Distribution".
    const want = Array.isArray(g.taskIds) ? new Set(g.taskIds) : null;
    const tasks = ((typeof Tasks !== 'undefined' && Tasks.data?.tasks) || [])
      .filter((t) => t.status === 'open' && (want ? want.has(t.id) : t.goal_id && t.goal_id === g.id));
    const [pcls, plabel] = this.pace(g.signals || {});
    const mine = this.inThree(g.id);
    const outside = mine ? '' : `<p class="t3outside">Not one of your three right now.</p>`;
    const second = mine
      ? `<button type="button" class="hfocus-ghost" data-three="edit" data-gid="${this.esc(g.id)}">Edit goal</button>`
      : `<button type="button" class="hfocus-ghost" data-three="promote" data-gid="${this.esc(g.id)}">Make it one of three</button>`;
    const rows = tasks.length ? tasks.map((t) => Tasks.row(t)).join('') : '<p class="t3sub">No tasks yet. Ask Pen for the next step.</p>';
    return `<div class="t3wrap">
      <button type="button" class="t3back" data-three="close">${this.BACK}Focus</button>
      <div class="t3dh"><h2 class="hero-title">${this.esc(g.title)}</h2><em class="wrpill is-${pcls}">${plabel}</em></div>
      ${done ? `<p class="t3sub">${this.esc(done)}</p>` : ''}${outside}
      ${typeof ThreeHero !== 'undefined' ? ThreeHero.html(g) : ''}
      ${typeof ThreeTrack !== 'undefined' ? ThreeTrack.html(g) : ''}
      ${g.why || g.scope ? `<details class="t3about"><summary>Why this goal</summary>${g.why ? `<p class="t3why">${this.SPARK}${this.esc(g.why)}</p>` : ''}
        ${g.scope ? `<p class="t3scope"><span>Counts</span>${this.esc(g.scope)}</p>` : ''}</details>` : ''}
      ${g.nextStep ? `<section class="hsec"><h4>Next milestone</h4><p class="t3next">${this.esc(g.nextStep)}</p></section>` : ''}
      <section class="hsec"><h4>Moves it <em>${tasks.length}</em></h4>${rows}</section>
      <footer class="t3foot"><button type="button" class="hfocus-primary" data-three="chat" data-gid="${this.esc(g.id)}">Work on it with Pen</button>
        ${second}</footer>
    </div>`;
  },
  show(view, gid) {
    this.view = view; this.gid = gid || null;
    const root = document.getElementById('view-three');
    const g = gid ? this.find(gid) : null;
    if (view === 'goal' && g) root.innerHTML = this.detail(g);
    else if (view === 'review' && this.has()) root.innerHTML = WeekReview.render();
    else { ThreeEdit.reset(gid); root.innerHTML = ThreeEdit.render(); }
    ['view-today', 'view-tasks'].forEach((id) => { document.getElementById(id).hidden = true; });
    document.querySelector('.htop')?.classList.add('is-sub');
    root.hidden = false;
    window.scrollTo?.(0, 0);
  },
  close() {
    this.view = 'page';
    document.getElementById('view-three').hidden = true;
    document.querySelector('.htop')?.classList.remove('is-sub');
    const el = document.getElementById('three');
    const onToday = typeof App === 'undefined' || App.idx === 0;
    if (el) el.innerHTML = onToday ? this.section() : '';
    // The first-run "What are you working toward?" prompt folds away once there is a three.
    const goals = document.getElementById('goals');
    if (goals && onToday && typeof App !== 'undefined') goals.innerHTML = App.goalsBlock();
    Tasks.setView('today');
  },
  chat(g) {
    const habit = g.repeat ? ` This repeats ${g.repeat === 'daily' ? 'every day' : 'every week'}; help me get ${g.repeat === 'daily' ? "today's" : "this week's"} done.` : '';
    const msg = `Help me move my goal "${g.title}" forward today.${g.target ? ` ${g.repeat ? (g.repeat === 'daily' ? 'Each day' : 'Each week') : 'Done when'}: ${g.target}.` : ''}${habit}${g.due && !g.repeat ? ` Due ${g.due}.` : ''}${g.nextStep ? ` Next milestone: ${g.nextStep}.` : ''} Look at its open tasks and recent chats, then give me the one next step and do the first part with me.`;
    if (window.paprAPI?.invoke) window.paprAPI.invoke('chat.open', { message: msg });
  },
  bind() {
    document.getElementById('app').addEventListener('click', (e) => {
      const task = e.target.closest('#view-three [data-task]');
      if (task && !task.disabled) { Tasks.toggle(task).then(() => this.view === 'goal' && this.show('goal', this.gid)); return; }
      const b = e.target.closest('[data-three]');
      if (!b) return;
      e.stopPropagation();
      const act = b.dataset.three, gid = b.dataset.gid;
      if (act === 'open') this.show('goal', gid);
      else if (act === 'close') this.close();
      else if (act === 'chat') this.chat(this.find(gid) || {});
      else if (act === 'edit') this.show('edit', gid);
      else if (act === 'review') this.show('review');
      else if (act === 'promote') { this.show('edit'); ThreeEdit.promote = gid; ThreeEdit.paint(); }
      else if (act === 'hero-fix' && typeof ThreeHero !== 'undefined') ThreeHero.fix(this.find(gid) || {}, b.dataset.src);
      else if (act.startsWith('track') && typeof ThreeTrack !== 'undefined') ThreeTrack.act(act, this.find(gid) || {}, b);
      else if (act.startsWith('wr-')) WeekReview.act(act);
      else ThreeEdit.act(act, b);
    });
    // Goals change in chat (and Sleep re-ranks evidence) — refresh when Home comes back into view.
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden || this.view !== 'page' || Date.now() - this.loadedAt < 60_000) return;
      await this.load();
      const el = document.getElementById('three');
      if (el && (typeof App === 'undefined' || App.idx === 0)) el.innerHTML = this.section();
    });
  },
};

// The rail's Focus peek posts { type: 'papr-focus-open', goalId } after switching to Home.
// It retries a few times (the iframe may still be loading), so de-dupe by nonce.
(function listenForFocusOpen() {
  let lastNonce = null;
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'papr-focus-open' || typeof m.goalId !== 'string') return;
    if (m.nonce && m.nonce === lastNonce) return;
    lastNonce = m.nonce || null;
    Three.openGoal(m.goalId);
  });
})();
