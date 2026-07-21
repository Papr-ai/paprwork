# Paprwork Pricing Plans — Draft for Team Review

**Status:** Draft v5.1  
**Created:** 2026-07-16  
**Updated:** 2026-07-16  
**Purpose:** Align product, engineering, and GTM on tiers, usage caps, and feature gates before implementation in `papr-dev-platform` billing and memory-server meters.

---

## 1. Summary

Paprwork is priced as **one workspace** that replaces several tools:

| Comparable product | What Papr covers |
|--------------------|------------------|
| **n8n** | Scheduled automations (jobs, cloud runs) |
| **Lovable / Replit** | Mini-apps + cloud hosting (`apps.papr.ai`) |
| **Claude Cowork** | Desktop agent + tools (BYOK/OAuth unlimited locally) |
| **Company brain** | Papr Memory (chat, code, workspace context) |

### 1.1 Pricing principles

1. **Network effects first** — Free must let users experience Papr’s **differentiation** locally and in the cloud at **small scale**: invite a few teammates, share apps, install from community, build automations + visual dashboards, and grow memory.
2. **Local-first PLG** — **Unlimited local** jobs, mini-apps, and BYOK/OAuth agent on **every plan** (no local run meter). Monetize **cloud**, **memory**, **cloud storage**, and **team size** — not local execution.
3. **Usage meters + soft teammate caps** — Monetize via **shared usage pools**; teammate invites capped at **3 (Free)**, **10 (Cloud)**, **unlimited (Pro+)** to balance network effects with cost control.
4. **Two automation meters** — Large **cloud runs** pool (simple jobs) + smaller **agent jobs** sub-cap (AI in cloud). Caps derived from COGS (see §4).
5. **Cost-aligned caps** — Every included bucket maps to a **max COGS** per tier; overage priced at pass-through + margin. Never subsidize unbounded cloud agent or viral app traffic on Free.
6. **Overage on every plan** — Same unit rates across Free, Cloud, Pro, Team, and Business. Included buckets are generous; **opt-in pay-as-you-go** when users exceed them (spend cap required on all tiers).
7. **Plain language** — Customer-facing terms: cloud runs, agent jobs, memories, app visits, stored data, agent turns.

### 1.2 What Free must prove (differentiation pillars)

Users on Free should complete real workflows that competitors split across multiple products:

| Pillar | Free experience | Upgrade trigger |
|--------|-------------------|-----------------|
| **Automation + visual apps** | **Unlimited local** jobs + mini-apps; agent helps build both; **limited** cloud runs (taste while Mac asleep) | Daily cloud schedule, **2,000** cloud runs on Cloud |
| **Memory / brain** | Cross-chat memory, workspace context, code index **taste** (capped) | Heavy indexing, holographic search, scale |
| **Community + sharing** | Install community apps, **share** dashboards via link, up to **3 teammates** | More teammates (10 → unlimited), public listing, remove badge |
| **Network** | Small team shares **limited free cloud** pool → hits caps faster → upgrade | Cloud $20 for serious always-on automation |

**Design rule:** Gate **cloud volume, memory, cloud storage, and team invites** — never **local execution**. Heavy local use eventually hits the user’s own RAM/disk; that organic friction + need for Mac-asleep automation pushes upgrades to Cloud — not artificial Papr caps on device storage.

---

## 2. Plans at a glance

| | **Free** | **Cloud** | **Pro** | **Team** | **Business** |
|--|----------|-----------|---------|----------|--------------|
| **Price** | $0 | **$20/mo** | **$100/mo** | **$200/mo** | **$500/mo** |
| **Positioning** | **Try everything locally + limited free cloud** | Automate & share in cloud | Daily builder + public apps | Shared workspace + admin | Volume + enterprise controls |
| **Workspace members** | **Up to 3** | **Up to 10** | **Unlimited** | **Unlimited** | **Unlimited** |
| **Share link viewers** | Unlimited | Unlimited | Unlimited | Unlimited | Unlimited |

