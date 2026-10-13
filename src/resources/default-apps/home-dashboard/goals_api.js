/* Direct goal writes from Home — PATCH /api/workspace/goals/:id (DB is the source of truth,
   the gateway validates and mirrors IDENTITY.md). One-click actions skip the chat round-trip;
   anything that needs words (close outcome, edit, reject reason) still goes through Pen. */
const GoalsApi = {
  async patch(id, body) {
    const r = await fetch(`/api/workspace/goals/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-papr-actor': 'home' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  },
  async refresh() {
    await Goals.load();
    const el = document.getElementById('goals');
    if (el && typeof App !== 'undefined' && App.idx === 0) el.innerHTML = App.goalsBlock();
  },
  /** Returns true when the click was handled here (no chat needed). */
  handle(btn) {
    const mode = btn.dataset.goals, gid = btn.dataset.gid;
    let ids = [];
    if (mode === 'confirm' && gid) ids = [gid];
    else if (mode === 'confirm-all') ids = (Goals.data?.goals || []).filter(g => g.status === 'proposed').map(g => g.id);
    else if (mode === 'reopen' && gid) ids = [gid];
    else return false;
    const body = mode === 'reopen' ? { status: 'on-track' } : { status: 'on-track', confidence: 'high' };
    btn.disabled = true;
    (async () => {
      try {
        for (const id of ids) await this.patch(id, body);
        await this.refresh();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Retry';
        btn.title = String(err?.message || err);
        // Old gateway without the write API: fall back to asking Pen.
        if (/404|Cannot PATCH/.test(String(err?.message)) && window.paprAPI?.invoke) {
          window.paprAPI.invoke('chat.open', { message: Goals['prompt'](mode, gid) });
        }
      }
    })();
    return true;
  },
};
