const R = {
  hero(h) {
    const stats = (h.stats||[]).map(s =>
      `<div class="stat"><div class="stat-num">${s.value}</div><div class="stat-label">${s.label}</div></div>`
    ).join('');
    return `<div class="hero-date">${h.date}</div>
      <h1 class="hero-title">${h.title || 'Daily Brief'}</h1>
      <div class="hero-stats">${stats}</div>`;
  },
  timeline(items) {
    return items.map((m,i) => {
      const ext = m.tags?.includes('external');
      const tags = (m.tags||[]).map(t =>
        `<span class="tag ${t==='external'?'tag-ext':'tag-int'}">${t}</span>`).join('');
      const detail = m.detail ? Object.entries(m.detail).map(([k,v]) =>
        `<div class="detail-row"><div class="detail-label">${k}</div><div class="detail-text">${v}</div></div>`
      ).join('') : '';
      return `<div class="card ${ext?'card-ext':''}" data-idx="${i}">
        <div class="tl-head"><span class="tl-time">${m.time}</span>
          <span class="tl-title">${m.title}</span><div class="tl-tags">${tags}</div></div>
        ${detail ? `<div class="tl-detail"><div class="tl-detail-inner">${detail}</div></div>` : ''}
      </div>`;
    }).join('');
  },
  priorities(items) {
    return items.map(p => `<div class="card"><div class="pri-head">
      <span class="pri-rank">${p.rank}</span><div class="pri-body">
        <div class="pri-title">${p.title}</div>
        <div class="pri-why">${p.why||''}</div></div></div></div>`).join('');
  },
  tracker(items) {
    return items.map(t => {
      const pct = Math.round((t.current/t.target)*100);
      return `<div class="card"><div class="tracker-label">
        <span>${t.label}</span><span class="tracker-val">${t.current}/${t.target} ${t.unit||''}</span></div>
        <div class="tracker-bar-bg"><div class="tracker-bar-fill" style="width:${pct}%"></div></div>
        ${t.context ? `<div class="tracker-ctx">${t.context}</div>` : ''}</div>`;
    }).join('');
  },
  intel(items) {
    return items.map(n => `<div class="card">
      <div class="intel-subject">${n.subject}</div>
      ${(n.bullets||[]).map(b => `<div class="intel-bullet">${b}</div>`).join('')}
      ${n.source ? `<div class="intel-src">${n.source}</div>` : ''}</div>`).join('');
  },
  alerts(items) {
    const icons = {high:'🔴',medium:'🟡',low:'🟢'};
    return items.map(a => `<div class="card sev-${a.severity||'med'}"><div class="alert-card">
      <span class="alert-icon">${icons[a.severity]||'⚠️'}</span><div>
        <div class="alert-msg">${a.message}</div>
        ${a.action ? `<div class="alert-action">→ ${a.action}</div>` : ''}</div></div></div>`).join('');
  },
  freeform(content) { return `<div class="card"><div class="freeform">${content}</div></div>`; },
  section(s) {
    const body = s.type==='freeform' ? this.freeform(s.content) : (this[s.type]?.(s.items)||'');
    return `<section class="section"><h2 class="section-title">${s.title}</h2>${body}</section>`;
  }
};