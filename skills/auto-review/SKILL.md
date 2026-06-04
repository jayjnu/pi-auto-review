---
name: auto-review
description: Review and fix code changes queued by pi-auto-review. Use when invoked by /skill:auto-review after an agent turn changes files.
---

# Auto Review

Use this workflow when `pi-auto-review` asks you to review recent code changes.

## Required Flow

1. Treat the trigger prompt as intentionally minimal. Do not expect changed-file lists or diff details in the prompt for normal dirty-worktree reviews.
2. If the trigger prompt includes an `Auto-review context` block with `Committed clean-worktree range: <before>..<after>`, use that compact range as the primary review target. Inspect the committed range with read-only commands such as `git diff --name-only <before>..<after>` and `git diff --no-ext-diff <before>..<after>`. Use any `Changed files:` line as a hint only; verify the range directly. Include this range context in every reviewer task so reviewers inspect the committed changes instead of the currently clean worktree.
3. Before dispatching any subagent, decide whether there is a meaningful review target in the current context. Use the explicit committed range when present; otherwise use the conversation, prior reviewer findings, recent tool results, known edits/fixes, and read-only signals such as `git status --porcelain`, `git diff --no-ext-diff`, `git diff --cached --no-ext-diff`, or recent `HEAD` inspection.
4. If there is no plausible code change, unresolved reviewer finding, or other reviewable artifact to inspect, do not call subagents. Output only a single muted/dim status line: `[auto-review] 리뷰할만한 변경이 없습니다` and stop.
5. Determine the effective `pi-auto-review` config before fanout/fixer orchestration. Merge precedence is `defaults < global config (~/.pi/agent/extensions/auto-review/config.json) < project config (.pi/extensions/auto-review/config.json)`. Apply the same normalization as the extension: ignore unknown keys; ignore invalid or missing values and keep the lower-priority/default value; ignore empty `reviewerAgent`/`fixerAgent`; require booleans to be actual booleans; require positive numbers where numeric; require `reviewConcurrency` to be a positive integer capped at `8` and defaulting to `4`; require `maxReviewPasses` to be `null` or a positive integer; require `reviewerSkills`/`fixerSkills` to be string arrays in JSON config (the `/auto-review config set ...Skills a b` command accepts space-separated input because it writes an array); require `reviewerProfiles` to be a JSON array of objects with non-empty `id` and optional `agent`, `model`, `skills`, `task`, `taskExtra`, `label`, and boolean `enabled`. Merge `reviewerProfiles` by `id` across global and project config so project profiles can override fields, add fields, inherit omitted fields, or set `enabled: false` for global profiles. A project override may omit `task` to inherit a global profile task by id. A new enabled profile needs a non-empty `task` before it can create a standalone reviewer task. Do not treat `null` or empty strings as an unset mechanism for inherited optional profile fields such as `agent`, `model`, `label`, `task`, `taskExtra`, or `skills`; null-clearing is not supported in this pass. Defaults are:
   - `enabled: true`
   - `reviewerAgent: "reviewer"`
   - `reviewerSkills: []`
   - `reviewerTaskExtra: ""`
   - `reviewerProfiles: []`
   - `reviewConcurrency: 4` (maximum 8)
   - `includeBaselineReview: true`
   - `fixerAgent: "worker"`
   - `fixerSkills: []`
   - `fixerTaskExtra: ""`
   - `autoFix: true`
   - `autoFixSuggestions: false`
   - `blockInputDuringReview: true`
   - `reviewStartWatchdogMs: 30000`
   - `maxReviewPasses: null`
