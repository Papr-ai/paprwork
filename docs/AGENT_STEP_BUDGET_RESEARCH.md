# How Many Steps Should a Turn Take?

**Written:** 2026-09-11
**Status:** Research + proposal. No implementation yet.
**Question asked:** is there a best practice for the optimal number of steps per turn, backed by data, and what do Anthropic / Cursor / OpenAI / xAI actually do about it?

---

## The short answer

**There is no optimal step count, and every lab that tried to enforce one has moved away from it.** Cursor shipped a hard cap on tool calls per turn in 2024 and deliberately removed it as models improved [7]. The research converges on the same conclusion from the opposite direction: the useful control variable is not *how many* steps, it is *what each step costs* and *when to stop* [1][2][5].

That matters for us because we have been reading our own numbers wrong. Our worst recent turn ran **93 steps and cost $8.97**. The instinct is to cap steps. But the measured breakdown says the step count was roughly appropriate for the work (42 `bash`, 34 `edit_file`, 14 `read_file` — real edits, not thrashing), and the cost came from two things that have nothing to do with the step *limit*:

1. **Each step re-sent ~104,000 tokens**, of which roughly half was tool definitions for tools the turn never called.
2. **We issue 1.19 tool calls per step** — very nearly serial — where Anthropic reports 3+ in parallel as standard [6].

Those two are multiplicative and both are fixable. A hard cap is neither, and would have truncated a turn that was making progress.

---

## Part 1 — What the research says

### 1.1 More steps helps, then stops helping, then hurts

The clearest framing comes from work on utility-guided orchestration [1]:

> "better task performance usually requires more reasoning steps, more tool interactions, and longer execution trajectories, which in turn increase token usage and wall-clock latency"

and, on the failure mode:

> "free-form multi-step agents, such as ReAct-style systems, can adapt their behavior online, but they may also over-execute. Typical failure modes include repeated retrieval after useful evidence has already been obtained, redundant tool calls with highly similar intent, and continued reasoning even when the marginal value of another step is low."

This is the shape of the curve — rising, flattening, then declining — and the reason a fixed number cannot be right: the inflection point is per-instance, not per-system.

**Models are measurably bad at judging this for themselves.** Across seven models, two tools and six tasks, "models call tools they do not need and skip tools that would help, since perceived need and utility track their true, outcome-defined counterparts only weakly; this gap **widens under a fixed budget**, where models misprioritize calls and exceed their own limits" [2]. That last clause is important for anyone planning to solve this by telling the model "you have 20 tool calls" — the paper found that instruction makes allocation *worse*, not better.

### 1.2 Error compounding sets a hard ceiling on serial depth

The arithmetic is unforgiving and widely cited (Chip Huyen, *AI Engineering*, via [12]):

> "A model with 95% per-step accuracy drops to 60% reliability over 10 sequential steps, and under 1% over 100 steps. This is not a hypothetical. It is a mathematical property of sequential systems with imperfect components."

At 93 steps, `0.95^93 ≈ 0.8%`. Our turns plainly do better than that, because steps are not independent Bernoulli trials — agents observe failure and self-correct, and most steps are low-risk reads. But the direction is real and it is the reason "just let it run" is not a strategy. The same source lands on the operational conclusion: "every added LLM call is a new opportunity to compound errors. Use deterministic control flow wherever order is predictable." smolagents states it as a rule: "Reduce the number of LLM calls as much as you can" [12].

There is a measured mitigation. CHARM adds stage-level fact verification, cross-stage consistency tracking and confidence-propagation monitoring, and reports **89.4% cascade detection at a 5.3% false-positive rate and 82.1% reduction in error propagation**, against 18.5% for output-level detectors, at ~215 ms overhead per stage [11]. The lesson is that catching a bad step early is worth far more than limiting the number of steps.

### 1.3 Long trajectories degrade through the context, not the step counter

This is the mechanism that actually bites us, because our steps are large.

- **Lost in the middle** (Liu et al., Stanford/TACL 2024): performance follows a U-shaped curve across input position. In multi-document QA with 20 documents, accuracy dropped **more than 30%** when the relevant document sat in positions 5–15 rather than first or last — and this holds for models explicitly built for long context [10].
- **Databricks** found correctness begins dropping around **32,000 tokens**, far below nominal limits [12].
- **Chroma Research** documented "context rot" in July 2025: measurable degradation as input length grows [12].

