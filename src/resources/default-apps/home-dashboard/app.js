const App = {
  dates: [], idx: 0, turning: false, labelTimer: null, brief: null,
  storeKey: 'home-review-v1',
  fmtDate(d) { return new Date(d + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); },
  loadState() { try { return JSON.parse(localStorage.getItem(this.storeKey) || '{}'); } catch { return {}; } },
  saveState(s) { localStorage.setItem(this.storeKey, JSON.stringify(s)); },
  hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return `i${Math.abs(h)}`; },
  decorate(brief, date) {
    const state = this.loadState(), reviewed = [];
    const sections = (brief.sections || []).map((s) => {
      if (!s.items) return s;
      const items = s.items.map((item) => {
        const id = this.hash(`${date}|${s.type}|${s.title}|${JSON.stringify(item)}`);
        return { ...item, _id: id, _review: state[id] || null, _section: s.title, _type: s.type };
      });
      const active = items.filter((item) => {
        if (!item._review || item._review.status === 'active') return true;
        reviewed.push(item); return false;
      });
      return { ...s, items: active };
    }).filter((s) => s.type === 'freeform' || (s.items && s.items.length));
    if (reviewed.length) sections.push({ type: 'reviewed', title: 'Reviewed', items: reviewed });
    return { ...brief, sections };
  },
  animateBars() {
    setTimeout(() => document.querySelectorAll('.tracker-bar-fill').forEach((bar) => {
      const w = bar.style.width; bar.style.width = '0%'; requestAnimationFrame(() => bar.style.width = w);
    }), 80);
  },
  async init() {
    this.dates = await Data.dates();
    if (!this.dates.length) this.dates = [new Date().toISOString().slice(0, 10)];
    await this.render(); FoldNav.bind(this);
    document.getElementById('sections').addEventListener('click', async (e) => {
      const reviewBtn = e.target.closest('[data-review]');
      if (reviewBtn) { e.stopPropagation(); await this.review(reviewBtn); return; }
      const agentEl = e.target.closest('.hi-btn[data-agent]');
      if (agentEl) { e.stopPropagation(); this.openAgent(agentEl); return; }
      const card = e.target.closest('.card[data-idx]');
      if (card) {
        const detail = card.querySelector('.tl-detail');
        if (detail) { detail.classList.toggle('open'); card.classList.toggle('expanded', detail.classList.contains('open')); }
      }
    });
  },
  async render() {
    const date = this.dates[this.idx];
    this.brief = this.decorate(await Data.load(date), date);
    document.getElementById('hero').innerHTML = R.hero(this.brief.hero);
    document.getElementById('sections').innerHTML = (this.brief.sections || []).map((s) => R.section(s)).join('');
    this.updateNav(); this.animateBars();
  },
  async review(btn) {
    const id = btn.dataset.id, next = btn.dataset.review, title = btn.dataset.title || 'this item';
    const state = this.loadState();
    if (next === 'irrelevant') {
      const note = window.prompt(`Why is "${title}" irrelevant? This note will be saved for later.`, state[id]?.note || '');
      if (note === null) return;
      state[id] = { status: 'irrelevant', note: note.trim(), at: new Date().toISOString() };
    } else if (next === 'complete') state[id] = { status: 'complete', at: new Date().toISOString() };
    else if (next === 'active') delete state[id];
    this.saveState(state); await this.render();
  },
  async turn(dir) {
    if (this.turning) return;
    const next = dir === 'prev' ? this.idx + 1 : this.idx - 1;
    if (next < 0 || next >= this.dates.length) return;
    this.turning = true;
    const app = document.getElementById('app');
    app.classList.remove('turn-prev', 'turn-next', 'turn-in');
    app.classList.add(dir === 'prev' ? 'turn-prev' : 'turn-next');
    await new Promise((r) => setTimeout(r, 180));
    this.idx = next; await this.render();
    app.classList.remove('turn-prev', 'turn-next'); app.classList.add('turn-in');
    setTimeout(() => { app.classList.remove('turn-in'); this.turning = false; }, 240);
  },
  updateNav() {
    const canPrev = this.idx < this.dates.length - 1, canNext = this.idx > 0;
    document.getElementById('fold-prev').classList.toggle('disabled', !canPrev);
    document.getElementById('fold-next').classList.toggle('disabled', !canNext);
    document.getElementById('peek-prev').textContent = canPrev ? this.fmtDate(this.dates[this.idx + 1]) : '';
    document.getElementById('peek-next').textContent = canNext ? this.fmtDate(this.dates[this.idx - 1]) : '';
    const label = document.getElementById('nav-label');
    label.textContent = this.idx === 0 ? 'Today' : this.fmtDate(this.dates[this.idx]);
    label.classList.toggle('visible', this.idx > 0);
    clearTimeout(this.labelTimer);
    if (this.idx > 0) this.labelTimer = setTimeout(() => label.classList.remove('visible'), 2400);
  },
  openAgent(btn) {
    const data = JSON.parse(decodeURIComponent(btn.dataset.agent));
    const prompts = {
      meeting: d => `Help me prepare for my ${d.time} meeting: "${d.title}".${d.detail ? ' Context: ' + Object.entries(d.detail).map(([k,v])=>`${k}: ${v}`).join('. ') : ''} What should I know, ask, and accomplish?`,
      priority: d => `Help me execute on this priority: "${d.title}". Why it matters: ${d.why||'N/A'}. Break this down into concrete next steps I can take today.`,
      tracker: d => `I'm tracking "${d.label}" — currently at ${d.current}/${d.target} ${d.unit||''}.${d.context ? ' Context: '+d.context : ''} Help me close the gap and hit my target.`,
      intel: d => `Brief me on: "${d.subject}". Key points: ${(d.bullets||[]).join('; ')}. What else should I know? Any angles I'm missing?`,
      alert: d => `I have an alert: "${d.message}".${d.action ? ' Suggested action: '+d.action : ''} Help me handle this effectively right now.`,
    };
    window.paprAPI.invoke('chat.open', { message: (prompts[data.type] || (d => `Help me with: ${JSON.stringify(d)}`))(data) });
  }
}; App.init();