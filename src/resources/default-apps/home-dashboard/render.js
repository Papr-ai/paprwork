const AGENT_SVG = `<svg viewBox="0 0 20 20" fill="none"><path d="M12.2 16.5c-.22 0-.36-.14-.4-.34-.43-3.02-.83-3.7-3.98-4.01-.21-.03-.35-.18-.35-.38 0-.19.14-.34.35-.37 3.14-.43 3.42-.97 3.98-4.01.06-.2.2-.34.4-.34.18 0 .33.15.37.35.44 2.97.86 3.57 4 4 .2.03.34.18.34.37 0 .2-.14.36-.34.38-3.15.42-3.43.99-4 4.01-.05.19-.19.34-.37.34zm-4.07 1.68c-.15 0-.24-.1-.29-.26-.29-1.48-.16-1.54-1.78-1.79-.17-.03-.27-.12-.27-.28 0-.15.1-.26.25-.28 1.64-.28 1.51-.35 1.8-1.85.05-.16.15-.26.29-.26.16 0 .26.11.3.26.27 1.46.18 1.53 1.81 1.81.14.02.25.13.25.28 0 .14-.11.25-.25.28-1.64.25-1.54.31-1.81 1.82-.04.14-.15.23-.3.27z" fill="currentColor"/></svg>`;
function hoverActions(item, type, context) {
  return `<div class="card-hi">${reviewIcons(item)}<button class="hi-btn sparkle" data-agent="${encodeURIComponent(JSON.stringify({type, ...context}))}" title="Chat with agent">${AGENT_SVG}</button></div>`;
}
const CHECK_SVG = `<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DISMISS_SVG = `<svg viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const UNDO_SVG = `<svg viewBox="0 0 16 16" fill="none"><path d="M3 6h7a3 3 0 0 1 0 6H8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 3.5L3 6l2.5 2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const EDIT_SVG = `<svg viewBox="0 0 16 16" fill="none"><path d="M9.5 3.5l3 3L5 14H2v-3l7.5-7.5z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function reviewMeta(item) {
  const r = item._review || {};
  const note = r.status === 'irrelevant' && r.note ? `<div class="review-note">Clarification: ${r.note}</div>` : '';
  const badge = r.status === 'complete' ? '<span class="review-badge done">Completed</span>' : r.status === 'irrelevant' ? '<span class="review-badge off">Irrelevant</span>' : '';
  return `${badge}${note}`;
}
function reviewIcons(item) {
  const r = item._review || {}, label = item.title || item.subject || item.label || item.message || 'item';
  if (r.status) {
    return `<button class="hi-btn undo" data-review="active" data-id="${item._id}" data-title="${label}" title="Undo">${UNDO_SVG}</button>${r.status === 'irrelevant' ? `<button class="hi-btn edit" data-review="irrelevant" data-id="${item._id}" data-title="${label}" title="Edit note">${EDIT_SVG}</button>` : ''}`;
  }
  return `<button class="hi-btn check" data-review="complete" data-id="${item._id}" data-title="${label}" title="Mark complete">${CHECK_SVG}</button><button class="hi-btn dismiss" data-review="irrelevant" data-id="${item._id}" data-title="${label}" title="Mark irrelevant">${DISMISS_SVG}</button>`;
}
const R = {
  hero(h) {
    const hero = h && typeof h === 'object' ? h : { date: '', title: 'Daily Brief', stats: [] };
    const stats = (hero.stats||[]).map(s => `<div class="stat"><div class="stat-num">${s.value}</div><div class="stat-label">${s.label}</div></div>`).join('');
    return `<div class="hero-date">${hero.date || ''}</div><h1 class="hero-title">${hero.title || 'Daily Brief'}</h1><div class="hero-stats">${stats}</div>`;
  },
  timeline(items) {
    return items.map((m,i) => {
      const tags = (m.tags||[]).map(t => `<span class="tag ${t==='external'?'tag-ext':'tag-int'}">${t}</span>`).join('');
      const detail = m.detail ? Object.entries(m.detail).map(([k,v]) => `<div class="detail-row"><div class="detail-label">${k}</div><div class="detail-text">${v}</div></div>`).join('') : '';
      return `<div class="card ${m.tags?.includes('external')?'card-ext':''}" data-idx="${i}"><div class="tl-head"><span class="tl-time">${m.time}</span><span class="tl-title">${m.title}</span><div class="tl-tags">${tags}</div></div>${detail ? `<div class="tl-detail"><div class="tl-detail-inner">${detail}</div></div>` : ''}${reviewMeta(m)}${hoverActions(m, 'meeting', {time:m.time,title:m.title,detail:m.detail})}</div>`;
    }).join('');
  },
  priorities(items) {
    return items.map(p => `<div class="card"><div class="pri-head"><span class="pri-rank">${p.rank}</span><div class="pri-body"><div class="pri-title">${p.title}</div><div class="pri-why">${p.why||''}</div></div></div>${reviewMeta(p)}${hoverActions(p, 'priority', {rank:p.rank,title:p.title,why:p.why})}</div>`).join('');
  },
  tracker(items) {
    return items.map(t => `<div class="card"><div class="tracker-label"><span>${t.label}</span><span class="tracker-val">${t.current}/${t.target} ${t.unit||''}</span></div><div class="tracker-bar-bg"><div class="tracker-bar-fill" style="width:${Math.round((t.current/t.target)*100)}%"></div></div>${t.context ? `<div class="tracker-ctx">${t.context}</div>` : ''}${reviewMeta(t)}${hoverActions(t, 'tracker', {label:t.label,current:t.current,target:t.target,unit:t.unit,context:t.context})}</div>`).join('');
  },
  intel(items) {
    return items.map(n => `<div class="card"><div class="intel-subject">${n.subject}</div>${(n.bullets||[]).map(b => `<div class="intel-bullet">${b}</div>`).join('')}${n.source ? `<div class="intel-src">${n.source}</div>` : ''}${reviewMeta(n)}${hoverActions(n, 'intel', {subject:n.subject,bullets:n.bullets})}</div>`).join('');
  },
  alerts(items) {
    const severityClass = (sev) => {
      if (sev === 'high') return 'sev-dot-high';
      if (sev === 'low') return 'sev-dot-low';
      if (sev === 'medium') return 'sev-dot-medium';
      return 'sev-dot-info';
    };
    return items.map(a => `<div class="card sev-${a.severity||'med'}"><div class="alert-card"><span class="alert-icon"><span class="alert-dot ${severityClass(a.severity)}"></span></span><div><div class="alert-msg">${a.message}</div>${a.action ? `<div class="alert-action">→ ${a.action}</div>` : ''}</div></div>${reviewMeta(a)}${hoverActions(a, 'alert', {message:a.message,action:a.action,severity:a.severity})}</div>`).join('');
  },
  reviewed(items) {
    return items.map(i => `<div class="card reviewed-card"><div class="reviewed-kicker">${i._section}</div><div class="reviewed-title">${i.title || i.subject || i.label || i.message}</div>${i.why ? `<div class="pri-why">${i.why}</div>` : ''}${i.context ? `<div class="tracker-ctx">${i.context}</div>` : ''}${i.action ? `<div class="alert-action">→ ${i.action}</div>` : ''}${reviewMeta(i)}<div class="card-hi">${reviewIcons(i)}</div></div>`).join('');
  },
  freeform(content) { return `<div class="card"><div class="freeform">${content}</div></div>`; },
  section(s) { return `<section class="section"><h2 class="section-title">${s.title}</h2>${s.type==='freeform' ? this.freeform(s.content) : (this[s.type]?.(s.items)||'')}</section>`; }
};