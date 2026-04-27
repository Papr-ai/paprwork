# Actual Context Token Tracking - Quick Ref

## What Changed
✅ Summarization now uses **actual context tokens** (including overhead) instead of just message tokens

## Old vs New

| Old | New |
|-----|-----|
| Checked: DB message tokens | Checked: Actual LLM context |
| Threshold: 50K | Threshold: 60K |
| Blind to overhead | Sees system prompts, tools, attachments |

## Why
- DB token count = 14K (messages only)
- Real context = 102K (messages + 88K overhead)
- Old logic would never trigger summarization

## Overhead Sources
- System prompts/rules
- Tool definitions (MCP, papr)
- Attached files, git status
- Open files metadata
- Agent transcripts, MCP servers

## Log Output Now
```
[AgentService] 📊 Chat stats after stream:
  Messages in DB: 581, has_summary: true
  Message tokens (DB): 14052        ← Historical messages
  Actual context tokens: 102000     ← What LLM sees
  Context overhead: 87948 tokens    ← Difference
```

## Benefits
1. Accurate pressure monitoring
2. Summarize at right time
3. Prevent context overflow
4. Visibility into overhead

## File
`src/gateway/services/AgentService.ts:1356-1382`
