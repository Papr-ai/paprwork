/* Goal page hero: the summary above "Moves it". It answers one question: is the time I put into this goal paying off?
   It shows one number (the payoff), one chart (the last 7 days against the target), real faces and logos (not
   labels), and the best evidence as tiles. Design rules and sources: resources/skills/goal-page-design.md. */
const ThreeHero = {
  DOMAINS: { x: 'x.com', twitter: 'x.com', linkedin: 'linkedin.com', stripe: 'stripe.com', posthog: 'posthog.com', github: 'github.com' },
  NAMES: { x: 'X', linkedin: 'LinkedIn' },
  safe(u) { return typeof u === 'string' && /^https:\/\//.test(u) ? Three.esc(u) : ''; },
  /** Real brand marks: Google's favicon service turns any domain into its logo. */
  logo(domain, sz = 64) { return domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${sz}` : ''; },
  domainOf(src, url) {
    if (this.DOMAINS[src]) return this.DOMAINS[src];
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  },
  img(src, cls, alt = '') { return src ? `<img class="${cls}" src="${src}" alt="${Three.esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''; },
  dayKey(d) { return d.toLocaleDateString('en-CA'); },
  /** The payoff number in the unit its tracker declared. Plain numbers stay as they were. */
  fmt(v, f) {
    if (typeof v !== 'number') return '';
    if (f === 'usd') return `$${ThreeTrack.num(Math.round(v))}`;
    if (f === 'pts') return `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)}`;
    if (f === 'percent') return `${Math.round(v)}%`;
    return ThreeTrack.num(v);
  },
  /** The last 7 local days, built from the evidence (items[].at): items, views, and which sources showed up each day. */
  week(items) {
    const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 6 + i); return { d, n: 0, views: 0, src: new Set() }; });
    const by = Object.fromEntries(days.map((x) => [this.dayKey(x.d), x]));
    for (const it of items) {
      const day = it.at && by[this.dayKey(new Date(it.at))];
      if (day) { day.n++; day.views += it.impressions || 0; day.src.add(it.source); }
    }
    return days;
  },
  /** Bars share one baseline, so lengths compare at a glance. The dashed line is the daily target. */
  bars(cols, target) {
    const max = Math.max(target || 0, ...cols.map((c) => c.v), 1);
    const line = target ? `<i class="hh-goal" style="bottom:calc(18px + (100% - 18px) * ${(target / max).toFixed(3)})"></i>` : '';
    return `<div class="hh-bars">${line}${cols.map((c) => `<div class="hh-col${c.today ? ' is-today' : ''}" title="${Three.esc(c.title)}">
      <span class="hh-bar ${c.cls}" style="height:${c.v ? Math.max(8, (c.v / max) * 100) : 0}%"></span><em>${Three.esc(c.label)}</em></div>`).join('')}</div>`;
  },
  chart(m, nSrc) {
    const c = m.display?.chart;
    if (c?.bars?.length) {
      const cols = c.bars.map((x, i) => ({ v: Math.max(0, x.value), today: i === c.bars.length - 1, cls: x.tone === 'full' ? 'is-full' : x.tone === 'part' ? 'is-part' : '', label: x.label, title: x.title || `${x.label} · ${ThreeTrack.num(x.value)}` }));
      return `<div class="hh-chart"><p class="hh-cap">${Three.esc(c.caption)}</p>${this.bars(cols, c.target || 0)}</div>`;
    }
    const items = (m.items || []).filter((i) => i.at);
    if (items.length) {
      const days = this.week(items);
      const hit = days.filter((d) => d.n > 0).length;
      const cols = days.map((d, i) => ({
        v: d.n, today: i === 6, label: d.d.toLocaleDateString('en-US', { weekday: 'narrow' }),
        cls: d.src.size >= nSrc ? 'is-full' : d.n ? 'is-part' : '',
        title: `${d.d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.n} posted${d.views ? ` · ${ThreeTrack.num(d.views)} views` : ''}`,
      }));
      return `<div class="hh-chart"><p class="hh-cap"><b>${hit} of 7 days</b> showed up</p>${this.bars(cols, nSrc)}</div>`;
    }
    const hist = (m.history || []).filter((h) => typeof h[m.hero] === 'number').slice(-14);
    if (hist.length < 2) return '';
    const cols = hist.map((h, i) => ({ v: h[m.hero], today: i === hist.length - 1, cls: 'is-full', label: h.date.slice(8),
      title: `${h.date} · ${ThreeTrack.num(h[m.hero])}` }));
    return `<div class="hh-chart"><p class="hh-cap"><b>Last ${hist.length} days</b></p>${this.bars(cols, 0)}</div>`;
  },
  /** Up/down against the snapshot from 7+ days ago. It stays hidden until there is a real week to compare. */
  delta(m) {
    const now = m.summary?.[m.hero];
    const cut = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const then = [...(m.history || [])].reverse().find((h) => h.date <= cut && typeof h[m.hero] === 'number')?.[m.hero];
    if (m.display?.format === 'pts' || typeof now !== 'number' || !then) return '';
    const pct = Math.round(((now - then) / then) * 100);
    return pct ? `<em class="hh-delta is-${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}% vs last week</em>` : '';
  },
  faces(sources, gid) {
    return Object.entries(sources || {}).map(([k, v]) => {
      const p = v.profile || {}, dom = this.domainOf(k, p.url), name = p.name || this.NAMES[k] || k;
      const tip = v.ok ? [p.handle && `@${p.handle}`, name, p.followers != null && `${ThreeTrack.num(p.followers)} followers`].filter(Boolean).join(' · ')
        : `${name}: ${v.error === 'not connected' ? 'not connected' : 'needs attention. Tap to fix'}`;
      const face = this.safe(p.avatar) ? this.img(this.safe(p.avatar), 'hh-av', name) : `<span class="hh-av hh-initial">${Three.esc((p.name || name)[0] || '?')}</span>`;
      const inner = `${face}${this.img(this.logo(dom, 32), 'hh-badge')}`;
      return v.ok ? `<a class="hh-face" href="${this.safe(p.url) || '#'}" target="_blank" rel="noopener" title="${Three.esc(tip)}">${inner}</a>`
        : `<button type="button" class="hh-face is-off" title="${Three.esc(tip)}" data-three="hero-fix" data-gid="${Three.esc(gid)}" data-src="${Three.esc(k)}">${inner}</button>`;
    }).join('');
  },
  /** The evidence as tiles (like Photos): the 3 posts or deals that did the most, each with its logo or face. */
  best(items) {
    const own = items.some((i) => i.value != null);
    const top = own ? items.slice(0, 3) : [...items].sort((a, b) => (b.impressions || 0) - (a.impressions || 0) || (b.engagement || 0) - (a.engagement || 0)).slice(0, 3);
    if (!top.length) return '';
    return `<div class="hh-best">${top.map((it) => {
      const pic = this.safe(it.image) || this.logo(it.domain || this.domainOf(it.source, it.url), 64);
      const n = own ? it.value : it.impressions ?? it.engagement;
      const unit = own ? it.unit || '' : it.impressions != null ? 'views' : 'engagements';
      return `<a class="hh-tile" href="${this.safe(it.url) || '#'}" target="_blank" rel="noopener">${this.img(pic, it.image ? 'hh-thumb' : 'hh-logo')}
        <p>${Three.esc(it.text || it.source)}</p>${n != null ? `<b>${own && it.unit === 'pts' ? this.fmt(n, 'pts') : ThreeTrack.num(n)}<span>${Three.esc(own && it.unit === 'pts' ? 'pts' : unit)}</span></b>` : ''}</a>`;
    }).join('')}</div>`;
  },
  html(g) {
    const s = g.signals || {}, t = g.tracker?.status === 'active' ? g.tracker.metrics : null;
    const m = t && { ...t, hero: t.hero || Object.keys(t.labels || {}).find((k) => t.summary?.[k] != null) };
    if (!m || m.summary?.[m.hero] == null) {
      const rest = [s.chats30 && `${s.chats30} chats this month`, s.openTasks && `${s.openTasks} open tasks`].filter(Boolean).join(' · ');
      return `<section class="hhero"><div class="hh-top"><div><b class="hh-num">${Three.hours(s.hours7)}</b><span class="hh-lab">In chats this week</span></div></div>${rest ? `<p class="hh-roi">${rest}</p>` : ''}</section>`;
    }
    const sum = m.summary, live = Object.values(m.sources || {}).filter((v) => v.ok).length || 1;
    const out = Object.keys(m.labels || {}).filter((k) => k !== m.hero && /posts|engagement|customers|meetings|signups|new/.test(k) && sum[k] != null).slice(0, 2)
      .map((k) => `${ThreeTrack.num(sum[k])} ${/engagement/.test(k) ? 'engagements' : Three.esc(m.labels[k].replace(/ this week$/i, '').toLowerCase())}`);
    return `<section class="hhero">
      <div class="hh-top"><div><b class="hh-num">${this.fmt(sum[m.hero], m.display?.format)}</b><span class="hh-lab">${Three.esc(m.display?.label || m.labels?.[m.hero] || m.hero)}${this.delta(m)}</span></div>
        <div class="hh-faces">${this.faces(m.sources, g.id)}</div></div>
      <p class="hh-roi"><b>${Three.hours(s.hours7)}</b> in chats <span aria-hidden="true">→</span> ${Three.esc(m.display?.line || '') || out.join(' · ') || 'results'}</p>
      ${this.chart(m, live)}${this.best(m.items || [])}
      <p class="hh-foot">Updated ${ThreeTrack.ago(m.updatedAt)}</p></section>`;
  },
  fix(g, src) {
    const v = g.tracker?.metrics?.sources?.[src] || {};
    const msg = `My Focus tracker for "${g.title}" can't read ${this.NAMES[src] || src}: ${v.error || 'unknown error'}. Fix it and re-run the tracker.`;
    if (window.paprAPI?.invoke) window.paprAPI.invoke('chat.open', { message: msg });
  },
};