The practical statement of it [9]:

> "if you can accomplish a task with N tokens of well-chosen context, adding K tokens of material that is not relevant to that specific task — resolved prior turns, **tool definitions for tools not in use**, file contents not germane to the current edit — will produce a worse result. The performance penalty scales with K."

That sentence names our exact defect. It is not only that 145 unused tool definitions cost money; they are predicted to make the model *worse*.

Two more figures worth carrying:

- **Cognition (Devin)** measured that agents spend **over 60% of their first turn just retrieving context** — not editing, not reasoning [10].
- Work on long-running agents identified a threshold at **~35 minutes** of human-equivalent task time, after which success rate declines, and the relationship is non-linear: **doubling task duration quadruples the failure rate** [10]. Our 93-step turn ran 8m22s, so we are inside that envelope — but a 25-minute average in the 41–80 step bucket (see Part 3) is not comfortably inside it.

Note the honest caveat from the same body of work: compaction is a **partial** answer. "Compaction is a reactive, prefix-breaking, coarse mitigation. It reduces token cost spikes but does not resolve the underlying performance degradation" [9]. We already knew a version of this — LOCA-bench showed compaction *lowering* accuracy from 38.7% to 36.0%, cited in our own Issue 86 notes.

### 1.4 Fewer, bigger decisions beat more, smaller ones

Two independent results say the same thing.

**Planning horizon.** Comparing full-horizon planning (plan everything, then execute, replanning lazily) against single-step horizon (the ReAct default of one action per reasoning turn), across Knowledge Base QA and multi-hop QA: "FH planning with lazy replanning achieves accuracy parity with SH across varying depths, breadths, and robustness levels, while using **2–3× fewer tokens**" [3]. The authors set out to test the standard assumption that step-wise monitoring is needed for adaptability and found "no consistent accuracy advantage for SH over FH, nor evidence that SH is more robust to increased topological complexity or noisy tool behavior."

**Action chunking.** Emitting several primitive actions per model round cut decision rounds by **up to 78.9%** — but the paper is equally clear that the effect is non-monotonic. An RL baseline on Llama-3.1-8B over-committed to 5–6 actions per round and scored *substantially lower*; the method that worked "sustain[ed] about **three to four actions per LLM round**" and the authors stress "the key ... is not enabling multi-action output but learning action granularity" [4].

**Three to four is the only concrete number in the literature that answers the user's question directly** — and it is an emergent optimum on long-horizon benchmarks, not a cap. We currently run 1.19.

### 1.5 The recommended control is a stopping rule

Every paper that offers a mechanism offers the same one: stop on *marginal utility*, not on a counter. Proposed criteria across [1] and [5] are marginal expected gain, cumulative budget, redundancy against evidence already gathered, and evidence-completion. [5] formalises it as a sequential stopping problem and learns query-specific cutoffs, deriving the decision from "the payoff difference between the current prefix and its best continuation."

---

## Part 2 — What the labs actually ship

### 2.1 Anthropic: attack the per-step cost, not the step count

Anthropic has published the most directly applicable numbers, and all three of their levers target *what a step carries*.

| Feature | Problem | Measured effect |
|---|---|---|
| **Tool Search Tool** | Tool definitions bloat context | **85% reduction** in tool-definition tokens (77K → 8.7K). Accuracy on MCP evals: Opus 4 **49% → 74%**; Opus 4.5 **79.5% → 88.1%** [6] |
| **Programmatic Tool Calling** | Round trips burn tokens | **+11% performance with 24% fewer input tokens** on BrowseComp / DeepSearchQA; **37% reduction** (43,588 → 27,297 tokens) on complex research; **20–40%** savings for requests carrying 10–49 tool definitions [6][13] |
| **Tool Use Examples** | Schemas can't express usage | accuracy **72% → 90%** [6] |

The guidance is explicit and we violate it: *"Keep your three to five most-used tools always loaded, defer the rest"* [6]. And **Claude Code enables this automatically**: MCP tool search auto mode has been on by default since v2.1.7, deferring tool descriptions once they exceed **10% of the context window**, tunable via `ENABLE_TOOL_SEARCH=auto:N` [6].

We ship **152 tools ≈ 86K tokens against a 200K cap — about 43%**, four times Claude Code's deferral threshold.