6. Build a **flat parallel reviewer fanout**. Do not create nested subagent fanout from a reviewer.
   - If `includeBaselineReview` is not `false`, include **three separate baseline reviewer tasks by default**, even when no `reviewerSkills` are configured:
     1. correctness/regressions/edge cases/unintended side effects;
     2. tests/validation/build confidence and missing verification;
     3. simplicity/maintainability/API clarity/code organization.
   - For every enabled configured `reviewerProfiles` entry with a non-empty effective `task`, add one additional separate reviewer task. Use profile `agent` when set, otherwise `reviewerAgent`; pass profile `skills` as `skill: profile.skills` when non-empty; pass profile `model` as the task `model` when set; append profile `taskExtra` after the profile `task` when non-empty. A project override may omit `task` to inherit the global profile task by `id`; a new enabled profile without a non-empty effective `task` does not create a standalone reviewer task. This supports the same skill loaded multiple times with different role prompts and models.
   - For every configured `reviewerSkills` entry, add one additional separate reviewer task using the same `reviewerAgent` and `skill: [thatSkill]`. Each skill gets its own reviewer so perspectives stay isolated.
   - If the flat list would otherwise be empty because baseline review is disabled and no enabled `reviewerProfiles`/`reviewerSkills` are configured, add one minimal fallback reviewer for correctness/regressions so `/skill:auto-review` still performs a review.
   - Assign a visible prompt label to every reviewer task even though the subagent UI still shows the underlying `agent` name:
     - baseline labels: `[auto-review:correctness]`, `[auto-review:validation]`, `[auto-review:maintainability]`;
     - configured profile labels: profile `label` when set, otherwise `[auto-review:profile:<profile-id>]`;
     - configured skill labels: `[auto-review:skill:<skill-name>]`;
     - fallback label: `[auto-review:fallback-correctness]`.
   - Put the label at the very start of the task text and require the reviewer to start its response with `Reviewer: <same-label>`. This does not rename the subagent, but it makes task previews and returned results distinguishable.
   - When a committed clean-worktree range is present, include `Review target: committed range <before>..<after>` in every reviewer task and tell reviewers to inspect that range directly.
   - Append `reviewerTaskExtra` to every reviewer task when non-empty.
7. Run reviewer tasks with `subagent({ tasks: [...], concurrency, context: "fresh" })`.
   - Use `concurrency: reviewConcurrency` (configured values are bounded to a maximum of 8).
   - A single `subagent` parallel call supports at most 8 task items. If the flat reviewer list has more than 8 tasks, split it into sequential batches of at most 8 tasks, wait for each batch, then synthesize all batch results together before deciding on fixes.
   - For reviewer profile tasks, include the `model` field only when profile `model` is non-empty.
   - Every reviewer task must say: `Do not modify project/source files; returning findings in your response is allowed.`
   - Ask reviewers to inspect the actual current diff/changed files directly, not just prior summaries.
   - Ask reviewers to return `Reviewer: <label>`, `Critical`, `Warnings`, `Suggestions`, and `Files Reviewed` with file/line evidence where possible.
8. Wait for all reviewer results, then synthesize them in the main session.
   - Deduplicate overlapping findings.
   - Separate `Critical`, `Warnings`, `Suggestions`, and feedback to ignore/defer.
   - Treat Suggestions as report-only unless `autoFixSuggestions: true`.
9. The main session is the orchestrator/synthesizer, not the writer. Do **not** directly edit, write, or run mutating commands for fixes.
10. If fixes are allowed (`autoFix: true`) and the synthesized results contain Critical or Warning findings, call exactly one fixer subagent using `fixerAgent`.
   - Pass only accepted Critical/Warning fixes.
   - Include Suggestions only when `autoFixSuggestions: true` and they are safe, local, and inside the approved scope.
   - Pass `skill: fixerSkills` when configured.
   - Append `fixerTaskExtra` when non-empty.
   - The fixer is the only writer for this auto-review pass.
11. Wait for the fixer result. It must report changed files, fixes applied, validation commands/results, failures, remaining risks, and any decisions that need approval.
12. Do not continue iterative improvement beyond concrete accepted fixes in this pass. If the fixer changes files, `pi-auto-review` may queue another pass according to `maxReviewPasses`.
13. If fixes are disabled (`autoFix: false`) or there are no Critical/Warning findings, summarize the review and do not edit files.

## Reviewer Fanout Task Shape

Use this pattern, adapted to the actual config:

