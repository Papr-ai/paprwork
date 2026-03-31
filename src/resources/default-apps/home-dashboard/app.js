const App = {
  dates: [], idx: 0, turning: false, labelTimer: null,
  fmtDate(d) { return new Date(d + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); },
  animateBars() {
    setTimeout(() => document.querySelectorAll('.tracker-bar-fill').forEach((bar) => {
      const w = bar.style.width; bar.style.width = '0%'; requestAnimationFrame(() => bar.style.width = w);
    }), 80);
  },
  async init() {
    this.dates = await Data.dates();
    if (!this.dates.length) this.dates = [new Date().toISOString().slice(0, 10)];
    await this.render();
    FoldNav.bind(this);
    document.getElementById('sections').addEventListener('click', (e) => {
      const card = e.target.closest('.card[data-idx]');
      if (card) card.querySelector('.tl-detail')?.classList.toggle('open');
    });
  },
  async render() {
    const brief = await Data.load(this.dates[this.idx]);
    document.getElementById('hero').innerHTML = R.hero(brief.hero);
    document.getElementById('sections').innerHTML = (brief.sections || []).map((s) => R.section(s)).join('');
    this.updateNav(); this.animateBars();
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
    this.idx = next;
    await this.render();
    app.classList.remove('turn-prev', 'turn-next');
    app.classList.add('turn-in');
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
  }
};
App.init();