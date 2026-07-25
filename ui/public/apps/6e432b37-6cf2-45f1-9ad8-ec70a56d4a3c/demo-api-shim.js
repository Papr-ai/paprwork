/* Demo API shim — intercepts the local-server calls the Meetings app makes
 * (/api/db/query, /api/db/write, /api/jobs/*, /api/shell) and answers them
 * with in-memory fixture data so the full UI renders inside the static web
 * demo (no Paprwork gateway present). Loaded before app.js.
 *
 * Timestamps are LOCAL-naive ("YYYY-MM-DDTHH:MM:SS", no Z) so the app's
 * day-matching (localDateStr(new Date(x)) and start_time.slice(0,10)) lands
 * fixtures on TODAY regardless of timezone. */
(function () {
  var pad = function (n) { return String(n).padStart(2, "0"); };
  function local(offsetMs) {
    var d = new Date(Date.now() + (offsetMs || 0));
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  var H = 3600000;

  var MEETINGS = [
    {
      id: "m-northwind-qbr",
      title: "Northwind Traders — Q1 QBR",
      date: local(-2 * H),
      created_at: local(-2 * H),
      status: "synced",
      duration: 2730,
      tags: JSON.stringify(["QBR", "Northwind", "Renewal"]),
      summary:
        "## Summary\nStrong quarter review with Northwind. Dana confirmed budget for " +
        "the expansion and asked for an ROI one-pager to bring to her CFO.\n\n" +
        "## Decisions\n- Move forward with the 40-seat expansion\n- Send security questionnaire by Friday\n\n" +
        "## Action items\n| Owner | Task | Due |\n| **You** | Send ROI one-pager | Wed |\n| **Sam** | Loop in solutions eng | Thu |",
      notes: "Dana very engaged — reopened pricing twice this week.",
      transcript:
        "Dana: Thanks for making time. We're happy with the pilot...\n" +
        "You: Glad to hear it. Let's talk about scaling to the full team...\n" +
        "Dana: Budget's approved on my side, I just need the CFO sign-off.",
    },
    {
      id: "m-acme-deal-desk",
      title: "Acme Logistics — Deal Desk",
      date: local(-5 * H),
      created_at: local(-5 * H),
      status: "synced",
      duration: 1980,
      tags: JSON.stringify(["Acme", "Pricing", "CFO"]),
      summary:
        "## Summary\nMarcus (CFO) wants a hard ROI model framed on hours saved per rep " +
        "before signing. Procurement is the gate, not product fit.\n\n" +
        "## Action items\n| Owner | Task | Due |\n| **You** | Build ROI model | Mon |",
      notes: "Numbers-first buyer. Lead with payback period.",
      transcript:
        "Marcus: The product looks fine. I need to see the math.\n" +
        "You: Understood — I'll send a model on hours saved per rep per week.",
    },
    {
      id: "m-team-weekly",
      title: "Revenue Team — Weekly Sync",
      date: local(-26 * H),
      created_at: local(-26 * H),
      status: "summarized",
      duration: 1500,
      tags: JSON.stringify(["Internal", "Pipeline"]),
      summary:
        "## Summary\nPipeline review. Northwind and Acme are the two furthest-along " +
        "Q1 deals. Klein Supply moved from cold to discovery after their Series A.",
      notes: "Priya to own the GA launch workstream.",
      transcript: "Priya: Let's focus energy on the 24 high-intent accounts...",
    },
  ];

  var CAL_EVENTS = [
    {
      id: "ce-northwind-followup",
      title: "Northwind — ROI Review",
      start_time: local(2 * H),
      end_time: local(3 * H),
      calendar_name: "Work",
      meeting_id: null,
      attendees: JSON.stringify([
        { name: "Dana Whitfield", email: "dana@northwind.example" },
        { name: "You", email: "you@papr.ai" },
      ]),
      prep_status: "ready",
      prep_doc:
        "## Prep — Northwind ROI Review\n\n**Goal:** get CFO sign-off.\n\n" +
        "- Dana is your champion; frame everything on hours saved.\n" +
        "- Bring the one-pager; expect questions on payback period.\n" +
        "- Upsell path: 40 seats now, services later.",
    },
    {
      id: "ce-klein-intro",
      title: "Klein Supply — Intro Call",
      start_time: local(5 * H),
      end_time: local(5 * H + 1800000),
      calendar_name: "Work",
      meeting_id: null,
      attendees: JSON.stringify([
        { name: "Jordan Klein", email: "jordan@kleinsupply.example" },
        { name: "Sam Ortiz", email: "sam@papr.ai" },
      ]),
      prep_status: "none",
      prep_doc: null,
    },
  ];

  function rowsFor(sql) {
    var s = String(sql || "").toLowerCase();
    if (s.indexOf("from meetings") !== -1) return MEETINGS;
    if (s.indexOf("from calendar_events") !== -1) return CAL_EVENTS;
    if (s.indexOf("from audio_devices") !== -1)
      return [{ device_index: 0, name: "MacBook Pro Microphone" }];
    if (s.indexOf("from audio_settings") !== -1)
      return [{ id: 1, selected_device_index: 0, selected_device_name: "MacBook Pro Microphone" }];
    if (s.indexOf("from permission_checks") !== -1) return [{ result: "granted" }];
    return [];
  }

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  var json = function (obj) {
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
  };

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    try {
      if (url.indexOf("/api/db/query") !== -1) {
        var body = init && init.body ? JSON.parse(init.body) : {};
        return json({ rows: rowsFor(body.sql) });
      }
      if (url.indexOf("/api/db/write") !== -1) return json({ ok: true });
      if (url.indexOf("/api/jobs/logs") !== -1) return json({ data: { logs: "" } });
      if (url.indexOf("/api/jobs/run") !== -1) return json({ ok: true });
      if (url.indexOf("/api/shell") !== -1) return json({ ok: true, stdout: "" });
    } catch (e) { /* fall through */ }
    if (realFetch) return realFetch(input, init);
    return json({});
  };
})();
