/* Goals strip — the user's big rocks, read from IDENTITY.md via /api/workspace/goals.
   Sleep DRAFTS a confidence-scored L1 → L2 → L3 tree (Status: proposed) from onboarding
   goals, chats and Papr Memory; the user confirms, edits, or rejects here. All writes go
   through the agent (chat.open) so IDENTITY.md stays canonical for brief/Sleep/Wiki. */
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
    return { proposed: 'Draft', 'on-track': 'On track', 'at-risk': 'At risk', blocked: 'Blocked', done: 'Done' }[s] || '';
  },
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); },
  badges(g) {
    const b = [];
    if (g.status !== 'unknown') b.push(`<span class="goal-status ${g.status}">${this.statusLabel(g.status)}</span>`);
    if (g.confidence && g.confidence !== 'unknown' && g.confidence !== 'high') b.push(`<span class="goal-conf ${g.confidence}" title="How sure we are this is your goal">${g.confidence} confidence</span>`);
    if (g.parentMissing) b.push('<span class="goal-conf low" title="Parent goal not found">no parent</span>');
    if (g.level === 'L1' && g.period) b.push(`<span class="goal-period">${this.esc(g.period)}</span>`);
    return b.join('');
  },
  entityChips(g) {
    const refs = g.entities || [];
    if (!refs.length) return '';
    return `<div class="goal-entities">${refs.map(r => { const [type, slug] = r.split('/'); return `<a class="goal-entity ${this.esc(type)}" href="#" data-entity="${this.esc(r)}" title="${this.esc(r)}">${this.esc(slug.replace(/-/g, ' '))}</a>`; }).join('')}</div>`;
  },
  actions(g) {
    if (g.status === 'done' || g.status === 'dropped') return `<div class="goal-outcome">${g.status === 'done' ? '✓' : '✗'} ${this.esc(g.outcome || (g.status === 'done' ? 'Achieved' : 'Dropped'))}${g.closed ? ` · ${this.esc(g.closed)}` : ''}</div>`;
    if (g.status !== 'proposed') return `<div class="goal-confirm goal-hover"><button class="goals-btn tiny ghost" data-goals="edit-one" data-gid="${this.esc(g.id)}">Edit</button><button class="goals-btn tiny ghost" data-goals="close" data-gid="${this.esc(g.id)}">Close</button></div>`;
    return `<div class="goal-confirm"><button class="goals-btn tiny" data-goals="confirm" data-gid="${this.esc(g.id)}">Confirm</button><button class="goals-btn tiny ghost" data-goals="edit-one" data-gid="${this.esc(g.id)}">Edit</button><button class="goals-btn tiny ghost" data-goals="reject" data-gid="${this.esc(g.id)}">Not a goal</button></div>`;
  },
  node(g) {
    const kids = (g.children || []);
    const l3 = kids.filter(k => k.level === 'L3'), l2 = kids.filter(k => k.level !== 'L3');
    return `<div class="goal ${g.level} ${g.status}">
      <div class="goal-head"><span class="goal-title">${this.esc(g.title)}</span>${this.badges(g)}</div>
      ${g.nextMilestone ? `<div class="goal-next">Next: ${this.esc(g.nextMilestone)}</div>` : ''}
      ${this.entityChips(g)}
      ${this.actions(g)}
      ${l2.length ? `<details class="goal-l2s"><summary>${l2.length} sub-goal${l2.length > 1 ? 's' : ''}</summary><div class="goal-children">${l2.map(k => this.node(k)).join('')}</div></details>` : ''}
      ${l3.length ? `<details class="goal-l3s"><summary>${l3.length} tactical</summary>${l3.map(k => this.node(k)).join('')}</details>` : ''}
    </div>`;
  },
  render() {
    const d = this.data;
    if (!d) return '';
    if (d.isEmpty) {
      return `<section class="goals goals-empty">
        <div class="goals-empty-text">
          <strong>What are you working toward?</strong>
          <span>I can draft your goals from your Papr onboarding, chats and memory — long-term objectives, the mid-term goals under them, and this week's tactical steps — for you to confirm. Or tell me directly.</span>
        </div>
        <div class="goals-actions"><button class="goals-btn" data-goals="draft">Draft my goals</button><button class="goals-btn ghost" data-goals="set">I'll tell you</button></div>
      </section>`;
    }
    const drafts = d.proposedCount ? `<span class="goals-drafts">${d.proposedCount} draft${d.proposedCount > 1 ? 's' : ''} to confirm</span>` : '';
    const roots = (d.tree && d.tree.length) ? d.tree : d.goals.map(g => ({ ...g, children: [] }));
    const past = (d.archive || []);
    const byPeriod = past.reduce((m, g) => ((m[g.period || '—'] ||= []).push(g), m), {});
    const pastHtml = past.length ? `<details class="goals-past"><summary>Past goals (${past.length})</summary>${Object.entries(byPeriod).map(([p, gs]) => `<div class="goals-past-period"><h3>${this.esc(p)}</h3>${gs.map(g => `<div class="goal past ${g.level} ${g.status}"><div class="goal-head"><span class="goal-title">${this.esc(g.title)}</span></div>${this.actions(g)}</div>`).join('')}</div>`).join('')}</details>` : '';
    return `<section class="goals">
      <div class="goals-head"><h2 class="section-title">Goals ${drafts}</h2><div class="goals-actions">${d.proposedCount > 1 ? '<button class="goals-btn tiny" data-goals="confirm-all">Confirm all</button>' : ''}<button class="goals-btn ghost" data-goals="edit">Update goals</button></div></div>
      <div class="goals-tree">${roots.map(g => this.node(g)).join('')}</div>
      ${pastHtml}
    </section>`;
  },
  goalLine(g) { return `${g.id} [${g.level}${g.parent ? ' → ' + g.parent : ''}] — ${g.title} [${g.status}, ${g.confidence} confidence, priority ${g.priority}]${g.nextMilestone ? ` · next: ${g.nextMilestone}` : ''}${g.entities?.length ? ` · entities: ${g.entities.join(', ')}` : ''}`; },
  goalSummary(g, gid) {
    if (!g) return `Goal ${gid}`;
    const bits = [`"${g.title}"`, g.level];
    if (g.parent) bits.push(`parent ${g.parent}`);
    if (g.nextMilestone) bits.push(`next: ${g.nextMilestone}`);
    return `${bits.join(' · ')} (${gid})`;
  },
  prompt(mode, gid) {
    const goals = this.data?.goals || [];
    const one = goals.find(g => g.id === gid);
    const list = goals.map(g => this.goalLine(g)).join('\n');
    const fmt = 'Keep the block format in IDENTITY.md "## Goals" (Level / Status / Confidence / Priority / Parent / Entities / Next milestone / Owner / Evidence), keep L1s mutually exclusive, name the projects/companies/people each goal runs through (Entities: line, using real entities/** slugs), and show me the final tree.';
    switch (mode) {
      case 'draft':
        return `Draft my goals for me. Read IDENTITY.md (Goals format, Current Projects, Domain Context), MEMORY.md, the last 7 daily logs, my Papr onboarding goals/use cases, and my Papr Memory goal records. Propose a tree: 2–5 L1 long-term OUTCOMES (mutually exclusive), the L2 mid-term goals under each, and L3 tactical steps with dates. Give each a Confidence (high = I said it directly, medium = strong inference, low = one signal), a Priority within its level, the Entities it runs through (real entities/** slugs — an L2 is usually one project or company), and cite the evidence quote. Write them into IDENTITY.md "## Goals" as Status: proposed, then show me the tree so I can confirm, edit, or reject each one.`;
      case 'set':
        return `I want to set my goals so my daily brief is built around them.\n\nInterview me briefly, top-down: what 2–5 long-term outcomes (L1) am I working toward, then for each the mid-term goals (L2) and this month's tactical steps (L3) with dates, and which matters most. Push back if I give tasks as L1s. Set Confidence: high for anything I state directly. ${fmt}`;
      case 'confirm':
        return `Please confirm this draft goal from my Home dashboard — update IDENTITY.md so Status is on-track and Confidence is high:\n\n${this.goalSummary(one, gid)}`;
      case 'confirm-all':
        return `Please confirm all my draft goals from the Home dashboard — in IDENTITY.md, set every Status: proposed to on-track and Confidence: high.\n\nCurrent goals:\n${list}`;
      case 'reject':
        return `This draft goal isn't mine — please remove it from IDENTITY.md ## Goals:\n\n${this.goalSummary(one, gid)}\n\nAsk me briefly why it doesn't fit before you remove it. If it has sub-goals, ask what to do with those too.`;
      case 'close':
        return `I want to close this goal:\n\n${this.goalSummary(one, gid)}\n\nAsk whether we achieved it or are dropping it, and what happened in one line.`;
      case 'edit-one':
        return `I want to edit this goal in IDENTITY.md:\n\n${this.goalSummary(one, gid)}`;
      default:
        return `Let's update my goals in IDENTITY.md (## Goals). Current tree:\n\n${list}\n\nAsk me what changed — anything done, at risk, new, reprioritised, or mis-levelled — then rewrite the block. ${fmt}`;
    }
  },
  bind(root) {
    root.addEventListener('click', (e) => {
      const ent = e.target.closest('[data-entity]');
      if (ent) {
        e.preventDefault(); e.stopPropagation();
        const ref = ent.dataset.entity;
        if (window.paprAPI?.invoke) window.paprAPI.invoke('memory.openEntity', { ref }).catch(() => window.paprAPI.invoke('chat.open', { message: `Open the wiki page for ${ref} and summarise its open items and which goals it serves.` }));
        return;
      }
      const btn = e.target.closest('[data-goals]');
      if (!btn) return;
      e.stopPropagation();
      if (window.paprAPI?.invoke) window.paprAPI.invoke('chat.open', { message: this.prompt(btn.dataset.goals, btn.dataset.gid) });
      else alert('Open Paprwork on desktop to manage goals with the agent.');
    });
  },
};