**Note on members:** Soft caps encourage small-team PLG on Free (3) and Cloud (10) without per-seat pricing. **Share link viewers** stay unlimited — viral distribution doesn’t count toward member cap. Pro+ removes member limits; revenue still scales via **usage pools** when teams grow.

---

## 3. Monthly usage caps (shared workspace pool)

All caps reset each billing cycle. **Unused amounts do not roll over** (Shopify-style).

| Cap | **Free** | **Cloud** | **Pro** | **Team** | **Business** |
|-----|----------|-----------|---------|----------|--------------|
| **Cloud runs** | **150** | **2,000** | 10,000 | 40,000 | 200,000 |
| **Agent jobs** (cloud sub-cap) | **10** | **50** | 250 | 1,000 | 5,000 |
| **Memories** | **2,000** | 5,000 | 25,000 | 100,000 | 500,000 |
| **App visits** | **5,000** | 25,000 | 150,000 | 500,000 | 2,000,000 |
| **Cloud stored data** | **250 MB** | 1 GB | 10 GB | 50 GB | 250 GB |
| **Agent turns** (Papr-hosted LLM) | **150** | 750 | 4,000 | 10,000 | 30,000 |
| **Workspace members** | **3** | **10** | Unlimited | Unlimited | Unlimited |

**Not metered (all plans):** Local job runs while Mac/PC is awake · BYOK / OAuth / Ollama agent · Local mini-apps on device SQLite · **Local disk** (user-controlled budget — see §3.6).

*v5.1 Free: unlimited local execution; plan caps = cloud, memory, cloud storage, members. See §3.4.*

### 3.4 Free tier — what’s capped vs unlimited

| | **Free (unlimited)** | **Free (capped)** |
|--|----------------------|-------------------|
| Desktop agent + tools | ✅ | — |
| Local jobs (Mac awake) | ✅ Unlimited | — |
| Local mini-apps + device SQLite | ✅ | — |
| BYOK / OAuth / Ollama | ✅ | — |
| Cloud runs (Mac asleep) | — | **150/mo** |
| Agent jobs in cloud | — | **10/mo** |
| Memories (index + sync) | — | **2,000** |
| Cloud stored data (Turso + sync) | — | **250 MB** |
| Cloud-hosted app visits | — | **5,000/mo** |
| Papr proxy agent turns | — | **150/mo** |
| Workspace members | — | **3 max** |

**Upgrade to Cloud ($20)** when users need **always-on cloud**, **more memory/storage**, **10 teammates**, or **2,000 cloud runs** — not because local jobs were blocked.

### 3.5 Local execution — unlimited on all plans *(decided)*

**Decision:** No local run meter on any tier. Free users run unlimited local jobs while their machine is on.

Caps apply only to **cloud runs**, **memories**, **cloud stored data**, **app visits**, **Papr proxy agent turns**, and **workspace member invites** — see table in §3.

### 3.6 Local device storage — user budget, not a plan cap *(decided)*

Local data (`~/Papr`, job SQLite files, app assets) lives on **the user’s machine**. Papr does **not** tier-limit device storage for billing.

| Aspect | Policy |
|--------|--------|
| **Plan tiers** | No device storage cap on Free / Cloud / Pro |
| **Default budget** | **10 GB** soft limit for `~/Papr` on first install — user can **raise or lower** in Settings |
| **At budget** | Warn + suggest cleanup, cloud sync, or raising the limit — **not** a paywall |
| **Hard ceiling** | User’s actual disk + RAM; excessive local jobs eventually slow or fill the machine |
| **Upgrade nudge** | When local is cramped or Mac must stay off → **cloud runs** + **cloud stored data** on Cloud $20 |

**Product UX:** Settings → Storage → “Local Papr data budget” with usage bar, default 10 GB, slider or input to increase (e.g. 50 GB, 200 GB, unlimited*). *Unlimited = warn only when OS disk is low.

**Why not a plan meter:** Zero Papr COGS; punishing disk use on Free fights PLG. Natural device limits + cloud automation are the upgrade path.

### 3.1 Definitions (customer-facing)

