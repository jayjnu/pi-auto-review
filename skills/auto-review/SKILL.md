---
name: auto-review
description: Review and fix code changes queued by pi-auto-review. Use when invoked by /skill:auto-review after an agent turn changes files.
---

# Auto Review

Use this workflow when `pi-auto-review` asks you to review recent code changes.

## Required Flow

1. First, call the `subagent` tool with agent `reviewer` to review the current changes.
2. Wait for the reviewer result.
3. Before the reviewer result returns, do not edit, write, or otherwise mutate files. Use read-only inspection only.
4. If the reviewer reports Critical or Warnings, apply concrete fixes now in the main session.
5. Do not auto-fix Suggestions unless they are safe, local, and aligned with the original request.
6. If there are no Critical or Warning findings, summarize the clean review and do not edit files.

## Context Rules

- You are the main Pi agent, so use the current chat context and project instructions while orchestrating review/fix.
- The reviewer subagent provides isolated review context; fixes are applied by you in this main session after reviewer results return.
- If relevant skills are available, read and follow them, and report which skills you used.
- Report concrete findings with file paths and line numbers when possible.

## Output Format

```markdown
## Skills Used
## Summary
## Critical
## Warnings
## Suggestions
## Files Reviewed
```
