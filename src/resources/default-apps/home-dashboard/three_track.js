/* How a goal is measured outside chat. The server picks a tracker (Jev) and checks what you've
   connected; this card shows the numbers, or one tap to start tracking. Hours in vs. results out
   sit side by side so time spent on a priority can be weighed against what it produced. */
const ThreeTrack = {
  busy: false,
  num(n) {
    if (n == null) return '—';
    return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  },
  ago(iso) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 60 ? `${Math.max(1, m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  },
  /** "4.2h this week → 7 posts · 21 engagements" — the return on the time. */
  roi(g, s) {
    const h = g.signals?.hours7 || 0;
    const out = [s.posts7 != null && `${s.posts7} posts`, s.engagement7 != null && `${this.num(s.engagement7)} engagements`,
      s.impressions7 != null && `${this.num(s.impressions7)} views`].filter(Boolean);
    if (!out.length) return '';
    return `<p class="t3roi"><b>${Three.hours(h)}</b> in chats this week <span>→</span> ${out.join(' · ')}</p>`;
  },
  html(g) {
    const t = g.tracker;
    if (!t) return '';
    const esc = (x) => Three.esc(x);
    const gid = esc(g.id);
    if (t.status === 'active' && t.metrics) {
      const s = t.metrics.summary || {};
      const keys = Object.keys(t.metrics.labels || {}).filter((k) => k in s);
      const stats = keys.slice(0, 4).map((k) => `<div><b>${this.num(s[k])}</b><span>${esc(t.metrics.labels[k])}</span></div>`).join('');
      const down = Object.entries(t.metrics.sources || {}).filter(([, v]) => !v.ok && v.error !== 'not connected')
        .map(([k, v]) => `<li>${esc(k)}: ${esc(v.error || 'unavailable')}</li>`).join('');
      return `<section class="hsec t3track"><h4>Results <em>${esc(this.ago(t.metrics.updatedAt))}</em></h4>
        ${this.roi(g, s)}<div class="t3stat t3stat-sm">${stats}</div>${down ? `<ul class="t3warn">${down}</ul>` : ''}</section>`;
    }
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
