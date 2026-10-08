/* How a goal is measured outside chat. The server picks a tracker (Jev) and checks what you've
   connected; this card is the one tap to start tracking. Once numbers arrive, ThreeHero shows
   hours in vs. results out at the top of the goal page. */
const ThreeTrack = {
  busy: false,
  num(n) {
    if (n == null) return '—';
    const k = (d) => `${(n / 1000).toFixed(d).replace(/\.0$/, '')}k`;
    return n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e5 ? k(0) : n >= 1000 ? k(1) : String(n);
  },
  ago(iso) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 60 ? `${Math.max(1, m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  },
  html(g) {
    const t = g.tracker;
    if (!t) return '';
    const esc = (x) => Three.esc(x);
    const gid = esc(g.id);
    // Numbers live in the goal page hero (three_hero.js); this card only covers getting a tracker going.
    if (t.status === 'active' && t.metrics) return '';
    if (t.status === 'active') {
      return `<section class="hsec t3track"><h4>Results</h4><p class="t3sub">Tracking ${esc(t.title)}. First numbers land after its first run.</p></section>`;
    }
    if (t.status === 'needs_connect') {
      return `<section class="hsec t3track"><h4>Results</h4><p class="t3sub">Track ${esc(t.title)} automatically. Connect ${esc((t.missing || []).join(' or '))} first.</p>
        <button type="button" class="hfocus-ghost" data-three="track-connect" data-gid="${gid}">Connect</button></section>`;
    }
    const label = t.status === 'ready' ? `Track ${t.title}` : 'Build a tracker for this goal';
    const sub = t.status === 'ready'
      ? `Uses ${esc((t.connected || []).join(' + '))}, which you already connected. Runs daily.`
      : 'Pen builds a daily job that measures this goal from the tools you already use.';
    return `<section class="hsec t3track"><h4>Results</h4><p class="t3sub">${sub}</p>
      <button type="button" class="hfocus-ghost" data-three="track-create" data-gid="${gid}"${this.busy ? ' disabled' : ''}>${esc(label)}</button></section>`;
  },
  async act(act, g, btn) {
    if (act === 'track-connect') {
      const msg = `Connect ${(g.tracker?.missing || []).join(' and ')} so Focus can track my goal "${g.title}".`;
      if (window.paprAPI?.invoke) window.paprAPI.invoke('chat.open', { message: msg });
      return;
    }
    if (act !== 'track-create' || this.busy) return;
    this.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Setting up…'; }
    try {
      const r = await fetch('/api/workspace/focus/tracker', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goalId: g.id }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      await Three.load();
      if (Three.view === 'goal') Three.show('goal', g.id);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = `Couldn't start: ${e.message}`.slice(0, 80); }
    } finally {
      this.busy = false;
    }
  },
};
