---
id: preloaded-summarize-content
name: Summarize Content
description: Create concise summaries of documents, articles, transcripts, and any long-form content.
---
# Summarize Content

Create concise, accurate summaries of long-form content.

## Summary Types

### 1. Executive Summary (2-3 paragraphs)
Main point, key findings, conclusion. For quick high-level understanding.

### 2. Detailed Summary (1-2 pages)
Introduction, main sections, key arguments, conclusion. Thorough understanding without reading full text.

### 3. Bullet Point Summary (5-10 bullets)
One bullet per major idea. For rapid information extraction.

### 4. Meeting Summary (Action-Oriented)
```
## Meeting Summary - [Date]
**Attendees**: [Names]
### Topics Discussed
### Decisions Made
### Action Items
- [ ] [Task] - @assignee - [deadline]
### Next Meeting
```

### 5. Research Summary (Academic)
```
## Research Summary
**Study**: [Title]
**Authors**: [Names]
### Objective
### Methodology
### Key Findings
### Implications
```

## Process

1. **Read fully** - Understand the entire context before summarizing
2. **Extract structure** - Main sections, key arguments, supporting points
3. **Create hierarchy** - Main idea -> Supporting points -> Details -> Conclusion
4. **Write summary** - Start with main idea, add points by importance
5. **Review** - Does it capture the essence? Is it accurate and clear?

## Best Practices

- Read first, then summarize (don't summarize as you read)
- Focus on main arguments, evidence, and conclusions
- Skip examples unless crucial
- Maintain objectivity - don't add opinions unless analyzing
- Use author's language and framing
- Scale to needs - ask "How long should this be?"

## Special Cases

### Transcripts
Include: discussion topics, decisions made, action items, key quotes.

### Technical Documents
Include: purpose, tech stack, architecture, key components, requirements.

### Books/Long Documents
Include: main thesis, key chapters summarized, major takeaways, practical applications.

## Integration with Paprwork

- Summarize open documents with `read_document` then create summary
- Summarize meeting transcripts automatically
- Create summary documents with `create_document`
- Save summaries to Papr Memory for future reference

## Quality Checklist

- [ ] Captures main idea accurately
- [ ] Includes all key points
- [ ] Maintains logical structure
- [ ] Uses clear, concise language
- [ ] Appropriate length for use case
- [ ] Original meaning preserved
- [ ] Actionable if action-oriented
