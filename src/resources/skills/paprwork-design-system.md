---
id: preloaded-paprwork-design-system
name: Paprwork Design System
description: Complete design system for Paprwork mini-apps — Liquid Glass visual identity, layout/typography/color foundations, component architecture, and implementation best practices.
---
# Paprwork Design System

The unified design system for building Paprwork mini-apps. Combines Liquid Glass visual identity with solid design foundations and modern frontend implementation patterns.

## Philosophy

Design mini-apps that feel inevitable: one core job, one obvious next action, premium "Liquid Glass" fit & finish, and ruthless simplification.

Blends:
- **Steve Jobs**: simplicity, taste, no manual required.
- **Elon Musk**: first-principles, question assumptions, optimize for speed and throughput.
- **Apple Liquid Glass**: translucent surfaces, subtle depth, sharp typography, consistent system.

## Non-negotiables

- One primary job per app screen. Okay to have multiple tabs.
- One primary action per screen.
- Progressive disclosure for everything else.
- No friction onboarding: get the user to the first success fast.
- Measure success with 1-2 metrics.
- **No emojis** in UI text, labels, buttons, headings, or tab icons — use SVG icons and plain text only (`validate_app` enforces `no-emojis`).

---

## Layer 1: Visual Foundations

### Visual Hierarchy
1. **Size** — larger elements draw attention first
2. **Color** — contrast guides the eye
3. **Position** — top-left is scanned first (F-pattern)
4. **Whitespace** — breathing room around important elements

### Grid System
- 12-column grid for flexibility
- Consistent gutters (16-24px)
- Max content width: 1200-1440px
- Responsive breakpoints: 640px, 768px, 1024px, 1280px

### Typography
- 2 fonts maximum — system fonts preferred for performance
- System stack: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", system-ui, sans-serif`

| Level | Size | Use |
|-------|------|-----|
| H1 | 36-48px | Page title |
| H2 | 28-36px | Section title |
| H3 | 22-28px | Subsection |
| Body | 15-18px | Primary content |
| Small | 13-14px | Secondary text |
| Caption | 12px | Labels, metadata |

- Body line height: 1.5-1.7
- Minimum body size: 15px; supporting text >= 12-13px

### Color System
- **Primary**: Brand (`#0161E0`) for CTAs and links
- **Secondary**: Accent (`#4f46e5`) for supporting emphasis
- **Neutral**: Grays for text, borders, backgrounds
- **Semantic**: Success (green), Warning (amber), Error (red), Info (blue)

### Contrast (WCAG AA)
- Body text: minimum 4.5:1 contrast ratio
- Large text (18px+): minimum 3:1
- Muted text must still pass readability
- Glass restraint: blur + border are subtle; avoid heavy gradients

### Spacing Scale (4px base)
`4, 8, 12, 16, 24, 32, 48, 64, 96`

---

## Layer 2: Liquid Glass Identity

### Principles

**1) Focus beats features**
Remove features until removing one more would break the core outcome.

**2) Start with the user's outcome (JTBD)**
Design is an outcome delivery system. Capture: persona, context, job-to-be-done, motivation, outcome, success metric.

**3) First principles + 5 Whys**
Before UI decisions, find root cause. Ask "why" five times.

**4) Premium simplicity**
Translucent surfaces, subtle borders, controlled shadows. Interactions feel calm: 150-250ms transitions; immediate feedback.

### Design Process

**Step 0 — Design Brief**
```
* App name:
* Primary persona:
* Job-to-be-done: "When ___, I want to ___, so I can ___."
* Primary outcome:
* Success metric(s): (1-2)
* Non-goals:
* Primary screen CTA: (single verb)
```

**Step 1 — Choose the "one use-case"**
Write: User -> action -> outcome.
Example: "Creator -> sees one hot post -> publishes a reply in <60 seconds."

**Step 2 — Shortest path to first success**
If it takes more than 3 steps to first success, redesign.

**Step 3 — Layout & hierarchy**
Put the primary action in the most reachable, visually dominant place. Everything else goes behind progressive disclosure.

**Step 4 — Build with design tokens**
Use the token system below. Build from primitives (Button, Card, Header, Modal, Nav).

**Step 5 — Simplification loop (3 passes)**
- Pass 1: Remove (delete non-essential features)
- Pass 2: Merge (combine steps, inline states)
- Pass 3: Clarify (rename labels to match user intent)

Stop when the primary action is obvious in 2 seconds.

### Apple Liquid Glass Guidelines (WWDC 2025)

The "water drop" effect — translucent, not transparent or opaque:
- **Background alpha: 5-20%** white/dark tint on the surface itself
- **backdrop-filter: blur(20px) saturate(180%)** — makes background visible as soft color tint but unreadable
- **Layered glass**: sidebar, content, and panels each add their own tint on top of the base
- **Never fully opaque** — desktop wallpaper should bleed through as subtle color
- **Never fully transparent** — text must remain readable (WCAG AA contrast)