Anthropic is equally clear about when the step-reduction lever does *not* pay: on τ²-bench, "where each turn makes one or two sequential tool calls, programmatic tool calling left scores unchanged and cost roughly 8% more. Sequential single-call workflows do not benefit" [13]. Batching helps fan-out, not inherently serial work.

On step count itself, their multi-agent post gives the most striking datum [8]:

> "three factors explained 95% of the performance variance in the BrowseComp evaluation ... token usage by itself explains 80% of the variance, with the number of tool calls and the model choice as the two other explanatory factors."

Read carefully, that is an argument *for* spending steps when the task needs them — and for buying capacity by adding parallel context windows rather than lengthening one. Their parallelisation ("the lead agent spins up 3-5 subagents in parallel"; "the subagents use 3+ tools in parallel") "cut research time by up to **90%** for complex queries" [8]. Subagents return "only a condensed, distilled summary of its work (often **1,000-2,000 tokens**)" [14].

### 2.2 Cursor: they removed the step cap on purpose

This is the single most relevant precedent, because Cursor tried exactly the intervention we are contemplating [7]:

> "When we first developed our coding agent in late 2024, models were much worse at choosing their own context and we invested lots of context engineering work into creating guardrails — for example, surfacing lint and type errors to the agent after every edit, rewriting its file reads when it requested too few lines, and **even limiting the maximum number of tools it could call in one turn**."

And then, by 2026: *"we've adapted to increasing model capability by knocking down guardrails and providing more dynamic context."* The trend line runs away from caps.

What they replaced it with, with numbers:

- **Dynamic context discovery for MCP** — sync tool descriptions to a folder, give the agent only tool *names* and let it look up definitions on demand. A/B test on real traffic: **46.9% reduction in total agent tokens** for runs that called an MCP tool (statistically significant, high variance by MCP count) [15].
- **Tool output to files instead of truncation** — "In Cursor, we instead write the output to a file and give the agent the ability to read it. The agent calls `tail` to check the end, and then read more if it needs to" [15]. This is our Issue 70 sidecar design, independently arrived at.
- **RL-trained self-summarisation** (Composer) — compaction learned in the loop rather than prompted. At both 80K and 40K triggers it "reduces the error from compaction by **50%** ... while using **one-fifth of the tokens** and reusing the KV cache," measured against a tuned prompt baseline that itself used thousands of prompt tokens and a dozen structured sections [16].
- **10× reduction in unexpected tool call errors**, with per-tool per-model anomaly baselines [7][17].

Their stated metric set is worth copying: "latency, token efficiency, **tool call count**, and cache hit rate" as directional signals, plus CursorBench, "Keep Rate" for code retention, and LLM-based sentiment for the fuzzier question of whether the agent did a good job [7].

### 2.3 OpenAI: a dial for eagerness, and one turn per task

OpenAI's control is `reasoning_effort`, and they are explicit that it governs tool-calling appetite, not just thinking depth: it "controls how much the model thinks **and how eagerly it calls tools**," and "higher reasoning efforts can also lead to more tool calls" [18][20]. Their prescription for reducing tangential tool calls is to lower effort and to "define clear criteria in your prompt for how you want the model to explore the problem space" [18].

They do endorse explicit budgets, but as a last resort and as prompt content: *"If you're willing to be maximally prescriptive, you can even set fixed tool call budgets"* [18]. Note this sits in tension with [2], which measured that fixed budgets degrade allocation quality.

The most actionable line for us [18]:

> "we observe peak performance when **distinct, separable tasks are broken up across multiple agent turns, with one turn for each task**."

That is a direct answer to "what is the optimal number of steps per turn": few enough that the turn is one task. A 93-step turn is almost certainly several tasks wearing one coat.

Also relevant to cost: switching from Completions to the Responses API "boosted cache utilization from 40% to 80%" by carrying reasoning items across tool calls [19]. Our cache hit rate on the $8.97 turn was already 97.2%, so this lever is closed for us — worth stating so nobody spends time on it.

### 2.4 xAI: server-side execution and an explicit turn limit

xAI exposes `max_turns` to bound reasoning iterations, and notes parallel calls can occur within a turn [21]. Their built-in tools (web search, X search, code interpreter) execute **server-side**, so a built-in tool call costs no round trip back to the harness — structurally the same saving as Anthropic's programmatic tool calling [22]. Parallel function calling is **on by default** [23]. One hard constraint worth knowing: **max 200 tools per request** [23]. We are at 152.

