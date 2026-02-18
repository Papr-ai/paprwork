// Reddit Studio v3.2 (Bash HEREDOC overwrite)
const get = (sel) => document.querySelector(sel);
const getAll = (sel) => document.querySelectorAll(sel);

/* --- STATE & DEFAULTS --- */
const STORAGE_KEY = 'papr_reddit_studio_v2';

const DEFAULTS = {
  mentionRatio: 30,
  disclosure: "(Disclosure: I'm a founder of Papr — predictive memory for AI agents.)",
  subreddits: ['RAG', 'LocalLLaMA', 'LLMDevs', 'SaaS', 'startups'],
};

let state = {
  view: 'dashboard',
  settings: structuredClone(DEFAULTS),
  threads: [],
  posts: [],
  activeThreadId: null,
  activePostId: null,
};

/* --- INIT --- */
function init() {
  console.log('Reddit Studio: Init v3.2');
  if (!load()) seed();
  
  const params = new URLSearchParams(window.location.search);
  if (params.get('view')) state.view = params.get('view');

  wireEvents();
  render();
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    state = { ...state, ...data };
    return true;
  } catch { return false; }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function seed() {
  const now = Date.now();
  state.threads = [
    {
      id: 't_1',
      title: 'How do you handle multi-tenant RAG isolation?',
      subreddit: 'SaaS',
      segment: 'vertical_saas',
      score: 12,
      context: 'Building a B2B app. Customers want AI search over their docs. How do you ensure Tenant A never sees Tenant B data in vector search?',
      replyDraft: "Common pattern is to enforce tenant_id filters at query time. Don't rely on the vector similarity alone.",
      status: 'queued',
      mentionPapr: false,
      createdAt: now
    },
    {
      id: 't_2',
      title: 'Agent memory across sessions - best practices?',
      subreddit: 'LocalLLaMA',
      segment: 'agent_builders',
      score: 45,
      context: 'My agent forgets everything after the chat closes. LangChain memory is too ephemeral. Any persistent solutions?',
      replyDraft: "You need a persistent layer like Redis or Postgres for session history, plus a semantic layer for long-term facts.",
      status: 'queued',
      mentionPapr: true,
      createdAt: now - 3600000
    }
  ];
  state.posts = [];
}

/* --- RENDERING --- */
function render() {
  // 1. Navigation State
  getAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === state.view);
  });
  
  getAll('.view-container').forEach(el => {
    const isActive = el.id === `view-${state.view}`;
    el.classList.toggle('active', isActive);
  });

  // 2. Badges
  const queuedCount = state.threads.filter(t => t.status === 'queued').length;
  if (get('#nav-badge-engage')) get('#nav-badge-engage').textContent = queuedCount;
  
  const draftCount = state.posts.filter(p => p.status === 'draft').length;
  if (get('#nav-badge-posts')) get('#nav-badge-posts').textContent = draftCount;

  // 3. Page Content
  if (state.view === 'dashboard') renderDashboard();
  if (state.view === 'engage') renderEngage();
  if (state.view === 'posts') renderPosts();
  if (state.view === 'settings') renderSettings();
}

/* --- DASHBOARD --- */
function renderDashboard() {
  const ready = state.threads.filter(t => t.status === 'queued').length;
  const drafted = state.threads.filter(t => t.status === 'drafted').length; 
  
  // Mentions
  const withMention = state.threads.filter(t => t.mentionPapr && t.status === 'done').length;
  const doneTotal = state.threads.filter(t => t.status === 'done').length;
  const rate = doneTotal ? Math.round((withMention / doneTotal) * 100) : 0;

  if (get('#dash-ready')) get('#dash-ready').textContent = ready;
  if (get('#dash-drafted')) get('#dash-drafted').textContent = drafted;
  if (get('#dash-mention')) get('#dash-mention').textContent = `${rate}%`;
}

/* --- ENGAGE VIEW --- */
function renderEngage() {
  const list = get('#engage-list');
  if (!list) return;
  list.innerHTML = '';
  
  const filter = (get('#engage-search').value || '').toLowerCase();
  
  state.threads
    .filter(t => t.status !== 'skipped' && t.status !== 'done') 
    .filter(t => !filter || t.title.toLowerCase().includes(filter))
    .forEach(t => {
      const el = document.createElement('div');
      el.className = `list-item ${t.id === state.activeThreadId ? 'selected' : ''}`;
      el.innerHTML = `
        <div class="item-title">${escapeHtml(t.title)}</div>
        <div class="item-meta">
          <span class="chip">r/${t.subreddit}</span>
          <span>${new Date(t.createdAt).toLocaleDateString()}</span>
        </div>
      `;
      el.onclick = () => selectThread(t.id);
      list.appendChild(el);
    });

  const active = state.threads.find(t => t.id === state.activeThreadId);
  if (active) {
    get('#engage-empty').classList.add('hidden');
    get('#engage-detail').classList.remove('hidden');
    
    get('#detail-title').textContent = active.title;
    get('#detail-sub').textContent = `r/${active.subreddit}`;
    get('#detail-score').textContent = `Score ${active.score}`;
    get('#detail-context').textContent = active.context;
    get('#detail-reply').value = active.replyDraft || '';
    get('#detail-mention-toggle').checked = active.mentionPapr;
  } else {
    get('#engage-empty').classList.remove('hidden');
    get('#engage-detail').classList.add('hidden');
  }
}

function selectThread(id) {
  state.activeThreadId = id;
  render();
}