**Opacity ranges by element:**
| Element | Light Mode | Dark Mode | Blur |
|---------|-----------|-----------|------|
| App background gradient | 72-78% | 72-78% | 20px |
| Sidebar | 55% white | 55% black | 20px |
| Content pane | 10% white | 10% black | 8px |
| Glass panel | 65% white | 55% dark | 14-20px |
| Active tab | 88% | 88% | 30px |
| Inactive tab | 65% | 65% | 20px |
| **Popover/Dropdown** | **88% white** | **88% dark** | **40px** |
| **Modal overlay** | **varies** | **varies** | **24px** |

**Popovers & dropdowns** overlay content, so they need stronger glass (88% + blur 40px) to ensure text is fully readable. Add `inset 0 0.5px 0 rgba(255,255,255,0.50)` for the Apple inner-shine edge. Use `border-radius: 14px` for popover containers.

### Design Tokens

```css
:root{
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", system-ui, sans-serif;
  --text-xs: 12px; --text-sm: 13px; --text-md: 15px; --text-lg: 18px; --text-xl: 22px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px; --space-8: 32px;
  --r-sm: 10px; --r-md: 14px; --r-lg: 18px;
  --dur-1: 160ms; --dur-2: 220ms;
  --ease: cubic-bezier(.2,.8,.2,1);
  --accent: #0161E0; --accent-2: #4f46e5;

  /* Light — Liquid Glass */
  --bg: linear-gradient(135deg, rgba(232,234,240,0.78), rgba(255,255,255,0.72), rgba(229,232,240,0.78));
  --bg-2: rgba(249,249,249,0.78);
  --text: #14161a; --muted: #667085;
  --border: rgba(15,23,42,0.10);
  --glass: rgba(255,255,255,0.65); --glass-2: rgba(255,255,255,0.45);
  --glass-border: rgba(15,23,42,0.12);
  --shadow-1: 0 1px 2px rgba(0,0,0,0.06); --shadow-2: 0 10px 30px rgba(0,0,0,0.10);
}

@media (prefers-color-scheme: dark){
  :root{
    --bg: linear-gradient(135deg, rgba(10,12,16,0.78), rgba(20,22,28,0.72), rgba(18,20,26,0.78));
    --bg-2: rgba(28,28,30,0.78);
    --text: rgba(255,255,255,0.92); --muted: rgba(255,255,255,0.55);
    --border: rgba(255,255,255,0.10);
    --glass: rgba(14,18,28,0.55); --glass-2: rgba(14,18,28,0.35);
    --glass-border: rgba(255,255,255,0.12);
    --shadow-1: 0 1px 2px rgba(0,0,0,0.40); --shadow-2: 0 18px 50px rgba(0,0,0,0.55);
  }
}
```

### Component Primitives

**Glass Surface**
```css
.glass{
  background: var(--glass);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-1);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}
```

**App Icon Glass Orb** (used in tabs, favorites, command palette)
```css
.glass-orb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: linear-gradient(135deg, rgba(1,97,224,0.40), rgba(12,205,255,0.30), rgba(0,254,254,0.25));
  border: 0.5px solid rgba(12,205,255,0.30);
  box-shadow: 0 1px 3px rgba(1,97,224,0.20), inset 0 1px 1px rgba(255,255,255,0.35);
  overflow: hidden;
  position: relative;
}
.glass-orb::after {
  content: '';
  position: absolute;
  top: 1px; left: 15%; width: 70%; height: 40%;
  background: linear-gradient(to bottom, rgba(255,255,255,0.45), transparent);
  border-radius: 50%;
  pointer-events: none;
}
.glass-orb__icon {
  width: 10px; height: 10px;
  color: rgba(255,255,255,0.95);
  position: relative; z-index: 1;
}
```

**Action Button (56px min-height, touch-friendly)**
```css
.action{
  display:flex; align-items:center; gap:14px;
  min-height:56px; padding:14px; border-radius:var(--r-lg);
  border:1px solid var(--glass-border); background:var(--glass-2);
  cursor:pointer; text-align:left;
  transition: background var(--dur-1) var(--ease);
}
.action:hover{ background: color-mix(in srgb, var(--glass-2) 94%, transparent); }
```

**Primary Button (Fitts-friendly 44px)**
```css
.btn-primary{
  height:44px; padding:0 16px; border-radius:999px; border:1px solid transparent;
  font-weight:650; font-size:var(--text-md);
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color:white; box-shadow:var(--shadow-1); cursor:pointer;
  transition: transform var(--dur-1) var(--ease), box-shadow var(--dur-1) var(--ease);
}
.btn-primary:hover{ transform:translateY(-1px); box-shadow:var(--shadow-2); }
```

