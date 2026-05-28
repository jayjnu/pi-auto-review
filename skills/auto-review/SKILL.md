---
name: auto-review
description: Review and fix code changes queued by pi-auto-review. Use when invoked by /skill:auto-review after an agent turn changes files.
---

# Auto Review

Use this workflow when `pi-auto-review` asks you to review recent code changes.

## Required Flow

1. Treat the trigger prompt as intentionally minimal. Do not expect changed-file lists or diff details in the prompt.
2. Use read-only inspection to determine the current review target: check `git status --porcelain`, `git diff --no-ext-diff`, `git diff --cached --no-ext-diff`, and recent `HEAD` changes if the worktree is clean.
3. Determine `pi-auto-review` config from `.pi/extensions/auto-review/config.json` and `~/.pi/agent/extensions/auto-review/config.json` when relevant. Defaults are: `reviewerAgent: "reviewer"`, `autoFix: true`, `autoFixSuggestions: false`.
4. First, call the `subagent` tool using the configured reviewer agent to review the current changes.
5. Wait for the reviewer result.
6. Before the reviewer result returns, do not edit, write, or otherwise mutate files. Use read-only inspection only.
7. If fixes are allowed (`autoFix: true`) and the reviewer reports Critical or Warnings, apply concrete fixes now in the main session.
8. Do not auto-fix Suggestions unless `autoFixSuggestions: true` is explicitly configured. By default, Suggestions are report-only.
9. Do not continue iterative improvement beyond concrete Critical/Warning fixes in this pass.
10. If fixes are disabled (`autoFix: false`) or there are no Critical or Warning findings, summarize the review and do not edit files.

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

---

# Auto Review Configuration

Use this section when the user asks about `pi-auto-review` settings, wants to change them via natural language, or needs help configuring the review behavior.

## Available Commands

The extension registers `auto-review` as a Pi command. The `/auto-review` prefix is handled by the extension, not by the agent. The agent **must not** try to edit config JSON files directly.

```
/auto-review on
/auto-review off
/auto-review status
/auto-review config
/auto-review config get <key>
/auto-review config set <key> <value>
/auto-review config init
```

## Natural Language Mapping

When the user says something like the following, translate it into the corresponding `/auto-review` command and tell the user to run it:

| User intent | Agent action |
|-------------|-------------|
| "auto review 끄고 싶어" / "disable auto review" / "stop reviewing" | Say: `Run "/auto-review off" to disable.` |
| "auto review 켜줘" / "enable auto review" / "start reviewing again" | Say: `Run "/auto-review on" to enable.` |
| "auto review 설정 보여줘" / "show auto review settings" / "what is the current config?" | Say: `Run "/auto-review config" to view settings.` |
| "auto review 설정 바꾸고 싶어" / "change auto review config" / "set X to Y" | Identify the key and value, then say: `Run "/auto-review config set <key> <value>".` |
| "리뷰어를 custom-agent로 바꿔줘" / "use my-reviewer as reviewer" | Say: `Run "/auto-review config set reviewerAgent my-reviewer".` |
| "수정은 하지 말고 리뷰만 해줘" / "don't auto-fix, just review" | Say: `Run "/auto-review config set autoFix false".` |
| "suggestion은 고치지 말고 보고만 해" / "don't fix suggestions" | Say: `Run "/auto-review config set autoFixSuggestions false".` |
| "suggestion도 자동으로 고쳐줘" / "auto-fix suggestions too" | Say: `Run "/auto-review config set autoFixSuggestions true".` |
| "리뷰 루프를 2번만 돌려" / "limit review passes to 2" | Say: `Run "/auto-review config set maxReviewPasses 2".` |
| "리뷰 패스 제한 없애" / "unlimited review passes" | Say: `Run "/auto-review config set maxReviewPasses unlimited".` |
| "리뷰 중에 입력 막지 마" / "don't block input during review" | Say: `Run "/auto-review config set blockInputDuringReview false".` |
| " watchdog 시간을 10초로 / 10 seconds watchdog" | Say: `Run "/auto-review config set reviewStartWatchdogMs 10000".` |
| "이 프로젝트에 auto review 설정 파일 만들어줘" / "init auto review config" | Say: `Run "/auto-review config init" to create the project config.` |

## Config Keys Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable automatic review |
| `reviewerAgent` | string | `"reviewer"` | Subagent name for review |
| `reviewerSkills` | string[] | `[]` | Extra skills for reviewer (JSON or space-separated) |
| `reviewerTaskExtra` | string | `""` | Extra instructions appended to task |
| `autoFix` | boolean | `true` | Allow Critical/Warning fixes after reviewer returns |
| `autoFixSuggestions` | boolean | `false` | Allow automatic fixing of Suggestions |
| `blockInputDuringReview` | boolean | `true` | Block user input during review |
| `reviewStartWatchdogMs` | number | `30000` | Timeout before dropping a stuck queued review |
| `maxReviewPasses` | number/null | `null` | Optional pass limit; `null`/`unlimited` means no limit |

## Rules

- Do not claim that commands in assistant text execute automatically. Tell the user the exact `/auto-review` command to run.
- Do **not** manually create or edit `.pi/extensions/auto-review/config.json`. The extension handles file I/O.
- For boolean values, only `true` or `false` are valid.
- For `reviewerSkills`, space-separated shorthand is accepted: `"skill-a skill-b"`.
- For `maxReviewPasses`, use a positive integer or `unlimited`/`none`/`null`.
- If the user is unsure what a key does, use `/auto-review config get <key>`.
- If the user wants to see everything, use `/auto-review config`.
