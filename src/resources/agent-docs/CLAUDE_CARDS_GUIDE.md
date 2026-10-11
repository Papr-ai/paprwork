# Claude cards: make a Papr app usable inside Claude

When a user asks for their app "in Claude" (or "as an MCP app", "in claude.ai"), add a
`claude` block. No rewrite: cards reuse the app's backend actions and `/api/*` calls.
Each **view** becomes one Claude tool (`{slug}_{view}`) that opens one card.

## Steps

1. **Describe actions** in `backend/manifest.json` (all optional, all recommended):
   - `"description"`: short verb phrase, e.g. `"Draft a reply"`. Becomes the button and tool wording.
   - `"effect"`: `read` | `write` (default) | `external`. Anything that sends, posts, pays or
     emails is `external`. Cards always ask for approval before running it.
   - `"runsOn"`: `"mac"` if it needs the user's desktop (browser automation, local files).
   - `"input"`: flat JSON Schema (string/number/integer/boolean/enum). Becomes the form and the tool's arguments.
2. **Opt in** in `metadata.json` (edit the file; Papr keeps the `claude` key on later saves):

```json
"claude": {
  "enabled": true,
  "summary": "One sentence: what this app does for the user.",
  "whenToUse": "the user wants to find leads on LinkedIn or check how their outreach is going",
  "examples": ["help me run LinkedIn outreach", "how many people replied this week?"],
  "views": {
    "status": { "kind": "status", "from": "pipeline-summary" },
    "draft":  { "kind": "action", "action": "draft-message",
                "whenToUse": "the user wants a connection note or DM written for a specific person",
                "examples": ["draft a DM to the head of data at Ramp"] },
    "send":   { "kind": "approval", "action": "send-messages" }
  }
}
```

3. **Run validate_app.** Rule `claude-cards` reports bad config, missing actions,
   oversized or non-self-contained cards. Fix errors before publishing.
4. **Publish** (cloud). Cards build into `dist/cards/` and show up in Claude within a minute.

## Getting picked by Claude (whenToUse + examples)

Claude chooses tools by reading their descriptions on every turn. Papr builds each description
from `whenToUse` and `examples`, and lists the user's apps in the connector instructions.

- **`whenToUse`** (≤280 chars): what the *user* is trying to get done, in plain words.
  Good: "the user wants to log a receipt, check burn, or invoice a client".
  Bad: "Bookkeeping app" (what it *is*), "Use for any finance question" (too broad, **blocks publish**),
  "finance, books, expenses, invoices, tax, cash…" (keyword list, **blocks publish**).
- **`examples`** (2–4, ≤120 chars each): requests in the user's own words, not feature names.
- The app-level `whenToUse` describes the **first** view. Give every other view its own
  `whenToUse`, or Claude can't tell your tools apart. Put the most-asked-for view first.
- Only the first **3** views become Claude tools.
- Too broad is worse than too narrow: an app that pops up uninvited gets the whole Papr connector turned off.

## Picking views (2–3 is right; only the first 3 become tools)

| User need | View |
|---|---|
| "How's it going?" | `status` from an `effect: "read"` action returning a number, object or rows |
| "Do X for me" (safe, inside Papr) | `action` |
| "Send / post / email / pay" | `approval` on an `effect: "external"` action |
| A view the defaults can't show | `{ "entry": "cards/name.ts" }` using `card()` from `/__papr__/papr-card.ts` |

Custom card skeleton (`cards/inbox.ts`, keep under 100 lines):

```ts
import { card } from "/__papr__/papr-card.ts";
card({
  primary: { label: "Send replies", action: "send-replies", effect: "external" },
  async render({ body }) {
    const res = await fetch("/api/db/query", { method: "POST", body: JSON.stringify({ sql: "select count(*) n from replies" }) });
    const { rows } = await res.json();
    body.innerHTML = `<p>${rows[0].n} replies waiting</p>`;
  },
});
```

## Rules

- Never put secrets, API keys or remote `<script src>` in cards. Cards must be self-contained.
- One primary action per card. The kit draws the frame, theme and "Open in Papr".
- Tools only open cards; nothing runs until the user clicks. Don't promise Claude can act silently.
