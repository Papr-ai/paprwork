/* Goals strip — the user's big rocks, read from IDENTITY.md via /api/workspace/goals.
   Goals are edited through chat so the agent keeps IDENTITY.md canonical and the
   brief, Sleep, and Wiki Writer all see the same list. */
const Goals = {
  data: null,
  async load() {
    try {
      const r = await fetch('/api/workspace/goals', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      this.data = await r.json();
    } catch { this.data = null; }
    return this.data;
  },
  statusLabel(s) {
    return { 'on-track': 'On track', 'at-risk': 'At risk', blocked: 'Blocked', done: 'Done' }[s] || '';
  },
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); },
  render() {
    const d = this.data;
    if (!d) return '';
    if (d.isEmpty) {
      return `<section class="goals goals-empty">
        <div class="goals-empty-text">
          <strong>What are you working toward?</strong>
          <span>Tell me your 3–5 big rocks and tomorrow's brief will be built around them — not around housekeeping.</span>
        </div>
        <button class="goals-btn" data-goals="set">Set my goals</button>
      </section>`;
    }
    const items = d.goals.map(g => `
      <div class="goal ${g.status}">
        <div class="goal-head"><span class="goal-id">${this.esc(g.id)}</span><span class="goal-title">${this.esc(g.title)}</span>
          ${g.status !== 'unknown' ? `<span class="goal-status">${this.statusLabel(g.status)}</span>` : ''}</div>
        ${g.nextMilestone ? `<div class="goal-next">Next: ${this.esc(g.nextMilestone)}</div>` : ''}
      </div>`).join('');
    return `<section class="goals">
      <div class="goals-head"><h2 class="section-title">Goals</h2><button class="goals-btn ghost" data-goals="edit">Update goals</button></div>
      <div class="goals-grid">${items}</div>
    </section>`;
  },
  prompt(mode) {
    if (mode === 'set') {
      return `I want to set my goals (big rocks / OKRs) so my daily brief is built around them.\n\nInterview me briefly: ask what 3–5 outcomes I'm working toward this quarter, the next concrete milestone and date for each, and which matters most. Push back if I give you tasks instead of outcomes (e.g. "fix X" is a task; "ship X to 10 customers by Oct 1" is an outcome).\n\nThen write them into IDENTITY.md under "## Goals" using the G1/G2 block format already in that file (Status, Next milestone, Owner, Evidence), most important first. Show me the final list when done.`;
    }
    const current = (this.data?.goals || []).map(g => `${g.id} — ${g.title} [${g.status}]${g.nextMilestone ? ` · next: ${g.nextMilestone}` : ''}`).join('\n');
    return `Let's update my goals in IDENTITY.md (## Goals). Current list:\n\n${current}\n\nAsk me what changed — anything done, at risk, new, or reprioritised — then rewrite the block in the same G-number format and show me the result.`;
  },
  bind(root) {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-goals]');
      if (!btn) return;
      e.stopPropagation();
      if (window.paprAPI?.invoke) window.paprAPI.invoke('chat.open', { message: this.prompt(btn.dataset.goals) });
      else alert('Open Paprwork on desktop to set goals with the agent.');
    });
  },
};