### 2.5 Framework defaults, for calibration

| Framework | Default limit | Counts |
|---|---|---|
| OpenAI Agents SDK | `DEFAULT_MAX_TURNS = 10` | conversation turns [24] |
| smolagents | `max_steps = 20` | agent steps [25] |
| LangGraph | 25 (SDK schema) / **1000** since v1.0.6 | graph super-steps [26][27] |
| Claude Agent SDK | no default limit | tool-use turns |
| xAI | `max_turns`, configurable | reasoning iterations [21] |
| **Paprwork** | **`maxSteps ?? 100`**, force-stop 95 | AI SDK steps |
| **Paprwork (pi-ai)** | **`maxSteps * 2 = 200`** tool calls | tool calls |

These counters are not comparable unit-for-unit, but the spread is informative: we sit at the permissive end, 10× the OpenAI SDK default. LangGraph's move from 25 to 1000 is the same directional signal as Cursor's — the industry is loosening, not tightening.

---

## Part 3 — Where we actually stand

Measured from `messages` turn metrics in the active namespace database.

### Steps are heavily concentrated in cost

| Steps | Turns | Avg duration | Total cost |
|---|---:|---:|---:|
| 1–5 | 2 | 0.2 min | $2.79 |
| 6–10 | 2 | 3.7 min | $0.35 |
| 11–20 | 3 | 4.5 min | $6.34 |
| 21–40 | 7 | 6.2 min | $12.39 |
| 41–80 | 2 | **25.3 min** | $12.37 |
| 81+ | 2 | 11.5 min | $10.04 |

**Four turns of 18 (22%) ran over 40 steps and account for $22.41 of $44.28 — 51% of spend.** The 41–80 bucket averages 25.3 minutes, which is inside the ~35-minute degradation threshold [10] but not by much.

### We are running almost fully serial

| Turn | Steps | Tool calls | Tools/step |
|---|---:|---:|---:|
| 09-12T02:35 | 19 | 33 | 1.74 |
| 09-12T02:08 | 23 | 38 | 1.65 |
| 09-12T01:19 | 63 | 75 | 1.19 |
| **09-12T00:48** | **93** | **94** | **1.01** |
| 09-11T21:14 | 107 | 109 | 1.02 |

**Average 1.19, best observed 1.74.** Against Anthropic's "3+ tools in parallel" [8] and the research optimum of 3–4 actions per round [4], this is the largest untapped lever we have, and it is entirely on our side of the wire.

### The two levers are multiplicative

Holding the work constant at 94 tool calls and using the measured average fixed cost of 104,007 tokens per request at the blended rate of $0.7141/MTok:

| Tools per step | Steps | Prompt cost |
|---|---:|---:|
| 1.01 (today) | 94 | $7.78 |
| 2 | 47 | $4.29 |
| 3 | 32 | **$3.18** |
| 4 | 24 | $2.58 |

And independently, tool-schema deferral at Anthropic's measured 85% [6] removes roughly 45K tokens from *every* request. Applied together — ~32 steps at ~59K tokens instead of 93 at ~104K — the same turn lands near **$2** rather than $8.97, without capping anything.

### What is already working, and should not be touched

Worth stating so the doc is not read as a call to change everything:

- **Prompt caching is healthy** — 97.2% cache read on the $8.97 turn, already saving ~$49 on that turn alone.
- **Compaction is behaving correctly** — 94 runs, 0 gate declines, 1 result cut, 4,278 left inline, and critically **0 recovery fetches**, confirming no re-read loop. Issue 86's break-even logic is holding.
- **The Issue 89 cap fix delivered the real win** — average request size fell from 310,572 to 104,007 tokens on the same 200K cap, a 3.0× reduction.

---

## Part 4 — What we should do

Ordered by evidence strength and effort. Nothing here is a step cap.

### Tier 1 — Cut the per-step payload (strongest evidence, largest effect)

**1. Defer tool definitions.** Keep the ~7 tools a turn actually uses loaded; make the rest discoverable. Anthropic measures 85% reduction *and* an accuracy gain [6]; Cursor measures 46.9% fewer total tokens in an A/B test on production traffic [15]. Claude Code triggers this automatically past 10% of context; we sit at ~43%. This is the single best-evidenced change available to us, and it is the one that also improves quality rather than trading against it.

