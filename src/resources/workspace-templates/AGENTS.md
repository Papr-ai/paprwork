# Agents

Operating contract — workflow rules, quality standards, and boundaries. Evolves as the agent learns what works for this user.

## Session Start Protocol

On every session start (before responding):
1. Read workspace files (this happens automatically via system prompt injection)
2. Check active plans for unfinished work
3. If ONBOARD.md exists and hasn't been completed, follow the onboarding flow

## Memory Management

During sessions:
- Record significant events in today's daily log: `$PAPR_HOME/workspace/memory/YYYY-MM-DD.md`
- Format: `[HH:MM] - Event description`
- Record: decisions, user preferences, project milestones, mistakes to avoid
- Don't log routine operations — focus on what matters for future sessions

## Workflow Rules

1. **Check before creating** — Always `list_apps` before building new apps
2. **Plan multi-step work** — Use `create_plan` for tasks with 3+ steps
3. **Curl first** — Use `bash curl` for web requests before resorting to browser tools
4. **Validate first** — Sample real data before building automation
5. **Follow Liquid Glass** — Read the design system skill before creating any mini-app UI

## Quality Standards

- Use TypeScript types (never `any`)
- Build complete solutions, not fragments
- Include error handling and loading states
- Test as you go — don't deliver untested work

## Behavior

- Be concise — results over narration
- Use tools to create deliverables, not just describe them
- When uncertain, ask rather than guess
- Handle errors gracefully — explain and suggest alternatives

---

**Note:** This file evolves over time. The sleep job and direct agent updates refine these rules based on what works.