| Term | Definition |
|------|------------|
| **Cloud run** | One execution of a **script job** (python, bash, shell, node) in the cloud — typically when the Mac is asleep or user explicitly runs in cloud. **One run = whole job**, any number of internal steps (same fairness model as n8n executions). |
| **Agent job** | One execution of an **agent** or **subagent** job in the cloud. Uses full secure sandbox. Counts toward **both** cloud runs and agent jobs caps. |
| **Memories** | Items Papr actively remembers (stored memory + indexed context — not raw chat message count). |
| **App visits** | Each load of a shared cloud mini-app (`apps.papr.ai`). Cached refreshes approximate one visit per ~10s polling window. |
| **Cloud stored data** | Cloud-synced job and app database storage (Turso + related). Billed by plan tier + overage. |
| **Local data budget** | User-configurable soft limit for `~/Papr` on their device (default **10 GB**). Not a plan cap — see §3.6. |
| **Agent turns** | AI requests routed through **Papr-hosted** models (proxy). Does not apply when user uses BYOK, OAuth, or Ollama locally. |

### 3.2 What does NOT consume cloud runs

| Activity | Billing |
|----------|---------|
| Jobs while **Mac is awake** (local gateway) | **Unlimited** — all plans |
| Desktop chat with **BYOK / OAuth / Ollama** | **Unlimited** — all plans |
| Local mini-apps reading device SQLite | **Unlimited** — subject to user’s **local data budget** (§3.6) or physical disk |
| Git sync, vault sync (within plan) | Included; cloud meters apply when synced data hits caps |

### 3.3 Execution tiers (engineering)

Not all cloud work uses the same infrastructure:

| Job type | Cloud path | COGS (approx.) |
|----------|------------|----------------|
| Script jobs (python/bash/node) | **Light cloud runner** | ~$0.002–0.01/run |
| Agent jobs | **Full sandbox** (gVisor) | ~$0.02–0.15+/run |

Sandbox was chosen for **security and resilience** (arbitrary user code, vault, git, Turso) — not because every Papr action goes through a sandbox. See `docs/PAPR_CLOUD_RUNTIME_PLAN.md`.

---

## 4. Cost alignment (how caps map to COGS)

Caps are set so **maxed-out included usage** stays within a target **COGS budget per tier**, with overage recovering cost + margin.

### 4.1 Unit cost assumptions (internal)

Based on `docs/PAPR_CLOUD_RUNTIME_PLAN.md` §12 and execution-tier split:

| Meter | Internal unit | COGS (estimate) | Notes |
|-------|---------------|-----------------|-------|
| **Cloud run** (light) | 1 script job, ~5 min | **$0.005** | Light runner; not full sandbox |
| **Agent job** (cloud) | 1 agent job, ~5 min | **$0.03** | GKE sandbox ~$0.014 compute + orchestration buffer |
| **App visit** | 1 page load + light DB | **$0.0002** | After 10s read cache (`dbRequestGuard`) |
| **Memory** | 1 stored/indexed unit | **$0.002** | Indexing + storage blended |
| **Stored data** | 1 GB-month | **$0.50** | Turso + sync (blended) |
| **Agent turn** | 1 Papr proxy request | **$0.02** | Blended mini/premium; BYOK = $0 |

**Fixed per workspace (amortized):** git repo, control plane, vault — ~**$0.50–1.50/mo** per active cloud user.

### 4.2 Max COGS if user exhausts included caps

| Tier | Subscription | Max variable COGS* | Fixed COGS | **Total max COGS** | **Target gross margin** |
|------|--------------|-------------------|------------|-------------------|-------------------------|
| **Free** | $0 | ~$5.50 | ~$1.00 | **~$6.50** | Acquisition cost (target 8–12% Free→paid in 90d) |
| **Cloud** | $20 | ~$14 | ~$1.50 | **~$15.50** | ~22% min → ~50% typical |
| **Pro** | $100 | ~$75 | ~$2.00 | **~$77** | ~23% min → ~60% typical |
| **Team** | $200 | ~$280 | ~$3.00 | **~$283** | Requires most teams **not** maxing; pooled usage |
| **Business** | $500 | ~$1,400 | ~$5.00 | **~$1,405** | Enterprise mix; annual contracts |

