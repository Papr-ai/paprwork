---
id: preloaded-goal-page-design
name: Goal Page Design
description: How to design a goal / progress page (Focus goal detail, OKR pages, tracker dashboards). Visual first like Apple Photos and Fitness. One payoff number, one chart of progress over time, real faces and logos, the evidence as tiles. Includes the tracker data contract and research sources.
---
# Goal Page Design

Load this before building or changing any page that shows progress on a goal: the Focus goal detail in Home, an OKR mini-app, or a tracker job's output. Use it together with `preloaded-paprwork-design-system` (layout, glass) and the Papr brand guidelines (one blue accent).

Reference implementation: `src/resources/default-apps/home-dashboard/three_hero.js` + `three_hero.css`.
Data comes from tracker jobs: `POST /api/workspace/focus/metrics` (`src/gateway/services/focusTrackers.ts`, `GOAL_PAGE_CONTRACT`).

## The one job

A goal page answers one question: **is the time I'm putting into this goal paying off?**

Everything above the task list exists to answer it in under 2 seconds. Anything that doesn't is deleted or put behind one tap.

## The summary, top to bottom (max 4 blocks)

1. **One payoff number**, big (40–44px, tabular figures). Use the result, not the effort: views, MRR, meetings booked, signups. Add a ↑/↓ % against last week **only once there is a real week of history**. Never fake a trend.
2. **Faces.** Show the real profile picture of whoever the numbers belong to. Each picture carries its platform's logo as a small badge (X, LinkedIn, Stripe…). A source that's broken shows greyed out with a "!" and opens a fix-it chat on tap. It shouldn't be a red error paragraph.
3. **Effort → result in one line.** "8.8h in chats → 10 posts · 21 engagements". This is the return on time, the reason Focus exists.
4. **One chart: progress over time.** Bars on a shared baseline, last 7 days, with a dashed target line. A full accent bar means the target was hit, a soft bar means partly, a dot means not at all. The caption states the takeaway ("4 of 7 days showed up"). No axes, gridlines, legends or tooltips that the caption could replace. When there's no per-day evidence, chart the daily history snapshots of the payoff number instead.
5. **The evidence as tiles**, like Apple Photos: the 3 posts / deals / people that did the most. Each tile has a logo or picture, two lines of text and one number. Tiles link to the real thing. Below 520px they become a horizontal snap-scroll row.

Then: "Why this goal" collapsed behind one tap, then Next milestone, then **Moves it** (tasks), then one primary action, **Work on it with Pen**.

Goals with no tracker get the same layout, reduced: hours in chats this week as the big number, chats and open tasks as the one-liner, and the one-tap "Track this" card.

## Real images, never invented

| Need | Source |
|---|---|
| Company / platform logo | `https://www.google.com/s2/favicons?domain=<domain>&sz=64` (any domain → its logo) |
| Domain for a company you only know by name | web search / Exa → official site → domain |
| Person on X | profile_image_url from the X API (`_normal` → `_400x400`), fallback `https://unavatar.io/x/<handle>` |
| Person on LinkedIn | `/voyager/api/me` miniProfile picture (largest artifact) |
| Contact on this Mac | Contacts photo if the user has granted access |

Always `https`, `loading="lazy"`, `referrerpolicy="no-referrer"`, and `onerror` that removes the image so initials show instead. Never generate, guess or use stock faces for real people or brands.

## Brand and visual rules

- One accent: Papr blue `#0161E0` light / `#0080FF` dark. Cyan is for the logo only.
- Green and red appear only for up/down status (the delta, a broken source).
- Borders barely there (`--line`). Radius 20px for the hero, 14px for tiles. No shadows on the chart.
- Check light and dark mode at 390px and 1440px. Tap targets ≥ 44px. Visible focus rings.

## Copy (conversation design)

- Say the takeaway, not the metric name: "4 of 7 days showed up", not "Posting frequency".
- Plain words, sentence case, no jargon ("engagements", not "Reactions, replies, reposts").
- Errors are one human sentence plus one fix action.
- The primary button opens chat with a prefilled message that already carries the goal, the target, the due date and the next milestone, so the user never has to restate context.

## Tracker data contract (what makes the page possible)

