// ../../../Papr/apps/6e432b37-6cf2-45f1-9ad8-ec70a56d4a3c/app.ts
var APP_ID = "6e432b37-6cf2-45f1-9ad8-ec70a56d4a3c";
var RECORDER_JOB = "095b6dbf-6096-433c-83d9-e7a66b8e459b";
var STOP_JOB = "71c6b7b8-9b7e-4f3a-bfc9-1dee90193bce";
var WHISPER_JOB = "84262b7e-fc23-4b08-914b-7791c78a7736";
var SUMMARIZER_JOB = "069f5b22-f29e-4b24-b001-c8f9d057b0b7";
var PERM_JOB = "be69e2ba-62ff-40d1-8e0f-837c1619434e";
var CALENDAR_JOB = "0a93a300-d958-4439-9d78-957f47865821";
var PREP_JOB = "32aa2031-ecba-4188-9a59-e906c7e61e5e";
var BG_JOB = "751f6600-b8e7-4097-8f63-66fe9bb6bd2b";
var AUDIO_DEVICES_JOB = "755d4cab-7b57-48dc-9ade-826768f30997";
var view = "home";
var meetings = [];
var calEvents = [];
var bg = null;
var liveCity = "";
var liveLocationReason = "";
var selectedId = null;
var isRecording = false;
var recordingId = null;
var permissionGranted = null;
var showPermModal = false;
var elapsedSeconds = 0;
var timerInterval = null;
var pollInterval = null;
var saveTimeout = null;
var activeFilter = "all";
var activeTags = [];
var activePeople = [];
var calView = "";
var calWeekOffset = 0;
var mainPage = "meetings";
var activeTab = "notes";
var selectedCalId = null;
var prepPollInterval = null;
var prepLogs = [];
var prepStartTime = 0;
var showBgHero = localStorage.getItem("mm-show-bg") === "true";
var audioDevices = [];
var selectedAudioDevice = { index: -1, name: "" };
var showAudioMenu = false;
var toasts = [];
var toastCounter = 0;
function showToast(type, message, action, duration = 5e3) {
  const id = ++toastCounter;
  toasts.push({ id, type, message, action });
  renderToasts();
  if (!action) setTimeout(() => dismissToast(id), duration);
}
function dismissToast(id) {
  const el = document.querySelector(`[data-toast-id="${id}"]`);
  if (el) {
    el.classList.add("toast-exit");
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      renderToasts();
    }, 300);
  } else {
    toasts = toasts.filter((t) => t.id !== id);
    renderToasts();
  }
}
function renderToasts() {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  container.innerHTML = toasts.map((t) => `
    <div class="toast toast-${t.type}" data-toast-id="${t.id}">
      <div class="toast-icon">${t.type === "error" ? icon("alert", 16) : t.type === "success" ? icon("check", 16) : icon("sparkle", 16)}</div>
      <span class="toast-msg">${t.message}</span>
      ${t.action ? `<button class="toast-action" onclick="${t.action.fn}">${t.action.label}</button>` : ""}
      <button class="toast-dismiss" onclick="dismissToast(${t.id})">\xD7</button>
    </div>
  `).join("");
}
window.dismissToast = dismissToast;
window.showToast = showToast;
async function q(sql, p = []) {
  const r = await fetch("/api/db/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: APP_ID, sql, params: p })
  });
  return (await r.json()).rows || [];
}
async function w(sql, p = []) {
  await fetch("/api/db/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: APP_ID, sql, params: p })
  });
}
async function runJob(id) {
  await fetch("/api/jobs/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: id })
  });
}
async function fetchPrepLogs() {
  try {
    const r = await fetch("/api/jobs/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: PREP_JOB })
    });
    const data = await r.json();
    const raw = data?.data?.logs || data?.logs || data?.output || data?.stdout || "";
    const readable = [];
    for (const line of raw.split("\n")) {
      const m = line.match(/Tool: (\w+)\((.{0,120})/) || line.match(/tool[_\s]?call[:\s]+(\w+)\((.{0,120})/i);
      if (!m) continue;
      const tool = m[1];
      const args = m[2];
      if (tool === "bash") {
        const cmd = args.replace(/\\/g, "").replace(/"/g, "").slice(0, 80);
        if (cmd.includes("sqlite3")) readable.push("note:Reading meeting data\u2026");
        else if (cmd.includes("grep")) readable.push("eye:Searching documents\u2026");
        else if (cmd.includes("apollo")) readable.push("person:Looking up attendee profiles\u2026");
        else if (cmd.includes("linkedin.com")) readable.push("person:Searching LinkedIn\u2026");
        else if (cmd.includes("exa") || cmd.includes("search")) readable.push("refresh:Searching the web\u2026");
        else if (cmd.includes("curl")) readable.push("refresh:Fetching external data\u2026");
        else readable.push("settings:Running task\u2026");
      } else if (tool === "search_agent_memory") {
        const q2 = args.match(/query.*?[":]\s*"?([^"\\,{}]{8,50})/i)?.[1] || "";
        readable.push(`sparkle:Searching memory${q2 ? ": " + q2.trim() : "\u2026"}`);
      } else if (tool === "read_file" || tool === "read_document") {
        readable.push("note:Reading document\u2026");
      } else if (tool === "add_agent_memory") {
        readable.push("lock:Saving context to memory\u2026");
      } else {
        readable.push(`settings:${tool.replace(/_/g, " ")}\u2026`);
      }
    }
    if (readable.length > 0) {
      prepLogs = readable.slice(-20);
      render();
    } else if (raw.includes("PREP_COMPLETE")) {
      await loadAll();
    }
  } catch {
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function loadAll() {
  try {
    meetings = await q("SELECT * FROM meetings ORDER BY created_at DESC");
  } catch {
    meetings = [];
  }
  try {
    calEvents = await q(`SELECT id, title, start_time, end_time, calendar_name, meeting_id, 
      COALESCE(attendees, '[]') as attendees, COALESCE(prep_status, '') as prep_status, 
      COALESCE(prep_doc, '') as prep_doc
      FROM calendar_events
      WHERE NOT (start_time LIKE '%T00:00' AND end_time LIKE '%T23:59')
      ORDER BY start_time ASC`);
  } catch {
    calEvents = [];
  }
  try {
    const rows = await q(`SELECT city, reason, prompt, image_url, image_data, generated_on FROM location_background WHERE id='current' LIMIT 1`);
    bg = rows[0] || null;
  } catch {
    bg = null;
  }
  await loadAudioDevices();
  render();
}
async function loadAudioDevices() {
  try {
    audioDevices = await q("SELECT device_index, name FROM audio_devices ORDER BY device_index");
    const settings = await q("SELECT selected_device_index, selected_device_name FROM audio_settings WHERE id=1");
    if (settings.length && settings[0].selected_device_index >= 0) {
      selectedAudioDevice = { index: settings[0].selected_device_index, name: settings[0].selected_device_name };
    }
  } catch {
  }
}
async function refreshAudioDevices() {
  await runJob(AUDIO_DEVICES_JOB);
  await new Promise((r) => setTimeout(r, 2e3));
  await loadAudioDevices();
  render();
}
async function selectAudioDevice(idx, name) {
  selectedAudioDevice = { index: idx, name };
  showAudioMenu = false;
  await w("UPDATE audio_settings SET selected_device_index=?, selected_device_name=?, updated_at=strftime('%s','now') WHERE id=1", [idx, name]);
  render();
}
async function checkPerm() {
  await w("DELETE FROM permission_checks");
  await runJob(PERM_JOB);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const rows = await q("SELECT result FROM permission_checks ORDER BY created_at DESC LIMIT 1");
    if (rows.length) {
      permissionGranted = rows[0].result === "PERMISSION_GRANTED";
      return permissionGranted;
    }
  }
  permissionGranted = false;
  return false;
}
async function finalizeMeetingRecording(mid, durationSeconds, savedNotes) {
  if (savedNotes !== void 0) {
    await w("UPDATE meetings SET notes=?, updated_at=strftime('%s','now') WHERE id=?", [savedNotes, mid]);
  }
  if (durationSeconds !== void 0) {
    await w("UPDATE meetings SET duration=?, updated_at=strftime('%s','now') WHERE id=?", [durationSeconds, mid]);
  }
  await w("UPDATE meetings SET status='stopping', updated_at=strftime('%s','now') WHERE id=? AND status IN ('recording','stopping')", [mid]);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await runJob(STOP_JOB);
      break;
    } catch {
      await sleep(1e3);
    }
  }
  let settled = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const rows = await q("SELECT status FROM meetings WHERE id=?", [mid]);
    if (!rows.length) return;
    const s = rows[0].status;
    if (["recorded", "transcribing", "pending", "summarized"].includes(s)) {
      settled = true;
      break;
    }
    if (s === "failed") return;
  }
  if (!settled) {
    await w("UPDATE meetings SET status='recorded', updated_at=strftime('%s','now') WHERE id=? AND status='stopping'", [mid]);
  }
  triggerWhisperWhenReady(mid).catch(() => {
  });
  startPoll(mid);
}
async function handoffActiveRecording() {
  const rows = await q("SELECT id, status FROM meetings WHERE status='recording' ORDER BY created_at DESC LIMIT 1");
  if (!rows.length) return;
  const activeId = rows[0].id;
  if (activeId === recordingId) {
    const editor = document.getElementById("notes-editor");
    const notes = editor ? editor.innerHTML.trim() : "";
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    isRecording = false;
    await finalizeMeetingRecording(activeId, elapsedSeconds, notes || void 0);
    recordingId = null;
    elapsedSeconds = 0;
  } else {
    await finalizeMeetingRecording(activeId);
  }
}
async function startRecording(fromCalId) {
  if (permissionGranted !== true) {
    const ok = await checkPerm();
    if (!ok) {
      showPermModal = true;
      render();
      return;
    }
  }
  await handoffActiveRecording();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let title = "Meeting \u2014 " + (/* @__PURE__ */ new Date()).toLocaleString(void 0, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  let id = "";
  if (fromCalId) {
    const ev = calEvents.find((e) => e.id === fromCalId);
    if (ev) {
      title = ev.title;
      const existing = await q("SELECT m.id FROM meetings m JOIN calendar_events ce ON ce.meeting_id = m.id WHERE ce.id = ? AND m.status = 'scheduled' LIMIT 1", [fromCalId]);
      if (existing.length) {
        id = existing[0].id;
        await w("UPDATE meetings SET status='recording', date=?, updated_at=strftime('%s','now') WHERE id=?", [now, id]);
      } else {
        id = crypto.randomUUID();
        await w("UPDATE calendar_events SET meeting_id = ? WHERE id = ?", [id, fromCalId]);
      }
    }
  }
  if (!id) {
    id = crypto.randomUUID();
  }
  const check = await q("SELECT id FROM meetings WHERE id=?", [id]);
  if (!check.length) {
    await w("INSERT INTO meetings (id, title, date, status) VALUES (?, ?, ?, 'recording')", [id, title, now]);
  }
  recordingId = id;
  isRecording = true;
  elapsedSeconds = 0;
  selectedId = id;
  view = "meeting";
  render();
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    const el = document.getElementById("rec-timer");
    if (el) el.textContent = fmtDur(elapsedSeconds);
  }, 1e3);
  try {
    await runJob(RECORDER_JOB);
  } catch (e) {
    console.error("Recorder job failed:", e);
  }
  await loadAll();
}
async function stopRecording() {
  if (!recordingId) return;
  const editor = document.getElementById("notes-editor");
  const notes = editor ? editor.innerHTML.trim() : "";
  const sid = recordingId;
  isRecording = false;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  recordingId = null;
  await finalizeMeetingRecording(sid, elapsedSeconds, notes || void 0);
  elapsedSeconds = 0;
  await loadAll();
}
async function triggerWhisperWhenReady(mid) {
  for (let i = 0; i < 45; i++) {
    await sleep(2e3);
    const rows = await q("SELECT status FROM meetings WHERE id=?", [mid]);
    if (!rows.length || rows[0].status === "failed") return;
    if (rows[0].status === "recorded") {
      await runJob(WHISPER_JOB);
      return;
    }
    if (["transcribing", "pending", "summarized", "synced"].includes(rows[0].status)) return;
  }
}
function startPoll(mid) {
  let attempts = 0, last = "";
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    if (++attempts > 300) {
      clearInterval(pollInterval);
      return;
    }
    const rows = await q("SELECT status FROM meetings WHERE id=?", [mid]);
    if (!rows.length) return;
    const s = rows[0].status;
    if (s !== last) {
      last = s;
      await loadAll();
      if (s === "pending") runJob(SUMMARIZER_JOB).catch(() => {
      });
    }
    if (s === "summarized" || s === "failed") {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }, 2e3);
}
function flushSave() {
  const editor = document.getElementById("notes-editor");
  const id = isRecording ? recordingId : selectedId;
  if (!editor || !id) return;
  const html = editor.innerHTML.trim();
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  if (activeTab === "prep" && selectedCalId) {
    w("UPDATE calendar_events SET prep_doc=? WHERE id=?", [html, selectedCalId]);
  } else if (activeTab === "notes") {
    w("UPDATE meetings SET summary=?, updated_at=strftime('%s','now') WHERE id=?", [html, id]);
  }
}
function autoSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => flushSave(), 1500);
}
function isSameMeetingDay(a, b) {
  return !!a && !!b && a.split("T")[0] === b.split("T")[0];
}
function findLinkedCalEvent(m) {
  const byId = calEvents.find((e) => e.meeting_id === m.id && isSameMeetingDay(e.start_time, m.date));
  if (byId) return byId;
  if (!m.date) return void 0;
  return calEvents.find((e) => e.title.toLowerCase() === m.title.toLowerCase() && isSameMeetingDay(e.start_time, m.date));
}
function getLinkedMeetingForEvent(e) {
  const byId = e.meeting_id ? meetings.find((m) => m.id === e.meeting_id) : null;
  if (byId && isSameMeetingDay(byId.date, e.start_time)) return byId;
  return meetings.find(
    (m) => m.title.toLowerCase() === e.title.toLowerCase() && isSameMeetingDay(m.date, e.start_time)
  ) || null;
}
function hasMeetingContent(m) {
  return !!(m && ((m.notes || "").trim() || (m.summary || "").trim() || (m.transcript || "").trim()));
}
function parseAttendees(json) {
  try {
    return JSON.parse(json || "[]");
  } catch {
    return [];
  }
}
function getInitials(name) {
  if (!name) return "?";
  const parts = name.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
var avatarColors = ["#0161E0", "#7C3AED", "#059669", "#D97706", "#DC2626", "#0891B2", "#BE185D", "#4F46E5"];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return avatarColors[Math.abs(h) % avatarColors.length];
}
async function triggerPrep(eventId) {
  const ev = calEvents.find((e) => e.id === eventId);
  if (!ev) return;
  const attendees = parseAttendees(ev.attendees);
  const req = { event_id: eventId, title: ev.title, attendees, start_time: ev.start_time, calendar_name: ev.calendar_name };
  prepLogs = [];
  prepStartTime = Date.now();
  await w("UPDATE calendar_events SET prep_status='preparing', prep_doc=? WHERE id=?", [JSON.stringify(req), eventId]);
  view = "meeting";
  selectedCalId = eventId;
  activeTab = "prep";
  await loadAll();
  runJob(PREP_JOB).catch(() => {
  });
  startPrepPoll(eventId);
}
function startPrepPoll(eventId) {
  if (prepPollInterval) clearInterval(prepPollInterval);
  let attempts = 0;
  const MAX_ATTEMPTS = 200;
  (async () => {
    const rows = await q("SELECT prep_status FROM calendar_events WHERE id=?", [eventId]);
    if (rows.length && rows[0].prep_status === "ready") {
      clearInterval(prepPollInterval);
      prepPollInterval = null;
      prepLogs = [];
      await loadAll();
      return;
    }
  })();
  prepPollInterval = setInterval(async () => {
    attempts++;
    fetchPrepLogs();
    const rows = await q("SELECT prep_status, prep_doc FROM calendar_events WHERE id=?", [eventId]);
    if (rows.length && rows[0].prep_status === "ready") {
      clearInterval(prepPollInterval);
      prepPollInterval = null;
      prepLogs = [];
      await loadAll();
    } else if (attempts >= MAX_ATTEMPTS || rows.length && rows[0].prep_status === "failed") {
      clearInterval(prepPollInterval);
      prepPollInterval = null;
      prepLogs = [];
      showToast("error", "Prep timed out \u2014 agent took too long", { label: "Retry", fn: `triggerPrep('${eventId}')` });
      await w("UPDATE calendar_events SET prep_status='failed' WHERE id=? AND prep_status='preparing'", [eventId]);
      await loadAll();
    }
  }, 3e3);
}
async function recoverStuckPreps() {
  const stuck = await q("SELECT id FROM calendar_events WHERE prep_status='preparing'");
  if (stuck.length > 0) {
    startPrepPoll(stuck[0].id);
  }
}
async function recoverRecordingState() {
  const rows = await q("SELECT id, date FROM meetings WHERE status='recording' LIMIT 1");
  if (rows.length > 0) {
    const m = rows[0];
    isRecording = true;
    recordingId = m.id;
    permissionGranted = true;
    const startTime = new Date(m.date).getTime();
    elapsedSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1e3));
    if (!timerInterval) {
      timerInterval = setInterval(() => {
        elapsedSeconds++;
        const el = document.getElementById("rec-timer");
        if (el) el.textContent = fmtDur(elapsedSeconds);
      }, 1e3);
    }
  }
}
async function detectLiveLocation() {
  const saveLocation = async (city, source, lat = null, lon = null) => {
    liveCity = city;
    liveLocationReason = `${source === "geolocation" ? "Live location" : "Network location"} says ${city}${bg?.city && bg.city !== city ? ` \u2014 overriding calendar-derived ${bg.city}` : ""}`;
    await w(`CREATE TABLE IF NOT EXISTS location_override (id TEXT PRIMARY KEY, city TEXT DEFAULT '', lat REAL, lon REAL, source TEXT DEFAULT '', updated_at INTEGER DEFAULT (strftime('%s','now')))`);
    await w(`INSERT INTO location_override (id, city, lat, lon, source, updated_at) VALUES ('latest', ?, ?, ?, ?, strftime('%s','now')) ON CONFLICT(id) DO UPDATE SET city=excluded.city, lat=excluded.lat, lon=excluded.lon, source=excluded.source, updated_at=excluded.updated_at`, [city, lat, lon, source]);
    render();
    if (city !== bg?.city) {
      await runJob(BG_JOB).catch(() => {
      });
      await sleep(1800);
      await loadAll();
    }
  };
  if ("geolocation" in navigator) {
    try {
      const pos = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 3500, maximumAge: 60 * 60 * 1e3 }));
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`, { headers: { "Accept": "application/json" } });
      const data = await r.json();
      const addr = data.address || {};
      const city = addr.city || addr.town || addr.village || addr.county || data.name || "";
      if (city) {
        await saveLocation(city, "geolocation", lat, lon);
        return;
      }
    } catch {
    }
  }
  try {
    const r = await fetch("https://ipapi.co/json/");
    const data = await r.json();
    const city = data?.city || data?.region || "";
    if (city) await saveLocation(city, "ip");
  } catch {
  }
}
async function deleteMeeting(id, e) {
  e.stopPropagation();
  await w("DELETE FROM meetings WHERE id=?", [id]);
  if (selectedId === id) {
    selectedId = null;
    view = "home";
  }
  await loadAll();
}
function openMeeting(id, tab) {
  selectedId = id;
  view = "meeting";
  activeTab = tab || "notes";
  const m = meetings.find((x) => x.id === id);
  if (m) {
    const linkedEv = findLinkedCalEvent(m);
    selectedCalId = linkedEv?.id || null;
    if (m.status === "recording" && !isRecording) {
      isRecording = true;
      recordingId = id;
      permissionGranted = true;
      if (!timerInterval) {
        const startTime = new Date(m.date).getTime();
        elapsedSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1e3));
        timerInterval = setInterval(() => {
          elapsedSeconds++;
          const el = document.getElementById("rec-timer");
          if (el) el.textContent = fmtDur(elapsedSeconds);
        }, 1e3);
      }
    }
    if (["stopping", "recorded", "transcribing", "pending"].includes(m.status)) startPoll(id);
    if (m.status === "stopping") triggerWhisperWhenReady(id);
    if (m.status === "recorded") runJob(WHISPER_JOB).catch(() => {
    });
    if (m.status === "pending") runJob(SUMMARIZER_JOB).catch(() => {
    });
  } else {
    const ev = calEvents.find((e) => e.id === id);
    if (ev) {
      selectedCalId = ev.id;
      selectedId = ev.meeting_id || null;
      activeTab = tab || "prep";
    }
  }
  render();
}
function extractTags(m) {
  if (!m.tags) return [];
  try {
    return JSON.parse(m.tags);
  } catch {
    return [];
  }
}
function getAllTags() {
  const all = /* @__PURE__ */ new Set();
  meetings.forEach((m) => extractTags(m).forEach((t) => all.add(t)));
  return [...all];
}
function getAllPeople() {
  const seen = /* @__PURE__ */ new Map();
  meetings.forEach((m) => {
    const ev = findLinkedCalEvent(m);
    if (ev) {
      parseAttendees(ev.attendees).forEach((a) => {
        if (!seen.has(a.email)) seen.set(a.email, a);
      });
    }
  });
  return [...seen.values()].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}
function filterMeetings() {
  const now = /* @__PURE__ */ new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - 7);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return meetings.filter((m) => {
    const d = new Date(m.date);
    if (activeFilter === "today" && d < todayStart) return false;
    if (activeFilter === "week" && d < weekStart) return false;
    if (activeFilter === "month" && d < monthStart) return false;
    if (activeTags.length > 0 && !activeTags.some((t) => extractTags(m).includes(t))) return false;
    if (activePeople.length > 0) {
      const ev = findLinkedCalEvent(m);
      if (!ev) return false;
      const emails = parseAttendees(ev.attendees).map((a) => a.email);
      if (!activePeople.some((p) => emails.includes(p))) return false;
    }
    return true;
  });
}
function localDateStr(d = /* @__PURE__ */ new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function getTodayEvents() {
  const todayStr = localDateStr();
  return calEvents.filter((e) => e.start_time.startsWith(todayStr));
}
function fmtDur(s) {
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function pad(n) {
  return String(n).padStart(2, "0");
}
function fmtDate(d) {
  return new Date(d).toLocaleDateString(void 0, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtTime(t) {
  return new Date(t).toLocaleTimeString(void 0, { hour: "2-digit", minute: "2-digit" });
}
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}
function statusLabel(s) {
  return {
    recording: "Recording",
    stopping: "Processing",
    recorded: "Transcribing",
    transcribing: "Transcribing",
    pending: "Summarizing",
    summarized: "Complete",
    synced: "Complete",
    failed: "Failed",
    scheduled: "Scheduled"
  }[s] || "";
}
function statusClass(s) {
  return {
    recording: "status-recording",
    stopping: "status-processing",
    recorded: "status-processing",
    transcribing: "status-processing",
    pending: "status-processing",
    summarized: "status-done",
    failed: "status-failed"
  }[s] || "";
}
function formatSummary(text) {
  if (!text) return "";
  const lines = text.split("\n");
  let html = "";
  let inList = false;
  let inTable = false;
  let tableHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      if (inTable) {
        html += "</tbody></table>";
        inTable = false;
        tableHeader = false;
      }
      continue;
    }
    if (/^\|(.+)\|$/.test(trimmed)) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
        tableHeader = false;
        continue;
      }
      const cells = trimmed.split("|").filter((c) => c.trim() !== "").map((c) => c.trim().replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"));
      if (!inTable) {
        html += '<table class="md-table"><thead><tr>';
        cells.forEach((c) => html += `<th>${c}</th>`);
        html += "</tr></thead><tbody>";
        inTable = true;
        tableHeader = true;
      } else {
        html += "<tr>";
        cells.forEach((c) => html += `<td>${c}</td>`);
        html += "</tr>";
      }
      continue;
    }
    if (inTable) {
      html += "</tbody></table>";
      inTable = false;
      tableHeader = false;
    }
    if (/^## (.+)/.test(trimmed)) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<h3>${trimmed.replace(/^## /, "")}</h3>`;
    } else if (/^### (.+)/.test(trimmed)) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<h4>${trimmed.replace(/^### /, "")}</h4>`;
    } else if (/^- \[ \] (.+)/.test(trimmed)) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<label class="action-item"><input type="checkbox"> ${trimmed.replace(/^- \[ \] /, "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</label>`;
    } else if (/^- \[x\] (.+)/.test(trimmed)) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<label class="action-item done"><input type="checkbox" checked> ${trimmed.replace(/^- \[x\] /, "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</label>`;
    } else if (/^[-*] (.+)/.test(trimmed)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${trimmed.replace(/^[-*] /, "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</li>`;
    } else {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<p>${trimmed.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`;
    }
  }
  if (inList) html += "</ul>";
  if (inTable) html += "</tbody></table>";
  return html;
}
function icon(name, size = 18) {
  const i = {
    mic: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    stop: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
    back: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
    lock: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    settings: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    check: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    trash: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    clock: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    cal: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    chevron: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`,
    note: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    sparkle: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>`,
    refresh: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
    tag: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
    person: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    eye: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    "eye-off": `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
    alert: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
  };
  return i[name] || i["settings"] || "";
}
function renderBackgroundLayer() {
  return `<div class="ambient" aria-hidden="true">
    <div class="orb orb-1"></div><div class="orb orb-2"></div><div class="orb orb-3"></div>
  </div>`;
}
function render() {
  const root = document.getElementById("root");
  const homeMain = root.querySelector(".home-main");
  const preservedScrollTop = view === "home" ? homeMain?.scrollTop || 0 : 0;
  const content = showPermModal ? renderPermModal() : view === "home" ? renderHome() : renderMeeting();
  root.innerHTML = `${renderBackgroundLayer()}<div class="app-shell">${content}</div>`;
  attachListeners();
  if (view === "home") {
    const nextHomeMain = root.querySelector(".home-main");
    if (nextHomeMain) nextHomeMain.scrollTop = preservedScrollTop;
  }
}
function renderPermModal() {
  return `
    <div class="perm-overlay">
      <div class="perm-modal">
        <div class="perm-shield">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </div>
        <h2>Screen & Audio Recording</h2>
        <p class="perm-subtitle">Paprwork captures system audio from Zoom, Teams, and Meet to transcribe your meetings.</p>
        <div class="perm-steps">
          <div class="perm-step">
            <span class="perm-step-num">1</span>
            <span>Open <strong>System Settings \u2192 Privacy & Security</strong></span>
          </div>
          <div class="perm-step">
            <span class="perm-step-num">2</span>
            <span>Find <strong>Screen & Audio Recording</strong></span>
          </div>
          <div class="perm-step">
            <span class="perm-step-num">3</span>
            <span>Toggle on <strong>Electron</strong> (dev) or <strong>Papr Work</strong></span>
          </div>
          <div class="perm-step">
            <span class="perm-step-num">4</span>
            <span>Restart the app after enabling</span>
          </div>
        </div>
        <div class="perm-btns">
          <button class="perm-btn-settings" id="btn-open-settings">Open System Settings</button>
          <button class="perm-btn-retry" id="btn-retry-perm">I've enabled it \u2014 retry</button>
        </div>
      </div>
    </div>`;
}
function toggleBgHero() {
}
function renderBackgroundHero() {
  return "";
}
function renderHome() {
  const todayEvs = getTodayEvents();
  const filtered = filterMeetings();
  const allTags = getAllTags();
  const allPeople = getAllPeople();
  return `
    <div class="home-layout">
      <header class="home-header glass">
        <nav class="home-nav">
          <button class="home-nav-tab${mainPage === "meetings" ? " active" : ""}" data-page="meetings">Meetings</button>
          <button class="home-nav-tab${mainPage === "notes" ? " active" : ""}" data-page="notes">Notes</button>
        </nav>
        <div class="header-actions">
          <div class="audio-device-wrapper">
            <button class="btn-audio-device" id="btn-audio-device" title="${selectedAudioDevice.name || "Select microphone"}">
              ${icon("mic", 14)}
              <span class="audio-device-label">${selectedAudioDevice.name || "No mic"}</span>
              ${icon("chevron", 10)}
            </button>
            ${showAudioMenu ? `<div class="audio-device-menu glass">
              <div class="audio-menu-header">
                <span>Audio Input</span>
                <button class="audio-refresh-btn" id="btn-refresh-devices">${icon("refresh", 12)}</button>
              </div>
              ${audioDevices.map((d) => `
                <button class="audio-device-option${d.device_index === selectedAudioDevice.index ? " selected" : ""}" 
                  data-dev-idx="${d.device_index}" data-dev-name="${esc(d.name)}">
                  <span class="audio-dev-name">${esc(d.name)}</span>
                  ${d.device_index === selectedAudioDevice.index ? icon("check", 14) : ""}
                </button>
              `).join("")}
              ${audioDevices.length === 0 ? '<div class="audio-no-devices">No devices found. Click refresh.</div>' : ""}
            </div>` : ""}
          </div>
          <button class="btn-record" id="btn-new-rec">
            New Note
          </button>
        </div>
      </header>
      <div class="home-main">
        ${renderBackgroundHero()}

        ${mainPage === "meetings" ? `
        <section class="home-section">
          <div class="section-header">
            <div class="cal-pills-row">
              <button class="week-nav-btn" onclick="event.stopPropagation(); shiftWeek(-1)">&#8249;</button>
              <div class="cal-pills">
                ${getWeekDayPills()}
              </div>
              <button class="week-nav-btn" onclick="event.stopPropagation(); shiftWeek(1)">&#8250;</button>
            </div>
          </div>
          ${renderCalView()}
        </section>
        ` : `
        <section class="home-section">
          <div class="section-header">
            <div class="filter-bar">
              <div class="filter-pills">
                ${["all", "today", "week", "month"].map((f) => `
                  <button class="pill${activeFilter === f ? " pill-active" : ""}" data-filter="${f}">
                    ${f === "all" ? "All" : f === "today" ? "Today" : f === "week" ? "This Week" : "This Month"}
                  </button>`).join("")}
              </div>
              <div class="filter-selectors">
                ${allTags.length ? `
                <div class="filter-select-wrap">
                  <button class="filter-select${activeTags.length ? " has-selection" : ""}" id="btn-topic-select">
                    ${icon("tag", 13)}
                    ${activeTags.length ? activeTags.join(", ") : "Topics"}
                    ${icon("chevron", 10)}
                  </button>
                  <div class="filter-dropdown" id="dropdown-topics">
                    ${allTags.map((t) => `
                      <label class="filter-option"><input type="checkbox" value="${esc(t)}" ${activeTags.includes(t) ? "checked" : ""} data-topic-check> ${esc(t)}</label>
                    `).join("")}
                    <button class="filter-clear" id="btn-clear-topics">Clear</button>
                  </div>
                </div>` : ""}
                ${allPeople.length ? `
                <div class="filter-select-wrap">
                  <button class="filter-select${activePeople.length ? " has-selection" : ""}" id="btn-people-select">
                    ${icon("person", 13)}
                    ${activePeople.length ? activePeople.length + " selected" : "People"}
                    ${icon("chevron", 10)}
                  </button>
                  <div class="filter-dropdown" id="dropdown-people">
                    ${allPeople.map((p) => `
                      <label class="filter-option"><input type="checkbox" value="${esc(p.email)}" ${activePeople.includes(p.email) ? "checked" : ""} data-people-check>
                        <span class="avatar-sm" style="background:${avatarColor(p.name || p.email)}">${getInitials(p.name || p.email)}</span>
                        ${esc(p.name || p.email)}
                      </label>
                    `).join("")}
                    <button class="filter-clear" id="btn-clear-people">Clear</button>
                  </div>
                </div>` : ""}
              </div>
            </div>
          </div>
          <div class="meeting-list">
            ${(() => {
    const withContent = filtered.filter((m) => m.summary && m.summary.trim());
    if (!withContent.length) {
      return '<div class="empty-state">No summaries yet \u2014 summaries appear here after meetings are processed</div>';
    }
    return withContent.map((m) => {
      const tags = extractTags(m);
      const snippet = m.summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      const snippetEl = snippet ? '<div class="notes-snippet">' + esc(snippet) + "\u2026</div>" : "";
      const tagsEl = tags.length ? '<div class="card-tags">' + tags.map((t) => '<span class="pill">' + esc(t) + "</span>").join("") + "</div>" : "";
      return '<div class="meeting-card notes-card" data-meeting-id="' + m.id + '"><div class="card-row"><div class="card-info"><div class="card-title">' + esc(m.title) + '</div><div class="card-meta">' + icon("clock", 12) + " " + fmtDate(m.date) + (m.duration ? " \xB7 " + fmtDur(m.duration) : "") + "</div>" + snippetEl + tagsEl + '</div><div class="card-actions"><button class="btn-icon card-del" data-id="' + m.id + '" title="Delete">' + icon("trash", 13) + "</button></div></div></div>";
    }).join("");
  })()}

        </section>
        `}
      </div>
    </div>`;
}
function getWeekDayPills() {
  const today = /* @__PURE__ */ new Date();
  const todayStr = localDateStr(today);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay() + calWeekOffset * 7);
  const todayDow = today.getDay();
  const isWeekend = todayDow === 0 || todayDow === 6;
  const indices = isWeekend ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
  return indices.map((i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    const ds = localDateStr(d);
    const isToday = ds === todayStr;
    const isActive = calView === ds;
    const dayName = d.toLocaleDateString(void 0, { weekday: "short" });
    const dayNum = d.getDate();
    const hasEvents = calEvents.some((e) => e.start_time.split("T")[0] === ds) || meetings.some((m) => m.date && localDateStr(new Date(m.date)) === ds && !findLinkedCalEvent(m));
    return '<button class="day-pill' + (isActive ? " pill-active" : "") + (isToday && !isActive ? " day-pill-today" : "") + '" data-calview="' + ds + '"><span class="day-pill-name">' + dayName + '</span><span class="day-pill-num' + (isToday ? " day-pill-num-today" : "") + '">' + dayNum + "</span>" + (hasEvents ? '<span class="day-pill-dot"></span>' : "") + "</button>";
  }).join("");
}
function renderCalView() {
  if (!calView) {
    const todayStr = localDateStr(/* @__PURE__ */ new Date());
    const weekDays = getWeekDays();
    calView = weekDays.includes(todayStr) ? todayStr : weekDays[0];
  }
  return renderCalDay(calView);
}
function getWeekDays() {
  const today = /* @__PURE__ */ new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay() + calWeekOffset * 7);
  const todayDow = today.getDay();
  const isWeekend = calWeekOffset === 0 && (todayDow === 0 || todayDow === 6);
  const indices = isWeekend ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
  return indices.map((i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return localDateStr(d);
  });
}
function getPrepSnippet(prepDoc) {
  if (!prepDoc) return "";
  try {
    const o = JSON.parse(prepDoc);
    if (o.tldr) return `<div class="prep-snip-tldr">${esc(o.tldr.slice(0, 300))}</div>`;
    if (o.event_id) return "";
  } catch {
  }
  return "";
}
function renderCalDay(dateStr) {
  const evs = calEvents.filter((e) => e.start_time.split("T")[0] === dateStr);
  const linkedIds = new Set(evs.map((e) => getLinkedMeetingForEvent(e)?.id).filter(Boolean));
  const orphanEvs = meetings.filter((m) => {
    if (!m.date) return false;
    return localDateStr(new Date(m.date)) === dateStr && !linkedIds.has(m.id) && !findLinkedCalEvent(m);
  }).map((m) => ({
    id: m.id,
    title: m.title,
    start_time: m.date,
    end_time: m.date,
    calendar_name: "",
    meeting_id: m.id,
    attendees: "[]",
    prep_status: "",
    prep_doc: ""
  }));
  const allEvs = [...evs, ...orphanEvs].sort((a, b) => a.start_time.localeCompare(b.start_time));
  if (!allEvs.length) return '<div class="day-empty">No meetings this day</div>';
  return '<div class="day-cards">' + allEvs.map((ev) => renderMeetingCard(ev)).join("") + "</div>";
}
function renderMeetingCard(e) {
  const now = /* @__PURE__ */ new Date();
  const st = new Date(e.start_time);
  const et = new Date(e.end_time);
  const isLive = now >= st && now <= et;
  const isSoon = !isLive && st.getTime() - now.getTime() < 9e5 && st > now;
  const isPast = now > et;
  const linked = getLinkedMeetingForEvent(e);
  const linkedHasContent = hasMeetingContent(linked);
  const attendees = parseAttendees(e.attendees);
  const minsLeft = isLive ? Math.round((et.getTime() - now.getTime()) / 6e4) : 0;
  const minsTill = isSoon ? Math.round((st.getTime() - now.getTime()) / 6e4) : 0;
  const mStatus = linked && linked.status !== "scheduled" ? linked.status : null;
  const statusBadge = mStatus === "recording" ? '<span class="mc-badge mc-badge-live"><span class="pulse-dot red"></span>Recording</span>' : mStatus === "stopping" || mStatus === "recorded" ? '<span class="mc-badge mc-badge-proc"><span class="spinner-sm"></span> Saving audio</span>' : mStatus === "transcribing" ? '<span class="mc-badge mc-badge-proc"><span class="spinner-sm"></span> Transcribing</span>' : mStatus === "pending" ? '<span class="mc-badge mc-badge-proc"><span class="spinner-sm"></span> Summarizing</span>' : mStatus === "summarized" || mStatus === "synced" ? '<span class="mc-badge mc-badge-done">\u2713 Ready</span>' : mStatus === "failed" ? '<span class="mc-badge mc-badge-fail">Failed</span>' : isLive ? '<span class="mc-badge mc-badge-live"><span class="pulse-dot red"></span>Live \xB7 ' + minsLeft + "m left</span>" : isSoon ? '<span class="mc-badge mc-badge-soon">In ' + minsTill + "m</span>" : isPast ? '<span class="mc-badge mc-badge-past">Past</span>' : "";
  const avatarsHtml = attendees.slice(0, 5).map(
    (a, i) => '<div class="mc-avatar" style="background:' + avatarColor(a.name || a.email) + ";z-index:" + (10 - i) + '" title="' + esc(a.name || a.email) + '">' + getInitials(a.name || a.email) + "</div>"
  ).join("");
  const overflow = attendees.length > 5 ? '<span class="mc-avatar-more">+' + (attendees.length - 5) + "</span>" : "";
  const snippet = e.prep_status === "ready" ? getPrepSnippet(e.prep_doc) : "";
  const snippetHtml = snippet ? '<div class="mc-prep">' + snippet + "</div>" : "";
  const prepBtn = e.prep_status === "ready" ? `<button class="mc-btn mc-btn-glass" onclick="event.stopPropagation();openMeeting('` + (linked?.id || e.id) + `','prep')">View Prep</button>` : e.prep_status === "preparing" ? `<button class="mc-btn mc-btn-glass" onclick="event.stopPropagation();viewPrep('${e.id}')"><span class="spinner-sm"></span> Prepping\u2026</button>` : e.prep_status === "failed" ? `<button class="mc-btn mc-btn-warn" onclick="event.stopPropagation();triggerPrep('` + e.id + `')">Retry Prep</button>` : `<button class="mc-btn mc-btn-glass" onclick="event.stopPropagation();triggerPrep('` + e.id + `')">\u2726 Prep</button>`;
  const actionBtn = linkedHasContent ? `<button class="mc-btn mc-btn-primary" onclick="event.stopPropagation();openMeeting('` + linked.id + `')">View Notes</button>` : linked && linked.status !== "scheduled" && linked.status === "recording" ? `<button class="mc-btn mc-btn-warn" onclick="event.stopPropagation();openMeeting('` + linked.id + `')">\u23F9 Stop</button>` : linked && linked.status !== "scheduled" ? `<button class="mc-btn mc-btn-glass" onclick="event.stopPropagation();openMeeting('` + linked.id + `')">` + statusLabel(linked.status) + "\u2026</button>" : `<button class="mc-btn mc-btn-primary" onclick="event.stopPropagation();startRecording('` + e.id + `')">\u25B6 Start</button>`;
  const cardClass = "mc" + (isLive ? " mc-live" : "") + (isSoon ? " mc-soon" : "") + (isPast ? " mc-past" : "");
  const clickAttr = linked && (linkedHasContent || linked.status !== "scheduled") ? ` onclick="openMeeting('` + linked.id + `')"` : "";
  return '<div class="' + cardClass + '"' + clickAttr + '><div class="mc-inner"><div class="mc-left"><div class="mc-title-row"><span class="mc-title">' + esc(e.title) + "</span>" + statusBadge + '</div><div class="mc-meta"><span class="mc-time">' + fmtTime(e.start_time) + " \u2013 " + fmtTime(e.end_time) + '</span><span class="mc-cal">' + esc(e.calendar_name || "Calendar") + "</span></div>" + (attendees.length ? '<div class="mc-avatars">' + avatarsHtml + overflow + "</div>" : "") + '</div><div class="mc-right">' + prepBtn + actionBtn + "</div></div>" + (snippet ? '<div class="mc-prep-row">' + snippet + "</div>" : "") + "</div>";
}
function showMonthDay(dateStr) {
  const evs = calEvents.filter((e) => e.start_time.split("T")[0] === dateStr);
  const detail = document.getElementById("month-day-detail");
  if (!detail || !evs.length) return;
  const d = /* @__PURE__ */ new Date(dateStr + "T12:00");
  const label = d.toLocaleDateString(void 0, { weekday: "long", month: "long", day: "numeric" });
  detail.innerHTML = `
    <div class="month-detail-header">${label}</div>
    <div class="week-day-events">
      ${evs.map((e) => {
    const linkedMeeting = getLinkedMeetingForEvent(e);
    const linked = linkedMeeting?.id || "";
    return `
        <div class="week-row${linked ? " week-row-linked" : ""}" ${linked ? `onclick="openMeeting('${linked}')"` : ""}>
          <span class="week-row-time">${fmtTime(e.start_time)}</span>
          <span class="week-row-dot" style="background:var(--accent)"></span>
          <span class="week-row-title">${esc(e.title)}</span>
          ${e.calendar_name ? `<span class="week-row-cal">${esc(e.calendar_name)}</span>` : ""}
          ${hasMeetingContent(linkedMeeting) ? `<span class="week-row-notes">${icon("note", 12)} Notes</span>` : ""}
          <span class="week-row-actions">
            ${e.prep_status === "ready" ? `<button class="week-action-btn" onclick="event.stopPropagation();openMeeting('${linked}')">${icon("sparkle", 12)} View Prep</button>` : e.prep_status === "preparing" ? `<button class="week-action-btn" onclick="event.stopPropagation();viewPrep('${e.id}')">${icon("sparkle", 12)} Prepping\u2026</button>` : e.prep_status === "failed" ? `<button class="week-action-btn week-action-warn" onclick="event.stopPropagation();triggerPrep('${e.id}')">${icon("sparkle", 12)} Retry</button>` : `<button class="week-action-btn" onclick="event.stopPropagation();triggerPrep('${e.id}')">${icon("sparkle", 12)} Prep</button>`}
            <button class="week-action-btn week-action-primary" onclick="event.stopPropagation();startRecording('${e.id}')">${icon("record", 12)} Start</button>
          </span>
        </div>`;
  }).join("")}
    </div>`;
}
function renderPrepView(ev) {
  const attendees = parseAttendees(ev.attendees);
  const isPreparing = ev.prep_status === "preparing";
  const isReady = ev.prep_status === "ready";
  let prep = null;
  if (isReady && ev.prep_doc) {
    try {
      prep = JSON.parse(ev.prep_doc);
    } catch {
    }
  }
  function renderPrepReady() {
    if (!prep) return `<div class="notes-editor notes-editable" contenteditable="false">${formatSummary(ev.prep_doc)}</div>`;
    const enriched = {};
    (prep.attendees || []).forEach((a) => {
      if (a.name) enriched[a.name.toLowerCase()] = a;
    });
    return `
      <div class="prep-doc">
        ${prep.tldr ? `
        <div class="prep-card prep-card-tldr">
          <div class="prep-card-label">${icon("sparkle", 13)} Walking in</div>
          <p class="prep-tldr-text">${esc(prep.tldr)}</p>
        </div>` : ""}

        <div class="prep-card">
          <div class="prep-card-label">${icon("person", 13)} Attendees</div>
          <div class="prep-people">
            ${attendees.slice(0, 12).map((a) => {
      const key = (a.name || "").toLowerCase();
      const info = enriched[key] || {};
      return `<div class="prep-person">
                <div class="avatar" style="background:${avatarColor(a.name || a.email)}">${getInitials(a.name || a.email)}</div>
                <div class="prep-person-info">
                  <div class="prep-person-name">${esc(a.name || a.email.split("@")[0])}</div>
                  ${info.title || info.company ? `<div class="prep-person-role">${esc([info.title, info.company].filter(Boolean).join(" \xB7 "))}</div>` : `<div class="prep-person-email">${esc(a.email)}</div>`}
                  ${info.bio ? `<div class="prep-person-bio">${esc(info.bio)}</div>` : ""}
                  ${info.linkedin ? `<a class="prep-person-linkedin" href="${info.linkedin}" target="_blank">${icon("person", 11)} LinkedIn</a>` : ""}
                </div>
              </div>`;
    }).join("")}
          </div>
        </div>

        ${prep.context && prep.context !== "No prior context found." ? `
        <div class="prep-card">
          <div class="prep-card-label">${icon("note", 13)} Context</div>
          <p class="prep-card-body">${esc(prep.context)}</p>
        </div>` : ""}

        ${prep.openItems && prep.openItems.length ? `
        <div class="prep-card">
          <div class="prep-card-label">${icon("check", 13)} Open items</div>
          <ul class="prep-list">
            ${prep.openItems.map((item) => `<li>${esc(item)}</li>`).join("")}
          </ul>
        </div>` : ""}

        ${prep.talkingPoints && prep.talkingPoints.length ? `
        <div class="prep-card">
          <div class="prep-card-label">${icon("chat", 13)} Talking points</div>
          <ul class="prep-list prep-list-talking">
            ${prep.talkingPoints.map((tp) => `<li>${esc(tp)}</li>`).join("")}
          </ul>
        </div>` : ""}

        ${prep.news ? `
        <div class="prep-card">
          <div class="prep-card-label">${icon("refresh", 13)} Recent news</div>
          <p class="prep-card-body">${esc(prep.news)}</p>
        </div>` : ""}

        ${prep.questionsToAsk && prep.questionsToAsk.length ? `
        <div class="prep-card prep-questions-card">
          <div class="prep-card-label">${icon("chat", 13)} Top 3 Questions to Ask ${prep.meetingType === "vc" ? '<span class="prep-vc-badge">VC \xB7 Rubric-scored</span>' : ""}</div>
          <div class="prep-questions-list">
            ${prep.questionsToAsk.map((qq, i) => `
              <div class="prep-q-item">
                <div class="prep-q-header">
                  <span class="prep-q-num">${i + 1}</span>
                  <span class="prep-q-category">${esc((qq.category || "").replace(/_/g, " "))}</span>
                  ${qq.score ? `<span class="prep-q-score">${Number(qq.score).toFixed(1)}</span>` : ""}
                </div>
                <div class="prep-q-text">${esc(qq.question)}</div>
                <div class="prep-q-why">${esc(qq.why)}</div>
              </div>
            `).join("")}
          </div>
        </div>` : ""}
      </div>`;
  }
  return `
    <div class="meeting-layout">
      <div class="meeting-topbar glass">
        <button class="btn-icon" id="btn-back">${icon("back", 20)}</button>
        <div class="meeting-topbar-title">${icon("sparkle", 16)} Prep: ${esc(ev.title)}</div>
        <div class="topbar-right">
          <span class="cal-time-chip">${fmtTime(ev.start_time)} \u2013 ${fmtTime(ev.end_time)}</span>
        </div>
      </div>
      <div class="meeting-body">
        ${isPreparing ? `
          <div class="prep-live">
            <div class="prep-live-header">
              <div class="spinner"></div>
              <span>Agent is researching your prep doc\u2026</span>
              ${prepStartTime ? `<span class="prep-elapsed">${Math.floor((Date.now() - prepStartTime) / 1e3)}s</span>` : ""}
            </div>
            ${prepLogs.length === 0 ? `
              <div class="prep-live-empty">Starting up\u2026</div>
            ` : `
              <div class="prep-log-card">
                <div class="prep-log-latest">${icon(prepLogs[prepLogs.length - 1].split(":")[0], 14)} ${esc(prepLogs[prepLogs.length - 1].split(":").slice(1).join(":"))}</div>
                ${prepLogs.length > 1 ? `
                  <div class="prep-log-history">
                    ${prepLogs.slice(-8, -1).reverse().map((l) => `<div class="prep-log-line">${icon(l.split(":")[0], 12)} ${esc(l.split(":").slice(1).join(":"))}</div>`).join("")}
                  </div>
                ` : ""}
              </div>
            `}
          </div>
        ` : isReady ? renderPrepReady() : ev.prep_status === "failed" ? `
          <div class="prep-failed-card">
            <div class="prep-failed-icon">${icon("alert", 24)}</div>
            <div class="prep-failed-text">
              <div class="prep-failed-title">Prep couldn't complete</div>
              <div class="prep-failed-sub">The agent ran into an issue. This usually resolves on retry.</div>
            </div>
            <button class="prep-retry-btn" onclick="triggerPrep('${ev.id}')">${icon("refresh", 14)} Try again</button>
          </div>
        ` : `
          <div class="prep-empty">
            <p>Click <strong>Prep</strong> on a calendar event to generate a prep document with attendee research, prior meeting context, and talking points.</p>
          </div>
        `}
      </div>
    </div>`;
}
function renderMeeting() {
  if (selectedCalId) {
    const ev2 = calEvents.find((e) => e.id === selectedCalId);
    if (ev2 && (activeTab === "prep" || !meetings.find((x) => x.id === selectedId))) {
      return renderPrepView(ev2);
    }
  }
  const m = meetings.find((x) => x.id === selectedId);
  const ev = m ? findLinkedCalEvent(m) : void 0;
  const isRec = selectedId === recordingId;
  const title = m?.title || "New Meeting";
  const status = m?.status || (isRec ? "recording" : "");
  const bodyHtml = isRec ? `
    <div id="notes-editor" class="notes-editor is-empty" contenteditable="true" spellcheck="true"
      data-placeholder="Write your notes\u2026&#10;&#10;Key decisions, action items, context \u2014 whatever matters to you."></div>
  ` : renderDetailBody(m);
  const hasNotes = m?.notes?.trim();
  const hasTranscript = m?.transcript?.trim();
  const showTabs = !isRec && (hasNotes || hasTranscript || ev?.prep_status === "ready");
  return `
    <div class="meeting-layout">
      <div class="meeting-topbar glass">
        <button class="btn-icon" id="btn-back">${icon("back", 20)}</button>
        <div class="meeting-topbar-title" id="meeting-title" contenteditable="${!isRec}" spellcheck="false">${esc(title)}</div>
        <div class="topbar-right">
          ${isRec ? `
            <span class="rec-indicator">${icon("mic", 14)} <span id="rec-timer">${fmtDur(elapsedSeconds)}</span></span>
            <button class="btn-stop" id="btn-stop">${icon("stop", 14)} Stop Recording</button>
          ` : `
            <span class="status-chip ${statusClass(status)}">${statusLabel(status)}</span>
          `}
        </div>
      </div>
      ${showTabs ? `
      <div class="meeting-tabs">
        <div class="meeting-tabs-left">
          <button class="meeting-tab${activeTab === "notes" ? " active" : ""}" data-tab="notes">${icon("note", 14)} Notes</button>
          ${ev?.prep_status === "ready" ? `<button class="meeting-tab${activeTab === "prep" ? " active" : ""}" data-tab="prep">${icon("sparkle", 14)} Prep</button>` : ""}
          ${hasTranscript ? `<button class="meeting-tab${activeTab === "transcript" ? " active" : ""}" data-tab="transcript">${icon("mic", 14)} Transcript</button>` : ""}
        </div>
        <div class="meeting-tabs-right">${renderMeetingMeta(m)}</div>
      </div>` : ""}
      <div class="meeting-body">${bodyHtml}</div>
    </div>`;
}
function renderMeetingMeta(m) {
  const tags = extractTags(m);
  const linked = findLinkedCalEvent(m);
  const attendees = linked ? parseAttendees(linked.attendees) : [];
  if (!tags.length && !attendees.length) return "";
  return `<div class="meeting-meta">
    ${tags.length ? `<div class="meeting-meta-tags">${tags.map((t) => `<span class="meta-tag">${esc(t)}</span>`).join("")}</div>` : ""}
    ${attendees.length ? `<div class="meeting-meta-people">
      ${attendees.slice(0, 8).map((a) => `<span class="meta-avatar" style="background:${avatarColor(a.name || a.email)}" title="${esc(a.name || a.email)}">${(a.name || a.email)[0].toUpperCase()}</span>`).join("")}
      ${attendees.length > 8 ? `<span class="meta-avatar-more">+${attendees.length - 8}</span>` : ""}
    </div>` : ""}
  </div>`;
}
function renderDetailBody(m) {
  if (!m) return '<p style="padding:40px;opacity:.4">Meeting not found</p>';
  if (["stopping", "recorded", "transcribing", "pending"].includes(m.status)) {
    const s = m.status;
    const recDone = s !== "stopping";
    const worActive = s === "recorded" || s === "transcribing";
    const worDone = s === "pending";
    const sumActive = s === "pending";
    return `
      ${m.notes ? `<div class="notes-editor notes-readonly">${/<[a-z][\s\S]*>/i.test(m.notes) ? m.notes : formatSummary(m.notes)}</div>` : ""}
      <div class="pipeline-progress">
        <div class="pipeline-step ${recDone ? "done" : "active"}"><div class="pipeline-step-dot"></div><span>${recDone ? "Recorded" : "Saving audio\u2026"}</span></div>
        <div class="pipeline-connector"></div>
        <div class="pipeline-step ${worDone ? "done" : worActive ? "active" : ""}"><div class="pipeline-step-dot"></div><span>Transcribing</span></div>
        <div class="pipeline-connector"></div>
        <div class="pipeline-step ${sumActive ? "active" : ""}"><div class="pipeline-step-dot"></div><span>Summarizing</span></div>
      </div>`;
  }
  if (m.status === "failed") {
    return `<div class="pipeline-failed-bar glass">
      <div class="pipeline-failed-inner">
        ${icon("alert", 16)}
        <span>Processing didn't complete</span>
        <button class="pipeline-retry-btn" id="btn-retry-pipeline">${icon("refresh", 13)} Retry</button>
      </div>
    </div>`;
  }
  const hasSummary = m.summary?.trim();
  if (activeTab === "notes") {
    const isHtml = (s) => /<[a-z][\s\S]*>/i.test(s);
    const fmt = (s) => isHtml(s) ? s : formatSummary(s);
    const content = hasSummary ? fmt(m.summary) : "";
    return `<div id="notes-editor" class="notes-editor notes-editable${!content ? " is-empty" : ""}" contenteditable="true" spellcheck="true" data-placeholder="Add your notes\u2026">${content}</div>`;
  }
  if (activeTab === "prep") {
    const ev = findLinkedCalEvent(m);
    const prepDoc = ev?.prep_doc || "";
    if (prepDoc) {
      return `<div id="notes-editor" class="notes-editor notes-editable" contenteditable="true" spellcheck="true">${formatSummary(prepDoc)}</div>`;
    }
    return '<p style="padding:40px;opacity:.4">No prep available yet</p>';
  }
  if (activeTab === "transcript" && m.transcript) {
    return `<div id="notes-editor" class="notes-editor notes-editable" contenteditable="false" spellcheck="false">${formatSummary(m.transcript)}</div>`;
  }
  return `<div id="notes-editor" class="notes-editor notes-editable is-empty"
      contenteditable="true" spellcheck="true" data-placeholder="Add your notes\u2026"></div>`;
}
function attachListeners() {
  document.querySelectorAll(".meeting-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      flushSave();
      activeTab = btn.dataset.tab || "notes";
      loadAll();
    });
  });
  document.getElementById("btn-open-settings")?.addEventListener("click", () => {
    fetch("/api/shell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'" })
    }).catch(() => {
    });
  });
  document.getElementById("btn-retry-perm")?.addEventListener("click", async () => {
    showPermModal = false;
    const ok = await checkPerm();
    if (!ok) {
      showPermModal = true;
      render();
      return;
    }
    startRecording();
  });
  document.getElementById("btn-new-rec")?.addEventListener("click", () => startRecording());
  document.getElementById("btn-audio-device")?.addEventListener("click", (e) => {
    e.stopPropagation();
    showAudioMenu = !showAudioMenu;
    render();
  });
  document.getElementById("btn-refresh-devices")?.addEventListener("click", (e) => {
    e.stopPropagation();
    refreshAudioDevices();
  });
  document.querySelectorAll(".audio-device-option").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(el.dataset.devIdx || "-1");
      const name = el.dataset.devName || "";
      selectAudioDevice(idx, name);
    });
  });
  document.addEventListener("click", () => {
    if (showAudioMenu) {
      showAudioMenu = false;
      render();
    }
  });
  document.getElementById("btn-toggle-bg")?.addEventListener("click", () => toggleBgHero());
  document.getElementById("btn-refresh-bg")?.addEventListener("click", async () => {
    await runJob(BG_JOB).catch(() => {
    });
    await sleep(2e3);
    await loadAll();
  });
  document.querySelectorAll("[data-cal-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      startRecording(btn.dataset.calId);
    });
  });
  document.querySelectorAll("[data-cal-prep-trigger]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      triggerPrep(btn.dataset.calPrepTrigger);
    });
  });
  document.querySelectorAll("[data-cal-prep]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedCalId = btn.dataset.calPrep;
      view = "meeting";
      activeTab = "prep";
      render();
    });
  });
  document.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => {
    mainPage = b.dataset.page;
    render();
  }));
  document.querySelectorAll("[data-calview]").forEach((b) => b.addEventListener("click", () => {
    calView = b.dataset.calview;
    render();
  }));
  document.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.filter;
      render();
    });
  });
  document.getElementById("btn-topic-select")?.addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("dropdown-topics")?.classList.toggle("open");
    document.getElementById("dropdown-people")?.classList.remove("open");
  });
  document.getElementById("btn-people-select")?.addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("dropdown-people")?.classList.toggle("open");
    document.getElementById("dropdown-topics")?.classList.remove("open");
  });
  document.querySelectorAll("[data-tag]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const t = cb.dataset.tag;
      if (cb.checked) {
        if (!activeTags.includes(t)) activeTags.push(t);
      } else {
        activeTags = activeTags.filter((x) => x !== t);
      }
      render();
    });
  });
  document.querySelectorAll("[data-person]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const p = cb.dataset.person;
      if (cb.checked) {
        if (!activePeople.includes(p)) activePeople.push(p);
      } else {
        activePeople = activePeople.filter((x) => x !== p);
      }
      render();
    });
  });
  document.getElementById("clear-topics")?.addEventListener("click", () => {
    activeTags = [];
    render();
  });
  document.getElementById("clear-people")?.addEventListener("click", () => {
    activePeople = [];
    render();
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".filter-dropdown.open").forEach((d) => d.classList.remove("open"));
  }, { once: true });
  document.querySelectorAll(".meeting-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".delete-btn, .btn-icon")) return;
      openMeeting(card.dataset.meetingId);
    });
  });
  document.querySelectorAll(".card-del").forEach((btn) => {
    btn.addEventListener("click", (e) => deleteMeeting(btn.dataset.id, e));
  });
  document.getElementById("btn-back")?.addEventListener("click", () => {
    flushSave();
    view = "home";
    loadAll();
  });
  document.getElementById("btn-stop")?.addEventListener("click", () => stopRecording());
  document.getElementById("meeting-title")?.addEventListener("blur", async (e) => {
    const el = e.target;
    if (selectedId && el.textContent?.trim()) {
      await w("UPDATE meetings SET title=?, updated_at=strftime('%s','now') WHERE id=?", [el.textContent.trim(), selectedId]);
    }
  });
  const editor = document.getElementById("notes-editor");
  editor?.addEventListener("input", () => {
    editor.classList.toggle("is-empty", !editor.innerText.trim());
    autoSave();
  });
  document.getElementById("btn-retry-pipeline")?.addEventListener("click", () => {
    if (selectedId) {
      runJob(WHISPER_JOB).catch(() => {
      });
      startPoll(selectedId);
    }
  });
}
window.shiftWeek = async (dir) => {
  calWeekOffset += dir;
  const today = /* @__PURE__ */ new Date();
  const todayStr = localDateStr(today);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay() + calWeekOffset * 7);
  const indices = calWeekOffset === 0 && (today.getDay() === 0 || today.getDay() === 6) ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
  const days = indices.map((i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return localDateStr(d);
  });
  calView = days.includes(todayStr) ? todayStr : days[0];
  render();
  runJob(CALENDAR_JOB).catch(() => {
  });
  await sleep(3e3);
  await loadAll();
};
window.openMeeting = openMeeting;
window.showMonthDay = showMonthDay;
window.triggerPrep = triggerPrep;
window.viewPrep = async (id) => {
  selectedCalId = id;
  view = "meeting";
  activeTab = "prep";
  if (!prepStartTime) prepStartTime = Date.now();
  render();
  await loadAll();
  fetchPrepLogs();
  if (!prepPollInterval) {
    startPrepPoll(id);
  }
};
window.startRecording = startRecording;
(async () => {
  calView = localDateStr(/* @__PURE__ */ new Date());
  await loadAll();
  await runJob(CALENDAR_JOB).catch(() => {
  });
  await runJob(BG_JOB).catch(() => {
  });
  await sleep(1500);
  await loadAll();
  await recoverRecordingState();
  await recoverStuckPreps();
  detectLiveLocation().catch(() => {
  });
  setInterval(async () => {
    if (view !== "home") return;
    try {
      meetings = await q("SELECT * FROM meetings ORDER BY created_at DESC");
    } catch {
    }
    try {
      calEvents = await q(`SELECT id, title, start_time, end_time, calendar_name, meeting_id,
        COALESCE(attendees, '[]') as attendees, COALESCE(prep_status, '') as prep_status,
        COALESCE(prep_doc, '') as prep_doc
        FROM calendar_events
        WHERE NOT (start_time LIKE '%T00:00' AND end_time LIKE '%T23:59')
        ORDER BY start_time ASC`);
    } catch {
    }
    render();
  }, 3e4);
})();