Concretely: adopt Anthropic's `defer_loading` on the API-key route where the platform supports it, and implement a `search_tools` equivalent for the OAuth route. Start with the obvious offenders — `register_schema` and `update_schema` together are ~30% of the tool block and were never called.

**2. Add tool use examples** to the handful of high-traffic tools. 72% → 90% parameter accuracy [6], and each avoided parameter error is an avoided step plus the "context rot" of the error text persisting in context [7].

### Tier 2 — Cut the step count structurally (good evidence, medium effort)

**3. Make parallel tool calls the default and prompt for them.** We are at 1.19; the research optimum is 3–4 [4] and Anthropic runs 3+ [8]. This is the lever with the clearest arithmetic on our own data (2.4× on the $8.97 turn). The literature's warning applies: over-chunking hurt success rates on Llama-3.1-8B [4], so target 3 and measure, do not push to 6.

**4. Batch the obvious fan-out.** 42 `bash` and 14 `read_file` calls in one turn is mostly independent discovery. Programmatic tool calling gives Anthropic 20–40% on requests with 10–49 tool definitions [13]; even without it, a batched-read tool or a single script would collapse many of those calls into one. Note the counter-evidence: this does nothing for genuinely sequential work and costs 8% more there [13] — so gate it on fan-out shape, not apply it universally.

**5. Delegate separable work to subagents.** Anthropic's pattern — deep exploration in an isolated window, returning a 1,000–2,000 token summary [14] — maps onto our existing delegation machinery. Their caveat matters: subagents *increase* total token spend while protecting the parent context, so this is a quality-and-latency play, not a cost play. Use it for independent verbose tasks; keep tightly coupled reasoning in one agent.

**6. Encourage one turn per separable task.** OpenAI reports peak performance when distinct tasks get distinct turns [18]. A 93-step turn is a prompt-level problem as much as a harness one.

### Tier 3 — Stop on utility, not on a counter (right answer, most work)

**7. Replace the wrap-up-at-95 threshold with a marginal-utility stopping rule.** Criteria from [1] and [5]: no new information in the last N steps, redundant tool calls with near-identical intent, cumulative budget exceeded, evidence-completion satisfied. We already have the instrument for this — Enhancement 87's turn metrics — and the hooks (`resolveModelStop`, `stopWhen`).

**8. Detect a stalling turn early rather than stopping it late.** CHARM-style stage verification reports 82.1% reduction in error propagation [11]. Cheap version first: flag repeated near-identical tool calls, which is both the documented over-execution signature [1] and something we can detect from `tool_calls` with no model involvement.

### Explicitly do not do

- **Do not lower `maxSteps` as the primary fix.** Cursor removed this exact guardrail as models improved [7]; LangGraph raised its default from 25 to 1000 [27]. A cap truncates good long turns and does nothing about the 104K tokens each step carries. Keep 100 as a runaway backstop; do not treat it as a tuning knob.
- **Do not put a fixed tool-call budget in the system prompt** as a first move. [2] measured that fixed budgets *widen* the gap between perceived and true need and cause models to misprioritise and overrun their own limits. OpenAI offers it as a maximally-prescriptive last resort [18], not a default.
- **Do not expect more compaction to fix this.** Compaction is "a reactive, prefix-breaking, coarse mitigation" that "does not resolve the underlying performance degradation" [9], LOCA-bench measured it lowering accuracy, and on our 200K cap history is only ~8% of the window — deleting all of it saves about $1 of $8.97.
- **Do not chase cache utilisation.** Already at 97.2%.

---

## Part 5 — How we would know it worked

We have the columns from Enhancement 87 already. The metrics that matter, matching Cursor's set [7]:

| Metric | Source | Today | Target |
|---|---|---|---|
| Tool calls per step | `turn_tool_calls / turn_steps` | 1.19 | ≥ 2.5 |
| Fixed tokens per request | `prompt_tokens / turn_steps` | 104,007 | < 60,000 |
| Tool block share of window | `toolTokens / contextLimit` | ~43% | < 10% [6] |
| Steps per turn | `turn_steps` | median 23, max 107 | no target — watch, don't cap |
| Cost per turn | `cost` | $8.97 worst | < $3 |
| Recovery fetches | `turn_recovery_fetches` | 0 | stays 0 |
| Turn duration | `turn_duration_ms` | 25 min avg in 41–80 bucket | < 35 min [10] |

