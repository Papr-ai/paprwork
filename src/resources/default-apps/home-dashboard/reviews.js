/* Review persistence — check (complete) / x (irrelevant + why) on brief items.
   The Home DB `brief_reviews` table is canonical; localStorage is only a cache
   so the UI is instant and works offline. The Daily Brief Generator reads this
   table as a hard input (dismissed items and their siblings are not resurfaced)
   and Sleep promotes irrelevance notes into MEMORY.md preferences. */
const Reviews = {
  APP_ID: 'bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c',
  storeKey: 'home-review-v1',
  cache() { try { return JSON.parse(localStorage.getItem(this.storeKey) || '{}'); } catch { return {}; } },
  setCache(s) { localStorage.setItem(this.storeKey, JSON.stringify(s)); },
  async write(sql, params) {
    const r = await fetch('/api/db/write', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.APP_ID, sql, params }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data?.success === false) throw new Error(data?.error || `write failed (${r.status})`);
    return data;
  },
  /* Pull the canonical rows into the cache once per load so a fresh device /
     web install shows the same reviewed state. Silent on failure (offline). */
  async hydrate() {
    try {
      const rows = await Data.query('SELECT item_key, status, note, updated_at FROM brief_reviews');
      const state = this.cache();
      for (const row of rows) state[row.item_key] = { status: row.status, note: row.note || undefined, at: row.updated_at };
      this.setCache(state);
    } catch { /* table may not exist yet on a pre-migration install; cache still works */ }
  },
  async upsert(id, item, briefDate, status, note) {
    const title = item.title || item.subject || item.label || item.message || '';
    await this.write(
      `INSERT INTO brief_reviews (item_key, brief_date, section, item_type, title, status, note, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(item_key) DO UPDATE SET status = excluded.status, note = excluded.note, task_id = excluded.task_id, updated_at = datetime('now')`,
      [id, briefDate, item._section || '', item._type || '', title, status, note || null, item.task_id || null],
    );
    // A brief item that maps to a task: completing it completes the task at its
    // source (entity Open Item checkbox / L3 goal block) so every agent sees it.
    if (item.task_id && status === 'complete') await this.setTaskDone(item.task_id, true);
  },
  async remove(id, item) {
    await this.write('DELETE FROM brief_reviews WHERE item_key = ?', [id]);
    if (item?.task_id) await this.setTaskDone(item.task_id, false);
  },
  async setTaskDone(taskId, done) {
    try {
      await fetch(`/api/workspace/tasks/${encodeURIComponent(taskId)}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }) });
    } catch (err) { console.warn('[home] task write-back failed:', err?.message || err); }
  },
  findItem(brief, id) {
    for (const s of brief.sections || []) for (const it of s.items || []) if (it._id === id) return it;
    return null;
  },
};
