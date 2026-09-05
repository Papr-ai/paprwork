const App = {
  dates: [], idx: 0, turning: false, labelTimer: null, brief: null,
  storeKey: 'home-review-v1',
  isSampleData: false, // Track if showing sample data
  loadError: false,
  fmtDate(d) { return new Date(d + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); },
  loadState() { return Reviews.cache(); },
  saveState(s) { Reviews.setCache(s); },
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
  JOB_ID: null,
  async resolveJobId() {
    if (this.JOB_ID) return this.JOB_ID;
    this.JOB_ID = await Data.resolveJobId();
    return this.JOB_ID;
  },
  async generateRealBrief() {
    const btn = document.getElementById('gen-real-brief-btn');
    if (!btn) return;
    
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div>Generating...';
    
    try {
      const jobId = await this.resolveJobId();
      let response = await fetch('/api/jobs/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, wait: false })
      });
      
      // Job doesn't exist — ask the agent to set it up
      if (response.status === 404) {
        btn.innerHTML = 'Opening chat...';
        try {
          window.paprAPI.invoke('chat.open', {
            message: 'My Home dashboard needs a Daily Brief Generator job. Please create an agent job linked to my Home app that generates a daily brief and saves it to the briefs table in $APP_DB (the app-linked database). The brief_json should include: hero (date, title, subtitle, stats), sections (priorities, timeline, alerts, freeform).'
          });
        } catch (e) { /* paprAPI may not be available */ }
        setTimeout(() => { btn.innerHTML = 'Generate My Real Brief'; btn.disabled = false; }, 2000);
        return;
      }
      
      const result = await response.json();
      if (!response.ok && response.status !== 409) {
        throw new Error(result?.error || 'Failed to start brief job');
      }

      btn.innerHTML = '<div class="spinner"></div>Working...';
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        if (window.PaprPreview && !window.PaprPreview.isVisible()) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        await new Promise((r) => setTimeout(r, 3000));
        const statusRes = await fetch(`/api/jobs/status/${jobId}`);
        if (!statusRes.ok) continue;
        const job = await statusRes.json();
        if (job.status === 'completed' || job.status === 'failed') {
          const rows = await Data.query(
            'SELECT date FROM briefs WHERE brief_json IS NOT NULL ORDER BY date DESC LIMIT 1',
          ).catch(() => []);
          if (rows.length > 0 || job.status === 'completed') {
            btn.innerHTML = job.status === 'failed' ? 'Brief saved — reloading…' : 'Generated! Reloading...';
            setTimeout(() => {
              this.dates = [];
              this.init();
            }, 800);
            return;
          }
          if (job.status === 'failed') {
            throw new Error(job.error || 'Brief job failed');
          }
        }
      }
      throw new Error('Brief generation is taking longer than expected');
    } catch (error) {
      console.error('Failed to generate brief:', error);
      btn.innerHTML = 'Opening chat...';
      try {
        window.paprAPI.invoke('chat.open', {
          message: `My Home dashboard brief failed: ${(error && error.message) || error}. Please fix the Daily Brief Generator job and data source link.`
        });
      } catch (e) { /* paprAPI may not be available */ }
      setTimeout(() => {
        btn.innerHTML = 'Generate My Real Brief';
        btn.disabled = false;
      }, 2500);
    }
  },
  renderLoadErrorBanner(message) {
    const safe = String(message || 'Database query failed').replace(/</g, '&lt;');
    return `
      <div class="load-error-banner">
        <div class="load-error-content">
          <div class="load-error-icon" aria-hidden="true">⚠</div>
          <div class="load-error-text">
            <strong>Could not load your brief</strong>
            <span class="load-error-detail">${safe}</span>
          </div>
          <button id="fix-load-error-btn" class="fix-load-error-btn" type="button">
            Ask Agent to fix
          </button>
        </div>
      </div>
    `;
  },
  renderSampleDataBanner() {
    if (!this.isSampleData) return '';
    
    return `
      <div class="sample-data-banner">
        <div class="sample-data-content">
          <div class="sample-data-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
              <path d="M9 18h6M10 22h4M12 2a6 6 0 0 0-3.4 11c.6.4 1 1 1.1 1.7V16h4.6v-1.3c.1-.7.5-1.3 1.1-1.7A6 6 0 0 0 12 2z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="sample-data-text">
            <strong>This is sample data</strong> — showing what your dashboard will look like when populated.
          </div>
          <button id="gen-real-brief-btn" class="gen-real-brief-btn">
            Generate My Real Brief
          </button>
        </div>
      </div>
    `;
  },
  async init() {
    this.dates = await Data.dates();
    if (!this.dates.length) this.dates = [Data.todayKey()];

    const [testBrief] = await Promise.all([Data.load(), Goals.load(), Reviews.hydrate()]);
    this.loadError = testBrief._loadError === true;
    this.isSampleData = !this.loadError && (this.dates.length === 0 || testBrief._isSample === true);
    
    await this.render(); FoldNav.bind(this); Goals.bind(document.getElementById('goals'));
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
    
    // Add click handler for generate button
    const genBtn = document.getElementById('gen-real-brief-btn');
    if (genBtn) {
      genBtn.addEventListener('click', () => this.generateRealBrief());
    }
  },
  bindLoadErrorButton(message) {
    const fixBtn = document.getElementById('fix-load-error-btn');
    if (!fixBtn) return;
    fixBtn.addEventListener('click', () => {
      const msg = message || 'Home dashboard cannot load briefs from the linked database.';
      try {
        window.paprAPI.invoke('chat.open', {
          message: `My Home dashboard cannot load briefs: ${msg}. Please check the Daily Brief Generator job link and data source alias.`,
        });
      } catch (e) { /* paprAPI may not be available */ }
    });
  },
  async render() {
    const date = this.dates[this.idx];
    let brief = await Data.load(date);
    this.loadError = brief._loadError === true;
    if (!this.loadError && brief._isSample && this.dates.length > 0) {
      brief = await Data.load();
      this.loadError = brief._loadError === true;
      if (!this.loadError && !brief._isSample && this.dates[this.idx] !== this.dates[0]) {
        this.idx = 0;
      }
    }
    this.brief = this.decorate(brief, date);
    
    // Render banner if sample data or load error
    const banner = this.loadError
      ? this.renderLoadErrorBanner(this.brief._errorMessage)
      : this.renderSampleDataBanner();
    
    document.getElementById('hero').innerHTML = banner + R.hero(this.brief.hero);
    document.getElementById('goals').innerHTML = this.idx === 0 ? Goals.render() : '';
    document.getElementById('sections').innerHTML = (this.brief.sections || []).map((s) => R.section(s)).join('');
    if (this.loadError) {
      this.bindLoadErrorButton(this.brief._errorMessage);
    }
    this.updateNav(); this.animateBars();
  },
  async review(btn) {
    const id = btn.dataset.id, next = btn.dataset.review, title = btn.dataset.title || 'this item';
    const state = this.loadState();
    const item = Reviews.findItem(this.brief, id) || { title };
    const briefDate = this.dates[this.idx] || Data.todayKey();
    let note;
    if (next === 'irrelevant') {
      const { askText } = await import('/__papr__/papr-dialog.ts');
      note = await askText(`Why is "${title}" irrelevant? Tomorrow's brief will use this to avoid similar items.`, '', state[id]?.note || '', 'Save');
      if (!note) return;
      state[id] = { status: 'irrelevant', note, at: new Date().toISOString() };
    } else if (next === 'complete') state[id] = { status: 'complete', at: new Date().toISOString() };
    else if (next === 'active') delete state[id];
    this.saveState(state); await this.render();
    // Write-through to the Home DB so the brief job + Sleep can act on it.
    try {
      if (next === 'active') await Reviews.remove(id, item);
      else await Reviews.upsert(id, item, briefDate, next, note);
    } catch (err) { console.warn('[home] review persist failed (cached locally):', err?.message || err); }
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