/* --- POSTS VIEW --- */
function renderPosts() {
  const list = get('#posts-list');
  if (!list) return;
  list.innerHTML = '';
  
  const filter = (get('#posts-search').value || '').toLowerCase();
  
  state.posts
    .filter(p => !filter || (p.title || '').toLowerCase().includes(filter))
    .forEach(p => {
      const el = document.createElement('div');
      el.className = `list-item ${p.id === state.activePostId ? 'selected' : ''}`;
      el.innerHTML = `
        <div class="item-title">${escapeHtml(p.title || 'Untitled Draft')}</div>
        <div class="item-meta">
          <span class="chip">${p.status}</span>
          <span>${new Date(p.createdAt).toLocaleDateString()}</span>
        </div>
      `;
      el.onclick = () => selectPost(p.id);
      list.appendChild(el);
    });

  const active = state.posts.find(p => p.id === state.activePostId);
  if (active) {
    get('#posts-empty').classList.add('hidden');
    get('#posts-detail').classList.remove('hidden');
    
    get('#post-title-edit').value = active.title || '';
    get('#post-body').value = active.body || '';
    get('#post-status').textContent = active.status;
  } else {
    get('#posts-empty').classList.remove('hidden');
    get('#posts-detail').classList.add('hidden');
  }
}

function selectPost(id) {
  state.activePostId = id;
  render();
}

/* --- SETTINGS VIEW --- */
function renderSettings() {
  if (document.activeElement.id !== 'set-mention-ratio') {
     const el = get('#set-mention-ratio');
     if (el) el.value = state.settings.mentionRatio;
     const val = get('#set-mention-val');
     if (val) val.textContent = `${state.settings.mentionRatio}%`;
  }
  if (document.activeElement.id !== 'set-disclosure') {
     const el = get('#set-disclosure');
     if (el) el.value = state.settings.disclosure;
  }
  if (document.activeElement.id !== 'set-subs') {
     const el = get('#set-subs');
     if (el) el.value = state.settings.subreddits.join('\n');
  }
}

/* --- ACTIONS --- */
function wireEvents() {
  getAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      state.view = el.dataset.view;
      save();
      render();
    });
  });

  if(get('#engage-search')) get('#engage-search').addEventListener('input', renderEngage);
  
  if(get('#detail-reply')) get('#detail-reply').addEventListener('input', (e) => {
    const t = state.threads.find(x => x.id === state.activeThreadId);
    if (t) { t.replyDraft = e.target.value; save(); }
  });

  if(get('#detail-mention-toggle')) get('#detail-mention-toggle').addEventListener('change', (e) => {
    const t = state.threads.find(x => x.id === state.activeThreadId);
    if (t) { t.mentionPapr = e.target.checked; save(); }
  });
  
  if(get('#btn-copy-reply')) get('#btn-copy-reply').addEventListener('click', () => {
    const t = state.threads.find(x => x.id === state.activeThreadId);
    if (t) copyToClipboard(t.replyDraft);
  });
  
  if(get('#btn-done')) get('#btn-done').addEventListener('click', () => {
    const t = state.threads.find(x => x.id === state.activeThreadId);
    if (t) {
      t.status = 'done';
      state.activeThreadId = null; 
      save();
      render();
    }
  });
  
  if(get('#btn-skip')) get('#btn-skip').addEventListener('click', () => {
     const t = state.threads.find(x => x.id === state.activeThreadId);
     if (t) {
       t.status = 'skipped';
       state.activeThreadId = null;
       save();
       render();
     }
  });

  // Post Actions
  if(get('#btn-new-post')) get('#btn-new-post').addEventListener('click', () => {
    const newPost = {
      id: 'p_' + Date.now(),
      title: 'New Post Draft',
      body: '',
      status: 'draft',
      createdAt: Date.now()
    };
    state.posts.unshift(newPost);
    state.activePostId = newPost.id;
    save();
    render();
  });
  
  if(get('#post-title-edit')) get('#post-title-edit').addEventListener('input', (e) => {
    const p = state.posts.find(x => x.id === state.activePostId);
    if (p) { p.title = e.target.value; save(); }
  });
  
  if(get('#post-body')) get('#post-body').addEventListener('input', (e) => {
    const p = state.posts.find(x => x.id === state.activePostId);
    if (p) { p.body = e.target.value; save(); }
  });

  // Settings
  if(get('#btn-save-settings')) get('#btn-save-settings').addEventListener('click', () => {
    state.settings.mentionRatio = get('#set-mention-ratio').value;
    state.settings.disclosure = get('#set-disclosure').value;
    state.settings.subreddits = get('#set-subs').value.split('\n').map(s => s.trim()).filter(Boolean);
    save();
    alert('Settings saved');
  });

  if(get('#themeToggle')) get('#themeToggle').addEventListener('click', () => {
    const html = document.documentElement;
    html.dataset.theme = html.dataset.theme === 'light' ? 'dark' : 'light';
  });
  
  // Dashboard Actions
  if(get('#dash-go-engage')) get('#dash-go-engage').addEventListener('click', () => {
     state.view = 'engage';
     save();
     render();
  });
  
  if(get('#dash-new-post')) get('#dash-new-post').addEventListener('click', () => {
     state.view = 'posts';
     save();
     render();
     // Trigger new post
     $('#btn-new-post').click();
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text);
  const btn = document.activeElement;
  const originalText = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = originalText, 1500);
}

init();