```typescript
subagent({
  tasks: [
    {
      agent: reviewerAgent,
      task: "[auto-review:correctness]\nStart your response with: Reviewer: [auto-review:correctness]\n\nReview the current diff for correctness, regressions, edge cases, and unintended side effects. Do not modify project/source files; returning findings in your response is allowed. Return Critical, Warnings, Suggestions, and Files Reviewed with file/line evidence.",
      output: false
    },
    {
      agent: reviewerAgent,
      task: "[auto-review:validation]\nStart your response with: Reviewer: [auto-review:validation]\n\nReview the current diff for tests, validation quality, build confidence, and missing verification. Do not modify project/source files; returning findings in your response is allowed. Return Critical, Warnings, Suggestions, and Files Reviewed with file/line evidence.",
      output: false
    },
    {
      agent: reviewerAgent,
      task: "[auto-review:maintainability]\nStart your response with: Reviewer: [auto-review:maintainability]\n\nReview the current diff for simplicity, maintainability, API clarity, naming, and code organization. Do not modify project/source files; returning findings in your response is allowed. Return Critical, Warnings, Suggestions, and Files Reviewed with file/line evidence.",
      output: false
    },
    {
      agent: "frontend-reviewer",
      model: "openai-codex/gpt-5.5",
      skill: ["frontend-review"],
      task: "[auto-review:profile:frontend-performance]\nStart your response with: Reviewer: [auto-review:profile:frontend-performance]\n\nReview the current diff with the configured profile role: focus on frontend performance, rendering cost, unnecessary re-renders, and expensive effects. Do not modify project/source files; returning findings in your response is allowed. Return Critical, Warnings, Suggestions, and Files Reviewed with file/line evidence.",
      output: false
    },
    {
      agent: reviewerAgent,
      skill: ["frontend-review"],
      task: "[auto-review:skill:frontend-review]\nStart your response with: Reviewer: [auto-review:skill:frontend-review]\n\nReview the current diff from the frontend-review perspective: React, UI behavior, UX, accessibility, styling, component state, and user interactions. Do not modify project/source files; returning findings in your response is allowed. Return Critical, Warnings, Suggestions, and Files Reviewed with file/line evidence.",
      output: false
    }
  ],
  concurrency: reviewConcurrency,
  context: "fresh"
})
```

## Fixer Task Shape

Use this pattern only after synthesizing accepted fixes:

```typescript
subagent({
  agent: fixerAgent,
  // Include this field only when fixerSkills is non-empty:
  // skill: fixerSkills,
  task: "Apply only the accepted auto-review fixes below. You are the sole writer for this pass. Preserve user-approved scope. Do not fix Suggestions unless explicitly listed. Do not spawn subagents. Run focused validation when possible and report changed files, fixes applied, validation commands/results, failures, remaining risks, and decisions needing approval.\n\nAccepted fixes:\n...",
  context: "fork"
})
```

When `fixerSkills` is empty, omit the `skill` field entirely; still call exactly one fixer subagent.

## Context Rules

- You are the main Pi agent, so use the current chat context and project instructions while orchestrating review/fix.
- Reviewer subagents provide isolated read-only review perspectives.
- The fixer subagent is the single writer when auto-fix is enabled and accepted fixes exist.
- If relevant skills are available, read and follow them, and report which skills you used.
- Report concrete findings with file paths and line numbers when possible.

## Output Format