\*Variable COGS calculated from cap × unit cost above (e.g. Cloud: 2,000×$0.005 + 50×$0.03 + 5k×$0.002 + 25k×$0.0002 + 1×$0.50 + 750×$0.02 ≈ $10 + $1.50 + $10 + $5 + $0.50 + $15 ≈ **$42** theoretical max; practical usage ~30–40% of cap → **~$14** variable).

**Key insight:** Most users don’t max every meter. Price on **expected** usage (~35% of cap), not worst case. Hard platform limits (`dbRequestGuard`, agent sub-cap, spend cap) protect tail risk.

### 4.3 Free tier COGS budget (v2 caps)

| Meter | Free cap | Max COGS if exhausted |
|-------|----------|----------------------|
| Cloud runs | 150 | $0.75 |
| Agent jobs | 10 | $0.30 |
| Memories | 2,000 | $4.00 |
| App visits | 5,000 | $1.00 |
| Stored data | 250 MB | $0.13 |
| Agent turns | 150 | $3.00 |
| **Total variable** | | **~$9.18** |

Target **typical** Free user (20% of caps): **~$1.50–2.50/mo** — acceptable PLG CAC if 10%+ convert within 90 days.

**Why we can be generous on Free for sharing/memory:** App visits and memories are cheap at low volume with caching; **agent jobs** and **agent turns** stay tightly capped.

### 4.4 Overage pricing vs COGS (margin check)

| Meter | COGS | Overage price | Margin |
|-------|------|---------------|--------|
| Cloud runs | ~$0.005 | $0.05 | ~90% |
| Agent jobs | ~$0.03 | $0.30 | ~90% |
| App visits (per 10k) | ~$2 | $5 | ~60% |
| Memories (per 1k) | ~$2 | $5 | ~60% |
| Storage (per GB) | ~$0.50 | $2 | ~75% |
| Agent turns (per 1k) | ~$20 | **$25** | ~20% margin at scale |

### 4.5 What we do NOT subsidize on Free

| High-risk usage | Free policy |
|-----------------|-------------|
| Always-on cloud agent loops | Agent jobs cap = **10** |
| Viral public app (millions of visits) | No public apps on Free; visit cap + rate limits |
| Papr-hosted LLM at scale | 150 agent turns; BYOK unlimited locally |
| Full sandbox 24/7 | Cloud runs cap; local unlimited when Mac on |

---

## 5. Overage and spend controls

**All plans** use the same overage unit rates. Included caps are the primary value; overage is **opt-in** everywhere so no one is hard-blocked without a path forward.

| | **Free** | **Cloud** | **Pro** | **Team** | **Business** |
|--|----------|-----------|---------|----------|--------------|
| **Overage** | Opt-in (card required) | Opt-in | Opt-in | Opt-in | Opt-in |
| **Default spend limit** | **$5/mo** | **$25/mo** | **$100/mo** | **$250/mo** | **$500/mo** |
| **User can edit limit** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Bill overage when** | Extra usage **> $1** in a month | Same | Same | Same | Same |
| **At cap, overage off** | Pause metered cloud features; local + BYOK continues | Pause cloud meters past included + limit | Same | Same | Same |

**Free overage flow:** User hits a cap → in-app prompt: *“Enable extra usage”* → add payment method → set spend limit (default **$5**) → same rates as paid tiers. Most users will still upgrade to Cloud for **better included buckets** ($20 >> sporadic overage).

### Overage rates (all plans)

| Meter | Overage rate |
|-------|--------------|
| Cloud runs | $0.05 / run |
| Agent jobs | $0.30 / job |
| App visits | $5 / 10,000 visits |
| Memories | $5 / 1,000 memories |
| Stored data | $2 / GB / month |
| Agent turns | $25 / 1,000 turns *(raised to stay above COGS — see §4.4)* |

### At-limit behavior

