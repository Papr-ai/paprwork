(() => {
  // ../../../../private/tmp/settings_demo.ts
  var SETTINGS_APP_ID = "3e08bfb2-23f1-4173-b76f-f1910bdc31fd";
  var settingsOpen = false;
  var currentTopics = [];
  var companyName = "";
  var companyDesc = "";
  var settingsLoading = false;
  async function settingsQuery(sql, params = []) {
    const r = await fetch("/api/db/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: SETTINGS_APP_ID, sql, params })
    });
    const data = await r.json();
    return data.rows || [];
  }
  async function settingsWrite(sql, params = []) {
    await fetch("/api/db/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: SETTINGS_APP_ID, sql, params })
    });
  }
  async function ensureSettingsTable() {
    await settingsWrite(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  }
  async function loadSetting(key, fallback) {
    try {
      await ensureSettingsTable();
      const rows = await settingsQuery(
        `SELECT value FROM settings WHERE key = ?`,
        [key]
      );
      if (rows.length > 0) return rows[0].value;
    } catch (e) {
      console.error(`Load ${key} error:`, e);
    }
    return fallback;
  }
  async function saveSetting(key, value) {
    await settingsWrite(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      [key, value]
    );
  }
  async function loadTopics() {
    const raw = await loadSetting("topics", "");
    if (raw) try {
      const parsed = JSON.parse(raw);
      if (parsed.length) return parsed;
    } catch {
    }
    try {
      const rows = await settingsQuery(
        `SELECT value FROM settings WHERE key = 'topics'`
      );
      if (rows.length > 0) {
        const parsed = JSON.parse(rows[0].value);
        if (parsed.length) return parsed;
      }
    } catch {
    }
    return [
      "AI agents memory",
      "LLM memory RAG",
      "agent infrastructure",
      "AI developer tools",
      "open source AI",
      "building AI startup"
    ];
  }
  async function loadCompany() {
    const name = await loadSetting("company_name", "Papr");
    const desc = await loadSetting(
      "company_desc",
      "Predictive memory for AI agents. <100ms retrieval, 91% STARK accuracy."
    );
    return { name, desc };
  }
  async function saveAllSettings() {
    const filtered = currentTopics.map((t) => t.trim()).filter((t) => t.length > 0);
    await saveSetting("topics", JSON.stringify(filtered));
    await saveSetting("company_name", companyName.trim());
    await saveSetting("company_desc", companyDesc.trim());
    currentTopics = filtered;
  }
  async function openSettings() {
    settingsOpen = true;
    settingsLoading = true;
    renderSettings();
    currentTopics = await loadTopics();
    const co = await loadCompany();
    companyName = co.name;
    companyDesc = co.desc;
    settingsLoading = false;
    renderSettings();
  }
  function closeSettings() {
    settingsOpen = false;
    const overlay = document.getElementById("settings-overlay");
    if (overlay) overlay.remove();
  }
  function addTopicRow() {
    currentTopics.push("");
    renderSettings();
    const inputs = document.querySelectorAll(".topic-input");
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  }
  function removeTopicAt(i) {
    currentTopics.splice(i, 1);
    renderSettings();
  }
  function updateTopicAt(i, val) {
    currentTopics[i] = val;
  }
  async function handleSaveSettings() {
    await saveAllSettings();
    if (typeof toast === "function") toast("\u2713 Settings saved \u2014 refresh feed to apply", 3e3);
    closeSettings();
  }
  function renderSettings() {
    let overlay = document.getElementById("settings-overlay");
    if (!settingsOpen) {
      if (overlay) overlay.remove();
      return;
    }
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "settings-overlay";
      document.body.appendChild(overlay);
    }
    const topicRows = settingsLoading ? '<div style="color:var(--muted);padding:16px">Loading...</div>' : currentTopics.map((t, i) => `
      <div class="topic-row">
        <input class="topic-input" type="text" value="${t.replace(/"/g, "&quot;")}"
          placeholder="e.g. AI agents memory"
          oninput="updateTopicAt(${i}, this.value)" />
        <button class="topic-remove" onclick="removeTopicAt(${i})">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `).join("");
    const companyHtml = settingsLoading ? "" : `
    <div class="settings-section">
      <h4>Company / Product</h4>
      <p class="settings-desc">Used for the 2 "mention" slots per batch. Leave blank to disable mentions entirely.</p>
      <div style="padding:0 2px">
        <label style="font-size:12px;color:var(--muted);margin-bottom:4px;display:block">Name</label>
        <input class="topic-input" type="text" value="${companyName.replace(/"/g, "&quot;")}"
          placeholder="e.g. Acme AI" oninput="companyName=this.value"
          style="margin-bottom:8px;flex:none"/>
        <label style="font-size:12px;color:var(--muted);margin-bottom:4px;display:block">Description</label>
        <textarea class="topic-input" rows="2" placeholder="One-liner about your product..."
          oninput="companyDesc=this.value"
          style="resize:vertical">${companyDesc.replace(/</g, "&lt;")}</textarea>
      </div>
    </div>`;
    overlay.innerHTML = `
    <div class="settings-backdrop" onclick="closeSettings()"></div>
    <div class="settings-panel">
      <div class="settings-header">
        <h3>Settings</h3>
        <button class="icon-btn" onclick="closeSettings()">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      ${companyHtml}
      <div class="settings-section">
        <h4>Search Topics</h4>
        <p class="settings-desc">Topics to search on X. The fetcher finds tweets matching these.</p>
        <div class="topics-list" style="padding:0 2px">${topicRows}</div>
      </div>
      <div class="settings-actions">
        <button class="action-btn-ghost" onclick="addTopicRow()">+ Add topic</button>
        <button class="reply-btn action-btn-main" onclick="handleSaveSettings()">Save</button>
      </div>
    </div>
  `;
  }
  Object.assign(window, {
    openSettings,
    closeSettings,
    addTopicRow,
    removeTopicAt,
    updateTopicAt,
    handleSaveSettings
  });
})();
