/* Demo API shim for the Focus (Home) app in the static web emulator.
 * Answers the gateway calls the app makes (/api/workspace/*, /api/db/*, /api/jobs/*,
 * /api/home/*) from demo-focus.json so the full Focus page renders with no Paprwork
 * gateway. Writes (checking a task, Lock in my three) mutate the in-memory copy so
 * the demo feels live. Loaded before every other script. */
(function () {
  var pad = function (n) { return String(n).padStart(2, "0"); };
  function dayKey(offset) {
    var d = new Date(); d.setDate(d.getDate() + offset);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function resolve(v) {
    if (typeof v === "string") {
      var m = /^@([+-]\d+)$/.exec(v); if (m) return dayKey(Number(m[1]));
      m = /^@ts-(\d+)([hd])$/.exec(v);
      if (m) return new Date(Date.now() - Number(m[1]) * (m[2] === "h" ? 36e5 : 864e5)).toISOString();
      return v;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === "object") {
      var out = {}; Object.keys(v).forEach(function (k) { out[resolve(k)] = resolve(v[k]); }); return out;
    }
    return v;
  }
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "demo-focus.json", false); xhr.send();
  var F = resolve(JSON.parse(xhr.responseText));
  var reviews = [];

  function json(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: { "Content-Type": "application/json" } }));
  }
  function tasksBody() {
    var counts = { open: 0, done: 0, dropped: 0 };
    F.tasks.forEach(function (t) { counts[t.status] = (counts[t.status] || 0) + 1; });
    return { tasks: F.tasks, counts: counts, dbAvailable: true };
  }
  function briefRows(sql) {
    var dates = Object.keys(F.briefs).sort().reverse();
    var m = /date='(\d{4}-\d{2}-\d{2})'/.exec(sql);
    if (m) dates = dates.filter(function (d) { return d === m[1]; });
    if (/LIMIT 1\b/.test(sql)) dates = dates.slice(0, 1);
    return dates.map(function (d) { return { date: d, brief_json: JSON.stringify(F.briefs[d]) }; });
  }
  function rowsFor(sql) {
    if (/FROM\s+briefs/i.test(sql)) return briefRows(sql);
    if (/FROM\s+brief_reviews/i.test(sql)) return reviews;
    return [];
  }
  function body(init) { try { return JSON.parse((init && init.body) || "{}"); } catch (e) { return {}; } }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || String(input);
    var path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    var method = ((init && init.method) || "GET").toUpperCase();
    if (path === "/api/workspace/focus/repick") return json(F.focus);
    if (path === "/api/workspace/focus") {
      if (method === "PUT") {
        var b = body(init), all = F.focus.three.concat(F.focus.candidates);
        if (Array.isArray(b.picks) && b.picks.length) {
          F.focus.three = b.picks.map(function (p) {
            var id = typeof p === "string" ? p : p.id;
            var base = Object.assign({}, all.find(function (g) { return g.id === (p.goalId || id); }) || { origin: "custom", status: "on-track", level: "L1" });
            if (typeof p === "object") Object.keys(p).forEach(function (k) { if (p[k] !== undefined && p[k] !== "") base[k] = p[k]; });
            return base;
          });
        }
        F.focus.confirmed = true;
      }
      return json(F.focus);
    }
    if (path === "/api/workspace/goals") return json(F.goals);
    if (path === "/api/workspace/tasks") return json(tasksBody());
    var done = /^\/api\/workspace\/tasks\/([^/]+)\/done$/.exec(path);
    if (done) {
      var t = F.tasks.find(function (x) { return x.id === decodeURIComponent(done[1]); });
      var dv = body(init).done; if (t) t.status = (dv === false || dv === 0 || dv === "0") ? "open" : "done";
      return json({ ok: true, task: t });
    }
    if (path === "/api/db/query") return json({ rows: rowsFor(body(init).sql || "") });
    if (path === "/api/db/query-batch") {
      return json({ results: (body(init).statements || []).map(function (s) { return { ok: true, rows: rowsFor(s.sql || "") }; }) });
    }
    if (path === "/api/db/write") return json({ ok: true, changes: 1 });
    if (path === "/api/home/ensure-brief-setup") return json({ ok: true, jobId: "demo-daily-brief" });
    if (path === "/api/jobs/run") return json({ success: true, runId: "demo-run" });
    if (path.indexOf("/api/jobs/status/") === 0) return json({ status: "completed" });
    if (path.indexOf("/api/") === 0) return json({ ok: true });
    return realFetch(input, init);
  };
})();
