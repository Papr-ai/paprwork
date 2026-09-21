# App Card Guide

**An App Card is the operational fact sheet for a mini-app, written as `docs/APP_CARD.md` inside the app folder and indexed into Papr Memory one section at a time.**

Write one for every app you build. Update it whenever storage, schema, jobs, or known breakages change. It takes two minutes and it is the difference between a future agent answering "where do transcripts live?" in one search versus re-deriving it from six greps.

---

## Why this exists

Semantic search over mini-app **source code** does not answer operational questions. Code chunks retrieve on syntax, not on meaning: a query like *"which database does Meetings Manager write to"* pulls back the SQL string that happens to share tokens, not the fact that the app writes to `db-4f2a…` alias `meetings`. The answer exists only as an inference across `data-sources.json`, a job script, and a migration file — and nobody indexed the inference.

The card **is** the inference, written down once, in prose, at the grain a question arrives in.

This is also what makes excluding `code_indexer` output from default search safe. Without a card, excluding code leaves a hole. With a card, the hole is filled by something better.

---

## Relationship to wiki entity pages — complement, never replace

There are two documents about every significant app. They do not overlap and they must not be merged.

| | `workspace/entities/apps/{slug}.md` (Wiki Writer) | `apps/{appId}/docs/APP_CARD.md` (you) |
|---|---|---|
| **Owns** | Narrative, timeline, why it exists, who uses it, how it relates to people/projects/goals | Operational fact: storage, schema, jobs, gotchas |
| **Written by** | Wiki Writer agent, daily after Sleep | The agent that builds or modifies the app — you |
| **Changes when** | The story changes | The plumbing changes |
| **Lives with** | The workspace | The app source — versions with code, ships in the bundle, syncs to the per-app repo |
| **Answers** | "What is this and why do we have it?" | "Which table, which job, what will bite me?" |

**Rule:** never restate storage or schema detail in the wiki page, and never write project narrative or goal traceability into the card. If you find yourself copying between them, you have put something in the wrong file. Two docs describing the same fact will drift; two docs describing different facts will not.

The wiki page may *link* to the card. The card never links to goals.

---

## Location and front matter

```
apps/{appId}/docs/APP_CARD.md
```

In the app's own source folder — it versions with the code, ships in `export_app_bundle`, syncs to the per-app GitHub repo, and is readable with `read_app_file({ appId, filename: "docs/APP_CARD.md" })`. `.md` files are exempt from the 100-line mini-app limit, so one file is fine.

Start every card with machine-readable front matter so the indexer never guesses which app a file belongs to:

```markdown
<!-- papr:app-card v1
app_id: 6e432b37-6cf2-45f1-9ad8-ec70a56d4a3c
app_name: Meetings Manager
-->
```

---

## The five fixed sections

Each `##` heading becomes **one memory**. That is the unit of retrieval, so the sections match how questions actually arrive. Use these five, in this order, with these exact names. Do not invent sections — the indexer and the filters depend on the fixed set.

| Section | Answers | Target length |
|---|---|---|
| `## Overview` | What is this app, what does it do, which jobs does it own | 400–800 chars |
| `## Storage` | Where the data lives — registry `dbId`, alias, local path, Turso mode | 400–1,000 chars |
| `## Schema` | Tables and columns, what each column actually holds | 400–1,000 chars |
| `## Jobs` | The pipeline — who writes what, in what order, on what trigger | 400–1,000 chars |
| `## Gotchas` | Known breakages, footguns, things that will surprise the next agent | 400–1,000 chars |

`Storage` and `Gotchas` carry most of the value. They are the things nobody writes down and everybody re-derives by grep.

**Gotchas cannot be generated from source.** It is the one section that comes from what broke. Every time you debug something non-obvious in an app — a silent truncation, an alias that is not what it looks like, a job that must run before another — add a line. If you fixed a bug and did not touch Gotchas, you threw away the only durable artifact of the debugging.

---

## Writing the card

Prose, not bullets-of-fragments. Each section must stand alone: a retrieved chunk arrives with no surrounding document, so name the app and the thing inside the text itself. Prefer concrete identifiers (`db-e782019f`, `alias curation`, `anchor_candidate`) over descriptions of identifiers ("the main database").

Bad — unresolvable out of context:

> Stores results in the main table. Written by the nightly job.

Good — self-contained:

> Curation Bench reads and writes registry database `db-e782019f` (alias `curation`, per-user isolation off). Rows land in `anchor_candidate`; the `nl_reviewed` flag gates whether a row is eligible for scoring.

---

## Indexing contract

Each section is written to memory as its own item, with a breadcrumb prefix in the content (`Meetings Manager — Storage`) so a bare chunk says what it belongs to.