| Situation | Overage **off** | Overage **on** |
|-----------|-----------------|----------------|
| Cloud runs exhausted | Pause **cloud** script jobs; local jobs continue | Bill $0.05/run until spend limit |
| Agent jobs sub-cap hit | Pause **cloud** agent jobs; local agent + BYOK continues | Bill $0.30/job until spend limit |
| App visits exhausted | Throttle **public/share** traffic (429) | Bill per 10k visits until spend limit |
| Memories / cloud storage cap | Block new cloud sync/index until upgrade or overage | Bill per unit until spend limit |
| Agent turns (Papr proxy) | Hard pause Papr-hosted turns; BYOK/OAuth continues | Bill $25/1k until spend limit |
| Spend limit hit | Pause all metered cloud + overage billing | — |
| Alerts | Email + in-app at **50%, 80%, 100%** of included caps and **80%, 100%** of spend limit |

---

## 6. Features by plan

### 6.1 Core (all plans)

- Desktop app (macOS, Windows, Linux)
- **Unlimited** local agent, jobs, mini-apps, plans, tools
- BYOK, OAuth (ChatGPT/Claude), Ollama
- Local scheduled jobs when Mac is on (no run meter)
- **Local data budget** — default 10 GB, user-adjustable in Settings (§3.6); not tier-gated

### 6.2 Cloud & infrastructure

| Feature | Free | Cloud | Pro | Team | Business |
|---------|------|-------|-----|------|----------|
| Papr login / workspace | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cloud workspace (git sync) | ✅ Limited* | Full | Full | Full | Full |
| Cloud vault (secrets) | ✅ (10 keys) | ✅ (20) | ✅ (50) | ✅ (100) | ✅ (250) |
| Turso-linked job DBs | 3 | 10 | 25 | 50 | 100 |
| Cloud runs when Mac asleep | ✅ Low cap | ✅ | ✅ | ✅ | ✅ |
| Light runner (script jobs) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Full sandbox (agent in cloud) | ✅ Low cap | ✅ | ✅ | ✅ | ✅ |

\*Free: git sync works; subject to **cloud usage caps** and lower vault/DB limits — not a full “always-on cloud” tier.

### 6.3 Sharing & apps (network effects)