Two things to hold onto. First, **step count is a diagnostic, not a target** — if tool-schema deferral works, step count may not move at all while cost falls by half, and that is success. Second, every intervention here trades against quality somewhere in the literature, so a cost metric without a paired quality metric will rank a degraded agent as an improvement. That is exactly what LOCA-bench caught compaction doing. Enhancement 87's `plan_completed` is a tripwire, not a quality score; a real answer needs a fixed labelled task set, which is a separate build.

---

## References

1. *Utility-Guided Agent Orchestration for Efficient LLM Tool Use* — https://arxiv.org/pdf/2603.19896
2. *To Call or Not to Call: A Framework to Assess and Optimize LLM Tool Calling* — https://arxiv.org/html/2605.00737v3
3. *Do Agents Need to Plan Step-by-Step? Rethinking Planning Horizon in Data-Centric Tool Calling* — https://doi.org/10.1145/3786335.3813129
4. *Act More, Decide Less: Skill-Guided Adaptive Action Chunking for Long-Horizon LLM Agents* — https://arxiv.org/abs/2609.02042v1
5. *Scores Are Not Decisions: Cost-Aware Stopping for Tool Acquisition in LLM Agents* — https://export.arxiv.org/pdf/2607.27083
6. Anthropic, *Introducing advanced tool use on the Claude Developer Platform* — https://www.anthropic.com/engineering/advanced-tool-use
7. Cursor, *Continually improving our agent harness* — https://cursor.com/blog/continually-improving-agent-harness
8. Anthropic, *How we built our multi-agent research system* — https://www.anthropic.com/engineering/multi-agent-research-system
9. *The Context Rot Problem: Why AI Coding Agents Get Worse As They Work* — https://empromptu.ai/resources/context-rot-progressive-prompt-ephemerality
10. *Context Rot: Why LLMs Degrade as Context Grows* (collects Liu et al. TACL 2024; Cognition; 35-minute threshold) — https://www.morphllm.com/context-rot
11. *Cascading Hallucination in Agentic RAG: The CHARM Framework* — https://www.alphaxiv.org/abs/2606.04435
12. *AI Agents: What They Are, How They Work, and Why Web Context Is the Missing Piece* (collects error-compounding math, Databricks 32K, Chroma context rot, WebArena/GAIA) — https://www.firecrawl.dev/blog/ai-agents
13. Anthropic, *Programmatic tool calling* — https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
14. Anthropic, *Effective context engineering for AI agents* — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
15. Cursor, *Dynamic context discovery* — https://cursor.com/blog/dynamic-context-discovery
16. Cursor, *Training Composer for longer horizons* — https://cursor.com/blog/self-summarization
17. ZenML LLMOps Database, *Cursor: Engineering and Optimizing an Agent Harness* — https://www.zenml.io/llmops-database/engineering-and-optimizing-an-agent-harness-for-production-ai-coding-assistants
18. OpenAI, *GPT-5 prompting guide* — https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide
19. OpenAI, *Reasoning items and the Responses API* — https://developers.openai.com/cookbook/examples/responses_api/reasoning_items
20. OpenAI, *Reasoning models / reasoning effort* — https://developers.openai.com/api/docs/guides/reasoning
21. xAI, *Tools overview* — https://docs.x.ai/developers/tools/overview
22. xAI, *Advanced usage* — https://docs.x.ai/developers/tools/advanced-usage
23. xAI, *Function calling* — https://docs.x.ai/developers/tools/function-calling
24. OpenAI Agents SDK, `run_config.py` — https://github.com/openai/openai-agents-python/blob/3a11cf52/src/agents/run_config.py
25. smolagents, agent reference — https://huggingface.co/docs/smolagents/main/en/reference/agents
26. LangGraph SDK, `recursion_limit` — https://reference.langchain.com/python/langgraph-sdk/schema/Config/recursion_limit
27. LangGraph, graph API / recursion limit — https://docs.langchain.com/oss/python/langgraph/graph-api

Internal, for the measured figures: Issue 86 (compaction pressure gate), Issue 89 (context cap enforcement), Issue 90 (cache double-billing), Issue 91 (per-turn usage accumulation), Enhancement 87 (turn metrics), Enhancement 93 (TOON + dependency-walk fix).