### Patterns Library

| Pattern | Description | Use When |
|---------|-------------|----------|
| **Single-Item Focus Feed** | One item at a time, sticky header, bottom nav for next/previous | Reduces choice overload |
| **Modal Composer** | Original context at top, editor below, one primary CTA | Maintains grounding |
| **Metrics Cards Row** | 3-5 cards max, one highlighted, trend chip | Scannable KPIs |
| **Grid + Sections** | Clear section headers, consistent card style | Content organization |

### Anti-patterns (do not ship)
- "Dashboard soup" (too many modules, no priority)
- Multiple primary buttons competing for attention
- Hidden critical actions behind menus
- Heavy gradients, loud shadows, or decorative motion
- Asking users to configure everything before first success

---

## Layer 3: Implementation

### Component Architecture (Atomic Design)
1. **Atoms**: Buttons, inputs, labels, icons
2. **Molecules**: Search bar (input + button), form field (label + input + error)
3. **Organisms**: Navigation bar, form section, card grid
4. **Templates**: Page layouts with placeholder content
5. **Pages**: Templates with real data

**Rules:**
- Single responsibility (one job per component)
- Props for configuration, not hard-coded values
- Composition over inheritance
- Keep components under 200 lines

### State Management

| Type | Tool | Use For |
|------|------|---------|
| Local | `useState` | UI-only (open/closed, hover, active tab) |
| Shared | Zustand / Context | App state needed by multiple components |
| Server | SWR / React Query | API data with caching and revalidation |
| URL | Search params | Shareable state (filters, search) |

Every query needs loading, error, and empty states.

### Animation
```css
/* Prefer transform + opacity for performance */
.fade-in {
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 200ms ease, transform 200ms ease;
}
.fade-in.visible {
  opacity: 1;
  transform: translateY(0);
}
```

Timing: 150-250ms for UI transitions. Use `var(--dur-1)` and `var(--dur-2)`.

### Performance
- **Code Splitting**: `React.lazy()` for heavy components
- **Virtualization**: `react-window` for lists with 100+ items
- **Images**: `loading="lazy"`, WebP with `<picture>` fallback, responsive `srcset`
- **Fonts**: Preload critical, `font-display: swap`
- **Memoization**: `useMemo` / `useCallback` for expensive computations
- **Target**: Largest Contentful Paint under 2.5s

### Error Handling
- Error boundaries for component tree failures
- Fallback UI for every async operation
- User-friendly messages (not stack traces)
- Retry mechanisms for transient failures

### Accessibility
- Semantic HTML (`nav`, `main`, `article`, `button`)
- Alt text on all images
- Keyboard navigation for all interactions
- Focus management for modals and dialogs
- Skip navigation links
- `aria-live` for dynamic content
- `aria-label` for icon-only buttons
- Color is never the only indicator
- Touch targets >= 44px with 8px minimum spacing

### Responsive Design (Mobile-First)
```css
/* Base: mobile */
.grid { display: flex; flex-direction: column; }

/* Tablet */
@media (min-width: 768px) { .grid { flex-direction: row; } }

/* Desktop */
@media (min-width: 1024px) { .grid { max-width: 1200px; margin: 0 auto; } }
```

---

## Data & `/api/db/*` (required before persistence UI)

Mini-apps that read or write data through `/api/db/query`, `/api/db/write`, or `window.paprAPI.invoke('db.*')` **must have a linked database first**. UI-only apps (static dashboards, calculators, no DB calls) do not need one.

**Before writing any persistence code:**

1. **Create and attach a database**
   - `create_database({ name: "..." })` → `attach_database({ appId, dbId, alias: "billing" })`
   - Jobs that fill the DB: `create_job({ writeDbIds: [dbId], ... })`
2. **Name the DB in app code** — pass `sourceId: alias` on every `/api/db/query` (SELECT) and `/api/db/write` (INSERT/UPDATE/DELETE)
3. **Use the right env in jobs**
   - `PAPR_DB_{ALIAS}` — registry DB paths from `writeDbIds`
   - `$JOB_DB` — job scratch only (`job_runs`, temp ETL), never auto-linked to apps
4. **Then build UI** — query via `/api/db/*`; never hardcode absolute `dbPath` in browser code

**Anti-pattern:** Building tables/views in the mini-app before `data-sources.json` exists → runtime 404 / "no database linked".

---

## Design QA Checklist

- [ ] Dark mode: all text readable on glass
- [ ] Light mode: all text readable
- [ ] No overflow at 1280px, 980px, 640px
- [ ] Tap targets >= 44px
- [ ] Primary action obvious within 2 seconds
- [ ] Loading/empty/error states exist
- [ ] One concept per card
- [ ] Keyboard navigation works
- [ ] Contrast ratios meet WCAG AA
