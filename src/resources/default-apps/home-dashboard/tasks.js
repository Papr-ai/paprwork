/* All tasks — the Today | All tasks switch. Reads the existing projection (/api/workspace/tasks:
   L3 goal steps + entity "Open Items"); checking a box calls the existing done endpoint, which edits
   the source markdown and re-projects, so every agent sees the same state. */
const Tasks = {
  data: null,
  view: 'today',
  CHECK: '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  async load() {
    try {
      const r = await fetch('/api/workspace/tasks?status=all', { credentials: 'same-origin' });
      this.data = r.ok ? await r.json() : null;
    } catch { this.data = null; }
    this.paintCount();
    return this.data;
  },
  paintCount() {
    const el = document.getElementById('task-count');
    const n = this.data?.counts?.open || 0;
    if (el) el.textContent = n ? String(n) : '';
  },
  fmtDue(due) {
    if (!due) return '';
    const d = new Date(`${due}T12:00`);
    if (Number.isNaN(d.getTime())) return this.esc(due);
    const days = Math.round((d - new Date().setHours(12, 0, 0, 0)) / 86400000);
    if (days === 0) return 'Due today';
    if (days === 1) return 'Due tomorrow';
    if (days < 0) return `Overdue · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    return `Due ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  },
  row(t) {
    const done = t.status === 'done';
    const entity = t.entity_ref ? t.entity_ref.split('/').pop().replace(/-/g, ' ') : '';
    const meta = [this.fmtDue(t.due), entity].filter(Boolean).join(' · ');
    const owner = t.owner && !/^(me|user|you|self)$/i.test(t.owner) ? `<em class="hk">${this.esc(t.owner)}</em>` : '';
    // Tag by goal name when it's one of your three; anything else stays a quiet grey code.
    const lab = t.goal_id && typeof Three !== 'undefined' ? Three.label(t.goal_id) : null;
    const goal = t.goal_id ? `<span class="hg${lab ? ' on' : ''}" title="${lab ? `One of your three: ${this.esc(Three.find(t.goal_id)?.title || '')}` : 'Not one of your three'}">${this.esc(lab || t.goal_id)}</span>` : '';
    return `<div class="hrow${done ? ' done' : ''}">
      <button type="button" class="hchk" data-task="${this.esc(t.id)}" data-done="${done ? '0' : '1'}" aria-label="${done ? 'Reopen' : 'Mark done'}">${this.CHECK}</button>
      <div class="hrt"><b>${this.esc(t.title)}</b>${meta ? `<span>${meta}</span>` : ''}</div>${owner}${goal}
    </div>`;
  },
  group(title, items) {
    if (!items.length) return '';
    return `<section class="hsec"><h4>${title}<em>${items.length}</em></h4>${items.map((t) => this.row(t)).join('')}</section>`;
  },
  render() {
    const root = document.getElementById('view-tasks');
    if (!root) return;
    const tasks = this.data?.tasks || [];
    const open = tasks.filter((t) => t.status === 'open');
    const done = tasks.filter((t) => t.status === 'done').slice(0, 20);
    if (!open.length && !done.length) {
      root.innerHTML = `<section class="hempty"><b>No tasks yet</b>
        <p>Tasks come from your goals' tactical steps and the Open Items on your wiki pages. Confirm goals on Today, or ask your agent to add one.</p></section>`;
      return;
    }
    root.innerHTML = `<h2 class="hero-title">All tasks</h2>
      <p class="hero-stats"><span class="stat"><b class="stat-num">${open.length}</b> <span class="stat-label">open</span></span>
      <span class="stat"><b class="stat-num">${this.data?.counts?.done || 0}</b> <span class="stat-label">done</span></span></p>
      ${this.group('Open', open)}${this.group('Recently done', done)}`;
  },
  async toggle(btn) {
    btn.disabled = true;
    btn.closest('.hrow')?.classList.toggle('done', btn.dataset.done === '1');
    try {
      await fetch(`/api/workspace/tasks/${encodeURIComponent(btn.dataset.task)}/done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done: btn.dataset.done === '1' }),
      });
    } catch (err) { console.warn('[home] task toggle failed:', err?.message || err); }
    await this.load();
    this.render();
  },
  async setView(view) {
    this.view = view;
    document.querySelectorAll('#hseg [data-view]').forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.getElementById('view-today').hidden = view !== 'today';
    document.getElementById('view-tasks').hidden = view !== 'tasks';
    document.querySelector('.hday')?.classList.toggle('is-hidden', view !== 'today');
    if (view === 'tasks') { this.render(); await this.load(); this.render(); }
  },
  bind() {
    document.getElementById('hseg')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (b) this.setView(b.dataset.view);
    });
    document.getElementById('view-tasks')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-task]');
      if (b && !b.disabled) this.toggle(b);
    });
    this.load();
  },
};