`add_agent_memory` supports this directly — use it, do not POST to the API by hand:

```javascript
add_agent_memory({
  content: "Meetings Manager — Storage\n\nMeetings Manager reads and writes …",
  category: "fact",
  role: "assistant",
  topics: ["app:Meetings Manager", "app-card", "storage"],
  hierarchicalStructures: "apps/Meetings Manager/Storage",
  customMetadata: {
    content_type: "app_card",
    source: "app_card_indexer",
    app_id: "6e432b37-6cf2-45f1-9ad8-ec70a56d4a3c",
    app_name: "Meetings Manager",
    section: "Storage",
    section_sha: "9f2c1ab4",       // sha256 of section body, first 8 hex
    card_version: "v1"
  }
})
```

`customMetadata` accepts `string | number | boolean | string[]` only — nested objects are rejected by the API.

**Read side — narrow before you search:**

```javascript
search_agent_memory({
  query: "where are meeting transcripts stored and which table holds them",
  customMetadataFilters: { content_type: "app_card", app_id: "6e432b37-…" }
})
```

Drop `app_id` to ask across all apps ("which app writes to Turso?"); keep it when the app is known. `source: app_card_indexer` exists so this channel can be bulk-corrected or bulk-deleted later without touching any other memory.

**`customMetadataFilters` is a strong bias, not a hard WHERE clause.** Measured: filtering on `content_type: "app_card"` still returned one item with no `content_type` at all. Filtering reliably promotes cards to the top — in an A/B on "which database does Curation Bench write to, and why does the loader fail with database is locked", unfiltered put an incident note first and an unrelated source file fourth, while filtered returned `Storage` at rank 1 and `Gotchas` at rank 2 — but do not assume every hit satisfies the filter. Check `hit.customMetadata` before trusting a result as a card.

**Response-shape gotcha (costs an afternoon if you miss it):** on **write**, `customMetadata` nests under `metadata`. On **search results**, it comes back **top-level on the memory object**, and `metadata` is an empty `{}`. An indexer that reads `hit.metadata.customMetadata` finds nothing, concludes the memory is absent, and adds a duplicate every run. Read `hit.customMetadata ?? hit.metadata?.customMetadata`.

**Idempotency:** `section_sha` is how a re-run avoids duplicates. Search for the existing memory by `{ app_id, section }`; if `section_sha` matches, skip; if it differs, call `update_memory` with the new content — do **not** add a second item. Duplicate near-identical memories degrade ranking for everything else in the workspace.

---

## When to write or update the card

| Trigger | Sections to touch |
|---|---|
| `create_app` — new mini-app | All five (Gotchas may start as "none known yet") |
| Added/changed a registry database or alias | `Storage` |
| Ran a migration, added a column | `Schema` |
| Created, renamed, re-scheduled, or chained a job | `Jobs`, `Overview` |
| Debugged something non-obvious | `Gotchas` — always |
| Renamed the app or changed what it is for | `Overview` |

Writing the file is not enough on its own — the card must reach memory. Either run the `app-card-indexer` job, or call `add_agent_memory` per changed section inline. Inline is fine and usually faster for a one-section edit.

Rewriting several sections at once? Use `add_agent_memory_batch` — each item takes its own `customMetadata`, so pass the same `content_type` / `app_id` / `section` keys you would have passed per call. One request, same filterability.

---

## Do not card everything

Most workspaces have far more apps than are worth documenting. A stale card is worse than no card, because it will be retrieved and believed.

1. **Tier 1 — hand-written.** Load-bearing apps with real data and real questions. Write these yourself, carefully.
2. **Tier 2 — generated, then reviewed.** Draft `Overview`/`Storage`/`Schema`/`Jobs` from source, then *read them*. Leave `Gotchas` empty rather than inventing it.
3. **Tier 3 — skip.** One-off, experimental, and demo apps. No card.

If you cannot name a question a future agent would ask about the app, it is Tier 3.

---

## Template

```markdown
<!-- papr:app-card v1
app_id: {appId}
app_name: {App Name}
-->

# {App Name} — App Card

## Overview
{What it does, who it is for, which jobs it owns. Name the app in the first sentence.}

## Storage
{Registry dbId + alias + isolation. Local path. Turso sync mode. Any App Files or external stores.}

## Schema
{Tables and the columns that matter, with what each column actually holds — not just its type.}

## Jobs
{Each job: id, trigger (schedule/button/dependsOn), what it writes, ordering constraints.}

## Gotchas
{What broke, what is surprising, what the next agent will get wrong. "None known yet" is a valid start.}
```