| Feature | Free | Cloud | Pro | Team | Business |
|---------|------|-------|-----|------|----------|
| **Build mini-apps + link to job data** | ✅ Unlimited local | ✅ | ✅ | ✅ | ✅ |
| **Community catalog install** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Share links** (read) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Share links** (read-write) | ✅ Limited* | ✅ | ✅ | ✅ | ✅ |
| Cloud App Host (`apps.papr.ai`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `loginAccess=team` apps | ✅ | ✅ | ✅ | ✅ | ✅ |
| Remove "Built with Papr" badge | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Public apps** (discoverable listing) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Community catalog **publish** | ✅ 1 app* | ✅ | ✅ | ✅ | ✅ |
| Custom app slug | ❌ | ❌ | ✅ | ✅ | ✅ |
| Custom domain (apps) | ❌ | ❌ | ❌ | ❌ | ✅ (TBD) |

\*Free read-write share: capped by **app visits** pool. Free community publish: **1 listed app** to seed network; unlimited local/private shares.

### 6.4 Memory & AI (brain differentiation)

| Feature | Free | Cloud | Pro | Team | Business |
|---------|------|-------|-----|------|----------|
| Cross-device chat / memory sync | ✅ | ✅ | ✅ | ✅ | ✅ |
| Workspace memory (`MEMORY.md`, goals) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Code index / semantic search | ✅ Taste** | ✅ | Full | Full | Full |
| Holographic / advanced memory | ❌ | ❌ | ✅ | ✅ | ✅ |
| Papr proxy models | Taste (cap) | ✅ | ✅ | ✅ | ✅ |
| Priority cloud queue | ❌ | ❌ | ✅ | ✅ | ✅ |

\*\*Free code index: subject to **memories** cap; full feature surface, limited volume.

### 6.5 Collaboration & admin

| Feature | Free | Cloud | Pro | Team | Business |
|---------|------|-------|-----|------|----------|
| Workspace members (invite) | **Up to 3** | **Up to 10** | **Unlimited** | **Unlimited** | **Unlimited** |
| Shared namespace (same usage pool) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Shared team vault | ❌ | ❌ | ❌ | ✅ | ✅ |
| Roles (admin / member / viewer) | Basic | Basic | Basic | ✅ | Advanced |
| Usage breakdown per member | ❌ | ❌ | ❌ | ✅ | ✅ |
| Spend limits & alerts | ✅ ($5 default) | ✅ ($25) | ✅ ($100) | ✅ ($250) | ✅ ($500) |
| SSO / SAML | ❌ | ❌ | ❌ | ❌ | ✅ (TBD) |
| Priority / dedicated support | ❌ | ❌ | ✅ | ✅ | ✅ |

---

## 7. Pricing page copy (draft)

### Free — $0

**Try everything locally, with limited free cloud.**

- **Unlimited local** — jobs, mini-apps, agent (BYOK / OAuth / Ollama)
- **Limited cloud** — **150** runs · **10** agent jobs · **2,000** memories · **5,000** app visits · **250 MB** cloud data · **150** agent turns / month
- **Up to 3** workspace members · Community install · Share apps via link
- **Optional overage** — same rates as paid; default **$5** spend limit

### Cloud — $20/mo

Your automations keep running when your Mac is off.

- **2,000** cloud runs · **50** agent jobs · **5,000** memories
- **25,000** app visits · **1 GB** cloud data · **750** agent turns / month
- **Up to 10** workspace members · Team share links
- **Optional overage** — default **$25** spend limit

### Pro — $100/mo

Publish apps and build every day.

- **10,000** cloud runs · **250** agent jobs · **25,000** memories
- **150,000** app visits · **10 GB** stored data · **4,000** agent turns / month
- **Unlimited** workspace members · Public apps · Community publish · Priority queue

### Team — $200/mo

Bigger shared allowance + governance (not more seats).

- **40,000** cloud runs · **1,000** agent jobs · **100,000** memories
- **500,000** app visits · **50 GB** stored data · **10,000** agent turns / month
- **Unlimited** workspace members · Shared vault · Admin roles · Per-member usage

### Business — $500/mo

High volume and enterprise controls.

- **200,000** cloud runs · **5,000** agent jobs · **500,000** memories
- **2M** app visits · **250 GB** stored data · **30,000** agent turns / month
- **Unlimited** workspace members · SSO (TBD) · Dedicated support

**Footnote (all tiers):** Unlimited **local** runs while your Mac is on (all plans). Every plan includes usage buckets **plus optional overage** at the same unit rates — set a monthly spending limit anytime.

---

## 8. Usage dashboard (Settings UI)

```
This month (resets [date])

Cloud runs      ████░░░░░░  312 / 2,000
Agent jobs      ██░░░░░░░░  8 / 50
Memories        █░░░░░░░░░  420 / 5,000
App visits      ██░░░░░░░░  4,200 / 25,000
Stored data     ██░░░░░░░░  240 MB / 1 GB (cloud)
Agent turns     ███░░░░░░░  180 / 750

Local runs: unlimited while your Mac is on
Local data: 4.2 GB / 10 GB budget [Adjust]
Extra usage: $0.00 · Spending limit: $25 [Change]
```

---

## 9. Competitive positioning

### vs n8n (migration / comparison page)

| | n8n Starter ~$20 | Papr Cloud $20 |
|--|------------------|----------------|
| Simple scheduled runs | ~2,500 executions | **2,000** cloud runs |
| Multi-step fairness | 1 execution = whole workflow | 1 cloud run = whole job |
| Agent in cloud | + separate AI subscription | **50** agent jobs + unlimited local BYOK |
| Dashboard | Another tool | Mini-apps included |
| Memory / company brain | ❌ | **5,000** memories |
| Local execution | ❌ | **Unlimited** (Mac on) |

**Honest caveat:** Simple webhook-only flows at very high frequency may stay cheaper on n8n. Papr wins on **agent + data + app + memory** in one run.

### vs Replit Core ~$20

| | Replit Core | Papr Cloud |
|--|-------------|------------|
| Wallet | $25 opaque credits | Labeled buckets |
| Agent | Effort-based checkpoints ($0.06–$几) | Unlimited local BYOK + 750 Papr turns |
| Collaborators | 5 | **10** (Cloud) / **Unlimited** (Pro+) |
| Jobs / cron | Scheduled deployments | First-class jobs + local free |
| Where it runs | Browser/cloud IDE | **Desktop + cloud when asleep** |

---

## 10. Stripe / memory-server meters (implementation sketch)

Align with `docs/PAPR_CLOUD_RUNTIME_PLAN.md` §12.

| Stripe meter | Maps to |
|--------------|---------|
| `papr_cloud_runs` | Script job cloud executions |
| `papr_agent_jobs` | Agent/subagent cloud executions |
| `papr_memories` | Memory storage / indexing units |
| `papr_app_visits` | Cloud App Host requests (cached-adjusted) |
| `papr_storage_gb` | Turso + synced data GB-month |
| `papr_agent_turns` | Existing `papr_mini` / `papr_premium` interactions (or split) |

**Job routing for billing:**

| `job.type` | Cloud meters |
|------------|--------------|
| `python`, `bash`, `shell`, `node` | +1 cloud run |
| `agent`, `subagent` | +1 cloud run, +1 agent job |

Local execution (desktop gateway, Mac awake): **no meter increment**.

---

## 11. Open questions for team review

| # | Question | Options / recommendation |
|---|----------|-------------------------|
| 1 | Free community publish: **1 listed app** or unlimited private only? | **1 listed** — seeds catalog without spam |
| 2 | Agent-turn overage pricing | **$25/1k** — above COGS (§4.4) |
| 3 | Cloud storage: **1 GB** or **2 GB** at $20? | 2 GB reduces friction; +$0.50 COGS |
| 4 | Agent job consumes **both** meters? | **Yes** — COGS clarity |
| 5 | Commercial builds (`REQUIRE_PAPR_AUTH`) — same Free caps? | **Yes** — same PLG story |
| 6 | Custom domain / SSO timing | TBD |
| 7 | Validate unit costs with 30-day production telemetry before launch | Engineering |
| 8 | Member cap enforcement: block invite vs read-only overflow? | **Block** at cap with upgrade CTA |
| 9 | Ship soft limits first, billing second? | Product decision |
| 10 | Cap local runs on Free? | **No** — unlimited local all plans (§3.5) |
| 11 | Default local data budget (10 GB)? | User-adjustable; not tier-gated (§3.6) |

---

## 12. Related docs

- `docs/PAPR_CLOUD_RUNTIME_PLAN.md` — Cloud infrastructure, sandbox model, draft meters
- `docs/AUTH_WALL_IMPLEMENTATION.md` — Commercial auth gate
- `src/gateway/services/appRuntime/dbRequestGuard.ts` — App visit / DB abuse guardrails

---

## 13. Revision history

| Version | Date | Changes |
|---------|------|---------|
| v1 | 2026-07-16 | Initial draft from pricing strategy sessions |
| v2 | 2026-07-16 | Network-effects principles; cost alignment (§4); generous Free for differentiation; unlimited teammates all plans |
| v3 | 2026-07-16 | Free = limited cloud + local unlimited; member caps 3 / 10 / unlimited; §3.4 local vs cloud split |
| v4 | 2026-07-16 | Overage on all plans (Free $5 default limit); §3.5 local limits options; agent turns $25/1k |
| v4.1 | 2026-07-16 | §3.5 Option D — 2,000 local runs/mo on Free; unlimited local on Cloud+ |
| v5 | 2026-07-16 | **Decided:** unlimited local all plans; caps = cloud/memory/cloud storage/members; §3.5 closed |
| v5.1 | 2026-07-16 | Local device storage = user budget (default 10 GB), not plan cap; §3.6 |