Tracker jobs POST to `/api/workspace/focus/metrics`:

```json
{
  "goalId": "…",
  "summary": { "impressions7": 86872, "posts7": 10, "engagement7": 21 },
  "sources": { "x": { "ok": true, "profile": { "handle": "…", "name": "…", "avatar": "https://…", "url": "https://…", "followers": 394 } } },
  "items": [ { "source": "x", "kind": "post", "url": "https://…", "text": "≤140 chars", "at": "ISO time",
               "impressions": 42468, "engagement": 11, "image": "https://… (optional)", "domain": "stripe.com (optional)" } ]
}
```

- Put the payoff number first in `summary` (or set `hero` on a built-in template). The gateway snapshots `summary` daily into `history` (90 days), and that history becomes the trend chart.
- `items[].at` drives the 7-day chart. `image` / `domain` give each tile a face.
- Use `null` for a number you couldn't read. Never invent values.

## Checklist

- [ ] Payoff number readable in under 2s, effort → result line under it
- [ ] Real face or logo for every source and tile; initials fallback works offline
- [ ] One chart, shared baseline, target line, caption states the takeaway
- [ ] ≤ 4 blocks above "Moves it"; "Why" is collapsed
- [ ] No fake trends: delta hidden until 7 days of history exist
- [ ] Light and dark, 390px and 1440px, keyboard focus visible

## Why (sources)

- **Bars on one baseline, not pies or gauges.** People judge position along a common scale most accurately. Cleveland, W. S., & McGill, R. (1984). *Graphical Perception.* Journal of the American Statistical Association, 79(387), 531–554.
- **Delete chart chrome.** Maximise the data-ink ratio. Tufte, E. R. (2001). *The Visual Display of Quantitative Information* (2nd ed.). Graphics Press.
- **Headline value + trend + detail on demand** is the recurring pattern in effective dashboards. Bach, B., et al. (2023). *Dashboard Design Patterns.* IEEE TVCG, 29(1), 342–352 (IEEE VIS 2022).
- **Weekly glanceable view (Apple Fitness style).** Glanceable feedback on trackers increases how often people check in and act. Gouveia, R., Pereira, F., Karapanos, E., Munson, S., & Hassenzahl, M. (2016). *Exploring the Design Space of Glanceable Feedback for Physical Activity Trackers.* UbiComp '16.
- **Show progress, not just tasks.** Seeing progress in meaningful work is the strongest day-to-day motivator. Amabile, T. M., & Kramer, S. J. (2011). *The Progress Principle.* Harvard Business Review Press.
- **The dashed target line.** Effort rises as people see themselves closer to a goal. Kivetz, R., Urminsky, O., & Zheng, Y. (2006). *The Goal-Gradient Hypothesis Resurrected.* Journal of Marketing Research, 43(1), 39–58.
- **"4 of 7 days", not a fragile streak.** Missing a single day did not materially hurt habit formation, so don't punish it with a streak reset to 0. Lally, P., van Jaarsveld, C. H. M., Potts, H. W. W., & Wardle, J. (2010). *How are habits formed.* European Journal of Social Psychology, 40(6), 998–1009.
- **Max ~4 blocks.** Working memory holds about four chunks. Cowan, N. (2001). *The magical number 4 in short-term memory.* Behavioral and Brain Sciences, 24(1), 87–114.
- **Real faces.** Faces capture attention automatically, so a real profile picture makes "whose numbers are these" instant. Theeuwes, J., & Van der Stigchel, S. (2006). *Faces capture attention: Evidence from inhibition of return.* Visual Cognition, 13(6), 657–665.
- **Why behind one tap.** Nielsen, J. (2006). *Progressive Disclosure.* Nielsen Norman Group.
- **Recognition over recall** (logos, not platform names). Nielsen, J. (1994). *10 Usability Heuristics for User Interface Design.* Nielsen Norman Group.
- **Copy: say only what's needed and relevant.** Grice, H. P. (1975). *Logic and Conversation* (maxims of quantity and relevance). Google, *Conversation Design* guidelines: carry context forward so the user never repeats themselves.
- **Charts state their point.** Apple, *Human Interface Guidelines: Charts*: keep charts simple and lead with the key takeaway.
