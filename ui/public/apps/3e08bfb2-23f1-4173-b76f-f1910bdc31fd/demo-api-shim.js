/* Demo API shim — X Action Engine.
 * Intercepts the local-server calls the app makes (/api/db/query,
 * /api/db/write, /api/jobs/run, /api/bash/run) and answers them with
 * in-memory fixtures so the full UI renders inside the static web demo
 * (no Paprwork gateway present). Loaded before app.js. */
(function () {
  function iso(offsetMs) {
    return new Date(Date.now() + (offsetMs || 0)).toISOString();
  }
  var M = 60000, H = 3600000;

  var TWEETS = [
    {
      id: "t-1",
      text:
        "Everyone's shipping AI agents. Almost nobody's solved memory.\n\n" +
        "An agent that forgets every session isn't an assistant — it's a " +
        "very expensive autocomplete. The moat is context, not the model.",
      author_username: "swyx",
      author_name: "swyx",
      author_profile_image: "https://i.pravatar.cc/150?img=12",
      created_at: iso(-42 * M),
      reply_count: 84, retweet_count: 213, like_count: 1902,
      media_url: null,
      search_topic: "ai memory",
      score: 94,
      score_type: "give_value",
      score_reason:
        "Directly on your core thesis (persistent memory as the moat). High-reach " +
        "author in your ICP, 1.9k likes in 42min — early enough to be a top reply.",
      draft_reply:
        "This matches what we keep seeing: the model is the commodity, the " +
        "context layer is the product. The hard part isn't storing memory, " +
        "it's retrieving the *right* 2% at inference time without blowing " +
        "the window. Retrieval quality is the real benchmark.",
      draft_quote:
        "The moat is context, not the model — strongly agree.\n\n" +
        "Memory is easy to store and brutally hard to retrieve well. " +
        "That gap is where the next generation of agents gets won.",
      status: "scored",
    },
    {
      id: "t-2",
      text:
        "Hot take: RAG isn't dead, it was just never supposed to be a " +
        "vector DB + top-k and call it a day. Ranking is the whole game.",
      author_username: "jerryjliu0",
      author_name: "Jerry Liu",
      author_profile_image: "https://i.pravatar.cc/150?img=33",
      created_at: iso(-2 * H),
      reply_count: 47, retweet_count: 96, like_count: 743,
      media_url: null,
      search_topic: "rag retrieval",
      score: 88,
      score_type: "give_value",
      score_reason:
        "Adjacent to your retrieval-quality positioning. Author is a category " +
        "leader; a substantive reply here gets seen by exactly your buyers.",
      draft_reply:
        "Agreed. Top-k similarity answers \"what's nearby\" when the real " +
        "question is \"what matters for this task, right now.\" We've had far " +
        "more lift from re-ranking + recency/graph signals than from swapping " +
        "embedding models.",
      draft_quote:
        "Ranking is the whole game.\n\nSimilarity gets you candidates. " +
        "Relevance needs task context, recency, and relationships — that's " +
        "a different problem than nearest-neighbor search.",
      status: "scored",
    },
    {
      id: "t-3",
      text:
        "Been using Papr for a couple weeks to give my agents long-term " +
        "memory. The knowledge-graph angle is underrated — it actually " +
        "remembers how things connect, not just what I said.",
      author_username: "mkastner",
      author_name: "Maya Kastner",
      author_profile_image: "https://i.pravatar.cc/150?img=45",
      created_at: iso(-5 * H),
      reply_count: 12, retweet_count: 18, like_count: 156,
      media_url: null,
      search_topic: "papr",
      score: 97,
      score_type: "papr_mention",
      score_reason:
        "Direct positive Papr mention from a credible builder. Highest-leverage " +
        "reply on the board — respond warmly and specifically, not with a pitch.",
      draft_reply:
        "Thanks Maya — this is exactly the use case we built the graph for. " +
        "If you're chaining multiple agents, try scoping retrieval per-agent; " +
        "it cuts a lot of cross-talk. Happy to look at your setup if useful.",
      draft_quote:
        "\"It actually remembers how things connect, not just what I said.\"\n\n" +
        "Best description of why we went graph-first instead of pure vector.",
      status: "scored",
    },
    {
      id: "t-4",
      text:
        "Shipped: our agents now keep state across sessions. Took 3 weeks " +
        "of plumbing we probably shouldn't have written ourselves.",
      author_username: "danabra_mov",
      author_name: "Dan Abramov",
      author_profile_image: "https://i.pravatar.cc/150?img=68",
      created_at: iso(-7 * H),
      reply_count: 31, retweet_count: 42, like_count: 512,
      media_url: null,
      search_topic: "agent memory",
      score: 79,
      score_type: "give_value",
      score_reason:
        "Explicit build-vs-buy pain signal. Be helpful first — no pitch. " +
        "Good long-term relationship play.",
      draft_reply:
        "The plumbing tax is real. The part that usually bites later isn't " +
        "storage — it's eviction and scoping: which memories are still true, " +
        "and which agent should see them. Worth designing before it grows.",
      draft_quote:
        "\"3 weeks of plumbing we probably shouldn't have written ourselves.\"\n\n" +
        "Memory infrastructure is the new auth — everyone rebuilds it once, " +
        "then regrets it.",
      status: "scored",
    },
    {
      id: "t-5",
      text:
        "Context windows keep growing and people keep acting like that " +
        "solves memory. It doesn't. You're just paying more to re-read " +
        "the same thing every turn.",
      author_username: "simonw",
      author_name: "Simon Willison",
      author_profile_image: "https://i.pravatar.cc/150?img=52",
      created_at: iso(-9 * H),
      reply_count: 63, retweet_count: 140, like_count: 1104,
      media_url: null,
      search_topic: "context window",
      score: 85,
      score_type: "give_value",
      score_reason:
        "Cost-of-context argument you can extend with real numbers. " +
        "Technical, credible audience.",
      draft_reply:
        "Also a latency and accuracy problem, not just cost — recall degrades " +
        "in the middle of long contexts. Retrieving 2k relevant tokens beats " +
        "stuffing 200k mediocre ones, and it's ~100x cheaper per turn.",
      draft_quote:
        "Bigger context windows aren't memory — they're a bigger desk.\n\n" +
        "You still need to decide what goes on it.",
      status: "scored",
    },
  ];

  var SETTINGS = [
    { key: "topics", value: JSON.stringify(["ai memory", "rag retrieval", "agent memory", "context window", "papr"]) },
    { key: "company_name", value: "Papr" },
    { key: "company_desc", value: "Persistent memory and knowledge graphs for AI agents" },
  ];

  function rowsFor(sql, params) {
    var s = String(sql || "").toLowerCase();
    if (s.indexOf("from tweets") !== -1) {
      if (s.indexOf("score > 0") !== -1 || s.indexOf("draft_reply") !== -1) return TWEETS;
      return TWEETS;
    }
    if (s.indexOf("from settings") !== -1) {
      var key = (params && params[0]) || (s.indexOf("'topics'") !== -1 ? "topics" : null);
      var hit = SETTINGS.filter(function (r) { return r.key === key; });
      return hit.length ? [{ value: hit[0].value }] : [];
    }
    if (s.indexOf("from draft_feedback") !== -1) return [];
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
        return json({ rows: rowsFor(body.sql, body.params) });
      }
      if (url.indexOf("/api/db/write") !== -1) return json({ ok: true });
      if (url.indexOf("/api/jobs/logs") !== -1) return json({ data: { logs: "" } });
      if (url.indexOf("/api/jobs/run") !== -1) return json({ ok: true });
      if (url.indexOf("/api/bash/run") !== -1) return json({ ok: true, stdout: "" });
      if (url.indexOf("/api/shell") !== -1) return json({ ok: true, stdout: "" });
    } catch (e) { /* fall through */ }
    if (realFetch) return realFetch(input, init);
    return json({});
  };
})();
