/* Monday review — the fresh-start moment. Answers three questions in two minutes:
   did I focus (share of chat time on the three), did it move (per goal), and are these still the
   right three (one decision). Shows as a banner above Your three Mon–Wed until done for the week.
   All numbers come from /api/workspace/focus (trailing 7 days) — no new backend. */
const WeekReview = {
  TARGET: 70,
  KEY: 'papr.home.weekReview',
  dropped: false,
  /** ISO week of the Monday that starts this week, e.g. "2026-09-28". */
  weekKey(now = new Date()) {
    const d = new Date(now); d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  },
  reviewed() { try { return localStorage.getItem(this.KEY) === this.weekKey(); } catch { return false; } },
  markDone() { try { localStorage.setItem(this.KEY, this.weekKey()); } catch { /* storage off */ } },
  due(now = new Date()) {
    const day = now.getDay(); // Mon=1 … Wed=3
    return Three.has() && day >= 1 && day <= 3 && !this.reviewed();
  },
  banner() {
    if (!this.due()) return '';
    return `<button type="button" class="wrbanner" data-three="review"><span>Your Monday review is ready</span><b>2 min</b>${Three.ARROW}</button>`;
  },
  range(now = new Date()) {
    const end = new Date(now); end.setDate(end.getDate() - 1);
    const start = new Date(now); start.setDate(start.getDate() - 7);
    const f = (d, o) => d.toLocaleDateString('en-US', o);
    const sameMonth = start.getMonth() === end.getMonth();
    return `${f(start, { month: 'short', day: 'numeric' })}–${sameMonth ? end.getDate() : f(end, { month: 'short', day: 'numeric' })}`;
  },
  /** Moved = real time went in; touched = a little; none = the goal sat still. */
  pace(s) { return Three.pace(s); },
  row(g) {
    const s = g.signals || {};
    const [cls, label] = this.pace(s);
    const bits = [`${Three.hours(s.hours7)} in chats`, s.openTasks ? `${s.openTasks} open task${s.openTasks > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
    return `<div class="wrrow"><b>${Three.esc(g.title)}</b><span>${bits}</span><em class="wrpill is-${cls}">${label}</em></div>`;
  },
  /** The biggest time sink outside the three — only when it's big enough to matter (3h+). */
  drift() {
    if (this.dropped) return null;
    const top = [...(Three.data?.candidates || [])].sort((a, b) => (b.signals?.hours7 || 0) - (a.signals?.hours7 || 0))[0];
    return top && (top.signals?.hours7 || 0) >= 3 ? top : null;
  },
  render() {
    const d = Three.data;
    const pct = d.alignedPct;
    const head = pct == null ? "Here's where last week went." : `Last week, ${pct}% of your chat time went to your three.`;
    const bar = pct == null ? '' : `<div class="wrbar"><i style="width:${Math.min(100, pct)}%"></i><b style="left:${this.TARGET}%" title="Your target"></b></div>
      <p class="t3sub">Your target is ${this.TARGET}%. ${pct >= this.TARGET ? 'You hit it.' : "Here's what it moved."}</p>`;
    const dr = this.drift();
    const driftCard = dr ? `<section class="wrdrift"><b>${Three.hours(dr.signals.hours7)} went to ${Three.esc(dr.title)}.</b>
      <p>It isn't one of your three. Make it one, or let it go this week?</p>
      <nav><button type="button" class="t3link" data-three="wr-change">Make it one of three</button>
        <button type="button" class="t3link quiet" data-three="wr-drop">Let it go</button></nav></section>` : '';
    return `<div class="t3wrap wr">
      <button type="button" class="t3back" data-three="close">${Three.BACK}Focus</button>
      <p class="hero-date">Monday review · ${this.range()}</p>
      <h2 class="hero-title">${head}</h2>${bar}
      <section class="wrlist">${d.three.map((g) => this.row(g)).join('')}</section>
      ${driftCard}
      <h4 class="wrq">Still the right three for this week?</h4>
      <footer class="t3foot"><button type="button" class="hfocus-primary" data-three="wr-keep">Keep all three</button>
        <button type="button" class="hfocus-ghost" data-three="wr-change">Change one</button></footer>
    </div>`;
  },
  async act(act) {
    if (act === 'wr-drop') { this.dropped = true; Three.show('review'); return; }
    this.markDone();
    if (act === 'wr-change') { Three.show('edit'); return; }
    // Keep all three = confirm the current picks as the user's own for this week.
    const picks = ThreeEdit.picksFrom(Three.data.three);
    try {
      const r = await fetch('/api/workspace/focus', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ picks, confirm: true }) });
      if (r.ok) Three.data = await r.json();
    } catch (err) { console.warn('[home] week review save failed:', err?.message || err); }
    Three.close();
  },
};