```markdown
## Skills Used
## Summary
## Critical
## Warnings
## Suggestions
## Fixes Applied
## Validation
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
| "리뷰 skill을 frontend-review effect-ts-reviewer로 나눠서 돌려" | Say: `Run "/auto-review config set reviewerSkills frontend-review effect-ts-reviewer".` |
| "frontend perf 리뷰어를 gpt-5.5로 추가해줘" | Explain that `/auto-review config set reviewerProfiles [...]` replaces the whole project-level `reviewerProfiles` array, so the JSON must include every project profile they want to keep. Then say: `Run "/auto-review config set reviewerProfiles [{\"id\":\"frontend-performance\",\"agent\":\"reviewer\",\"model\":\"openai-codex/gpt-5.5\",\"skills\":[\"frontend-review\"],\"task\":\"Focus on frontend performance, rendering cost, unnecessary re-renders, and expensive effects.\"}]" if this should be the full project profile list.` |
| "기본 correctness 리뷰는 빼줘" | Say: `Run "/auto-review config set includeBaselineReview false".` |
| "리뷰 병렬도를 2로 해줘" | Say: `Run "/auto-review config set reviewConcurrency 2".` |
| "fixer를 auto-review-fixer로 바꿔줘" | Say: `Run "/auto-review config set fixerAgent auto-review-fixer".` |
| "fixer에 effect-typescript skill을 넣어줘" | Say: `Run "/auto-review config set fixerSkills effect-typescript".` |
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
| `reviewerSkills` | string[] | `[]` | Extra review skills; each skill becomes its own flat parallel reviewer task |
| `reviewerTaskExtra` | string | `""` | Extra instructions appended to every reviewer task |
| `reviewerProfiles` | object[] | `[]` | Additional flat reviewer profiles. Each enabled profile can set `id`, `agent`, `model`, `skills`, `task`, `taskExtra`, and `label`; project profiles merge by `id`, can override fields, add fields, inherit omitted fields, and can disable a global profile with `enabled: false`. A new enabled profile needs a non-empty `task` to create a standalone reviewer task. `null` and empty strings are not a supported way to unset inherited optional profile fields such as `agent`, `model`, `label`, `task`, `taskExtra`, or `skills` |
| `reviewConcurrency` | number | `4` | Max concurrent flat reviewer tasks; capped at `8` |
| `includeBaselineReview` | boolean | `true` | Include the default baseline reviewer set: correctness, tests/validation, and simplicity/maintainability |
| `fixerAgent` | string | `"worker"` | Single writer subagent used for accepted auto-fixes |
| `fixerSkills` | string[] | `[]` | Extra skills injected into the fixer subagent |
| `fixerTaskExtra` | string | `""` | Extra instructions appended to the fixer task |
| `autoFix` | boolean | `true` | Allow Critical/Warning fixes after reviewers return |
| `autoFixSuggestions` | boolean | `false` | Allow automatic fixing of Suggestions |
| `blockInputDuringReview` | boolean | `true` | Block user input while a review turn is queued but not yet dispatched |
| `reviewStartWatchdogMs` | number | `30000` | Timeout before dropping a stuck queued review |
| `maxReviewPasses` | number/null | `null` | Optional pass limit; `null`/`unlimited` means no limit |

## Rules

- Do not claim that commands in assistant text execute automatically. Tell the user the exact `/auto-review` command to run.
- Do **not** manually create or edit `.pi/extensions/auto-review/config.json`. The extension handles file I/O.
- For boolean values, only `true` or `false` are valid.
- For `reviewerSkills` and `fixerSkills`, space-separated shorthand is accepted: `"skill-a skill-b"`.
- For `reviewerProfiles`, provide a JSON array. Example: `[{"id":"frontend-performance","agent":"reviewer","model":"openai-codex/gpt-5.5","skills":["frontend-review"],"task":"Focus on frontend performance."}]`. A new enabled profile needs a non-empty `task`; a project override for an existing global profile may omit `task` or other fields to inherit them by `id`, override fields with supported replacement values, add fields, or disable the profile with `enabled: false`. Do not use `null` or empty strings expecting them to unset inherited optional fields such as `agent`, `model`, `label`, `task`, `taskExtra`, or `skills`.
- `/auto-review config set reviewerProfiles [...]` replaces the project-level `reviewerProfiles` array in `.pi/extensions/auto-review/config.json`; it does not append to or patch the existing project list. If the user wants to add one profile while keeping other project profiles, tell them to include all desired project profiles in the JSON array. Effective config still merges global and project profiles by `id` after that replacement.
- For `reviewConcurrency`, use a positive integer no greater than `8`.
- For `maxReviewPasses`, use a positive integer or `unlimited`/`none`/`null`.
- If the user is unsure what a key does, use `/auto-review config get <key>`.
- If the user wants to see everything, use `/auto-review config`.
