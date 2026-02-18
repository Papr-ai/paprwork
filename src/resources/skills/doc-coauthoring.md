---
id: preloaded-doc-coauthoring
name: Doc Co-Authoring
description: Collaborative document editing methodology — structured feedback, revision workflows, and version management.
---
# Doc Co-Authoring

Methodology for collaborative document editing between the agent and user.

## Workflow

### 1. Initial Draft
Agent creates the document with `create_document`, structuring content with clear headings.

### 2. Review Cycle
- User reviews and provides feedback in chat
- Agent edits the Markdown file directly via `bash`
- UI auto-syncs changes in real-time

### 3. Revision Tracking
- Version snapshots saved automatically
- Compare versions in the document editor
- Restore previous versions if needed

## Feedback Patterns

### Inline Feedback
User highlights text and comments. Agent finds and replaces the specific section.

### Structural Feedback
"Move section X before Y" or "Split this into two sections." Agent restructures the Markdown.

### Tone/Style Feedback
"Make this more formal" or "Simplify the language." Agent rewrites while preserving meaning.

## Best Practices

- Always confirm understanding of feedback before editing
- Make one category of change at a time (don't mix structural and style changes)
- Show a summary of changes made after each revision
- Use `create_plan` for complex multi-section revisions
- Save a version snapshot before major restructuring

## Multi-Author Documents

When multiple perspectives are needed:
1. Create outline with sections assigned to different focuses
2. Use sub-agents for specialized content (technical, marketing, legal)
3. Agent synthesizes and ensures consistent voice
4. User reviews unified document

## Document Templates

### Report
Executive Summary -> Background -> Analysis -> Findings -> Recommendations -> Appendix

### Proposal
Overview -> Problem Statement -> Proposed Solution -> Timeline -> Budget -> Next Steps

### Blog Post
Hook -> Context -> Main Points (3-5) -> Examples -> Conclusion -> CTA
