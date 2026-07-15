---
name: auto-review
description: Review and fix code changes queued by pi-auto-review. Use when invoked by /skill:auto-review after an agent turn changes files.
---

# Auto Review

Use this workflow when `pi-auto-review` asks you to review recent code changes.

## Required Flow

1. Treat the trigger prompt as intentionally compact. Do not expect changed-file lists in the prompt. Derive changed files yourself with scoped read-only git commands before dispatching reviewers; when range details are present, use them as hints only and verify directly.
2. **Constrain review scope to the selected worktree root.** The review target is always the Git worktree selected for this auto-review pass. If the trigger prompt includes `Review worktree root: <path>`, use that absolute path as `reviewCwd`; otherwise resolve the current worktree root with a scoped read-only command such as `git rev-parse --show-toplevel` and call that absolute path `reviewCwd`. A worktree whose absolute path is itself under a parent repository's `.worktree/<name>` directory is still in scope when `reviewCwd` points to it. Exclude only nested sibling worktree directories that appear **inside `reviewCwd` itself**, using root-relative Git pathspecs evaluated from `reviewCwd` such as `git status --porcelain -- :/ ':(top,exclude).worktree' ':(top,exclude).worktree/**'` and `git diff --no-ext-diff -- :/ ':(top,exclude).worktree' ':(top,exclude).worktree/**'`. Do not dispatch reviewers or fixers only when the selected `reviewCwd` has no in-scope changes after those root-relative exclusions.
3. If the trigger prompt includes an `Auto-review context` block with `Committed clean-worktree range: <before>..<after>`, first decide whether this is a new review target or only a bookkeeping follow-up for changes already reviewed in this session. Do **not** dispatch subagents merely because `HEAD` changed, but also do **not** skip based only on conversation memory. Before skipping, perform a cheap scoped read-only range inspection such as `git diff --name-only <before>..<after> -- :/ ':(top,exclude).worktree' ':(top,exclude).worktree/**'`, and when file names are not enough to classify the range, a compact scoped `git diff --no-ext-diff <before>..<after> -- :/ ':(top,exclude).worktree' ':(top,exclude).worktree/**'` or `git log --oneline <before>..<after>` check. Skip only when confidence is high that the range is the same work already reviewed/fixed/validated in the current session and contains no new unreviewed source/config/dependency/docs changes beyond bookkeeping. In particular, do not skip a release/version-bump commit if the inspected range includes new unreviewed code, config, dependency, or docs changes. If confidence is not high, proceed with normal committed-range review. When you do skip, output only a single muted/dim status line: `[auto-review] 이미 리뷰된 변경의 commit/release 후속 작업이라 추가 리뷰를 생략합니다` and stop.
4. For a committed clean-worktree range that is not an already-reviewed bookkeeping follow-up, use that compact range as the primary review target. Inspect the committed range with read-only commands such as `git diff --name-only <before>..<after> -- :/ ':(top,exclude).worktree' ':(top,exclude).worktree/**'` and `git diff --no-ext-diff <before>..<after> -- :/ ':(top,exclude).worktree' ':(top,exclude).worktree/**'`. Derive changed files from those scoped commands rather than from the trigger prompt. Include this range context in every reviewer task so reviewers inspect the committed changes instead of the currently clean worktree.
5. **Perform a mandatory review-worthiness gate before dispatching any subagent.** Do not treat the `/skill:auto-review` trigger itself as sufficient justification to run reviewers. Perform cheap read-only inspection and apply **all** of the following skip rules. If any rule matches, skip the review and output only a single muted/dim status line.
   - **Skip rule A — No meaningful diff**: Run `git status --porcelain -- :/ ':(top,exclude).worktree' ':(top,exclude).worktree/**'` and `git diff --no-ext-diff -- :/ ':(top,exclude).worktree' ':(top,exclude).worktree/**'`. If the scoped current worktree is completely clean, no staged changes exist, and there is no committed range context in the trigger prompt, skip with: `[auto-review] 리뷰할만한 변경이 없습니다`
   - **Skip rule B — Trivial/irrelevant changes only**: If the only changed files are lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `composer.lock`), auto-generated files (`CHANGELOG.md` from version bumps, generated API clients, dist/build artifacts, `.d.ts` files from codegen), or pure formatting changes with zero semantic delta, skip with: `[auto-review] 포맷팅/자동생성/lockfile 변경이라 리뷰를 생략합니다`
   - **Skip rule C — Already-reviewed follow-up with identical scope**: If the current session already contains a recent auto-review pass for the same effective diff, compare the current scoped changed files to the previous review pass in the conversation. If the file set is identical (same paths, same effective diff content) and the previous pass produced no Critical findings, skip with: `[auto-review] 이전 pass와 변경 범위가 동일하고 Critical 이슈가 없어 추가 리뷰를 생략합니다`
   - **Skip rule D — Committed bookkeeping**: If the trigger contains a committed clean-worktree range, apply the committed-range bookkeeping guard above. If confidence is high that the range was already reviewed/fixed in this session, skip with: `[auto-review] 이미 리뷰된 변경의 commit/release 후속 작업이라 추가 리뷰를 생략합니다`
6. Only proceed to reviewer fanout when **none** of the skip rules apply and there is a concrete, non-trivial code change to inspect inside the current worktree scope. For no-target, trivial-only, or identical follow-up cases, prefer skipping rather than speculative review; for uncertain committed ranges, follow the committed-range guard above and proceed with review when confidence to skip is not high.
7. Determine the effective `pi-auto-review` config before fanout/fixer orchestration by running the helper script bundled with this skill from the skill directory: `cd <auto-review-skill-dir> && node scripts/effective-config.mjs "$reviewCwd"`. Resolve `<auto-review-skill-dir>` as the directory containing this `SKILL.md`; do not run `node scripts/effective-config.mjs "$reviewCwd"` from the project root. Treat stdout as the already-merged, already-filtered JSON config and use it directly. The helper applies merge precedence `defaults < global config (~/.pi/agent/extensions/auto-review/config.json) < project config (.pi/extensions/auto-review/config.json)`, walks parent directories for project config, checks Git common-dir for linked worktrees, ignores invalid values, caps `reviewConcurrency` at `8`, merges `reviewerProfiles` by `id`, and filters out `enabled: false` profiles before returning JSON. If the helper script cannot be executed, fall back to the same merge rules manually. Defaults are:
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
   - `maxReviewPasses: null`
8. Build a **flat parallel reviewer fanout**. Do not create nested subagent fanout from a reviewer.
   - If `includeBaselineReview` is not `false`, include **three separate baseline reviewer tasks by default**, even when no `reviewerSkills` are configured:
     1. correctness/regressions/edge cases/unintended side effects;
     2. tests/validation/build confidence and missing verification;
     3. simplicity/maintainability/API clarity/code organization.
   - For every enabled configured `reviewerProfiles` entry with a non-empty effective `task`, add one additional separate reviewer task. Use profile `agent` when set, otherwise `reviewerAgent`; pass profile `skills` as `skill: profile.skills` when non-empty; pass profile `model` as the task `model` when set; append profile `taskExtra` after the profile `task` when non-empty. A project override may omit `task` to inherit the global profile task by `id`; a new enabled profile without a non-empty effective `task` does not create a standalone reviewer task. This supports the same skill loaded multiple times with different role prompts and models. **Do not include disabled profiles (`enabled: false`) in the task list. The extension also strips them at the `tool_call` level as a safety net, but you should not generate them in the first place.**
   - For every configured `reviewerSkills` entry, add one additional separate reviewer task using the same `reviewerAgent` and `skill: [thatSkill]`. Each skill gets its own reviewer so perspectives stay isolated.
   - If the flat list would otherwise be empty because baseline review is disabled and no enabled `reviewerProfiles`/`reviewerSkills` are configured, add one minimal fallback reviewer for correctness/regressions so `/skill:auto-review` still performs a review.
   - Assign a visible prompt label to every reviewer task even though the subagent UI still shows the underlying `agent` name:
     - baseline labels: `[auto-review:correctness]`, `[auto-review:validation]`, `[auto-review:maintainability]`;
     - configured profile labels: profile `label` when set, otherwise `[auto-review:profile:<profile-id>]`;
     - configured skill labels: `[auto-review:skill:<skill-name>]`;
     - fallback label: `[auto-review:fallback-correctness]`.
   - Put the label at the very start of the task text and require the reviewer to start its response with `Reviewer: <same-label>`. This does not rename the subagent, but it makes task previews and returned results distinguishable.
   - Include `Expected Loaded Skills: <skill-list-or-none>` in every reviewer task and require the reviewer response to include `Loaded Skills: <same-skill-list-or-none>` immediately after the `Reviewer:` line. Use `none` for baseline/fallback reviewers, `profile.skills` for profile reviewers when non-empty, and the single configured skill name for `reviewerSkills` tasks. This is an audit marker for whether the intended skill injection was requested.
   - Set `cwd: reviewCwd` on every reviewer task item so the subagent process starts in the current worktree root, not the parent repository or another nested worktree.
   - In every reviewer task, include that the review scope is `reviewCwd` only: if `reviewCwd` itself is under a parent `.worktree/<name>` path, that selected worktree is in scope; exclude only nested `.worktree/**` directories inside `reviewCwd` with root-relative pathspecs.
   - When a committed clean-worktree range is present, include `Review target: committed range <before>..<after>` in every reviewer task and tell reviewers to inspect that range directly. If an `Incremental range since last review:` is also present, prefer that incremental range for follow-up pass reviewer tasks so reviewers inspect only the newly introduced commits.
   - Append `reviewerTaskExtra` to every reviewer task when non-empty.
9. Run reviewer tasks with `subagent({ tasks: [...], concurrency, context: "fresh" })`.
   - Use `concurrency: reviewConcurrency` (configured values are bounded to a maximum of 8).
   - A single `subagent` parallel call supports at most 8 task items. If the flat reviewer list has more than 8 tasks, split it into sequential batches of at most 8 tasks, wait for each batch, then synthesize all batch results together before deciding on fixes.
   - For reviewer profile tasks, include the `model` field only when profile `model` is non-empty.
   - Every reviewer task must say: `Do not modify project/source files; returning findings in your response is allowed.`
   - Ask reviewers to inspect the actual current diff/changed files directly, not just prior summaries.
   - In follow-up review passes, instruct reviewers to prioritize newly introduced changes or unresolved prior findings. If only the baseline correctness reviewer is kept for a follow-up pass, focus its task on validating the auto-fix delta rather than repeating the full original scope.
   - Ask reviewers to return `Reviewer: <label>`, `Loaded Skills: <skill-list-or-none>`, `Critical`, `Warnings`, `Suggestions`, and `Files Reviewed` with file/line evidence where possible.
10. Wait for all reviewer results, then synthesize them in the main session.
   - Deduplicate overlapping findings.
   - Separate `Critical`, `Warnings`, `Suggestions`, and feedback to ignore/defer.
   - Treat Suggestions as report-only unless `autoFixSuggestions: true`.
11. The main session is the orchestrator/synthesizer, not the writer. Do **not** directly edit, write, or run mutating commands for fixes.
12. If fixes are allowed (`autoFix: true`) and the synthesized results contain Critical or Warning findings, call exactly one fixer subagent using `fixerAgent`.
   - Pass only accepted Critical/Warning fixes.
   - Include Suggestions only when `autoFixSuggestions: true` and they are safe, local, and inside the approved scope.
   - Pass `skill: fixerSkills` when configured.
   - Set `cwd: reviewCwd` on the fixer subagent call so writes are constrained to the current worktree root.
   - Append `fixerTaskExtra` when non-empty.
   - The fixer is the only writer for this auto-review pass.
13. Wait for the fixer result. It must report changed files, fixes applied, validation commands/results, failures, remaining risks, and any decisions that need approval.
14. Do not continue iterative improvement beyond concrete accepted fixes in this pass. If the fixer changes files, `pi-auto-review` may queue another pass according to `maxReviewPasses`.
15. If fixes are disabled (`autoFix: false`) or there are no Critical/Warning findings, summarize the review and do not edit files.

## Reviewer Fanout Task Shape

Use this pattern, adapted to the actual config:

```typescript
subagent({
  tasks: [
    {
      agent: reviewerAgent,
      cwd: reviewCwd,
      task: "[auto-review:correctness]\nStart your response with:\nReviewer: [auto-review:correctness]\nLoaded Skills: none\n\nExpected Loaded Skills: none\nReview scope: reviewCwd only. If reviewCwd itself is under a parent .worktree/<name>, that selected worktree is in scope; exclude only nested .worktree/** inside reviewCwd. Review the current diff for correctness, regressions, edge cases, and unintended side effects. Do not modify project/source files; returning findings in your response is allowed. Return Critical, Warnings, Suggestions, and Files Reviewed with file/line evidence.",
      output: false
    },
    {
      agent: reviewerAgent,
      cwd: reviewCwd,
      task: "[auto-review:validation]\nStart your response with:\nReviewer: [auto-review:validation]\nLoaded Skills: none\n\nExpected Loaded Skills: none\nReview scope: reviewCwd only. If reviewCwd itself is under a parent .worktree/<name>, that selected worktree is in scope; exclude only nested .worktree/** inside reviewCwd. Review the current diff for tests, validation quality, build confidence, and missing verification. Do not modify project/source files; returning findings in your response is allowed. Return Critical, Warnings, Suggestions, and Files Reviewed with file/line evidence.",
      output: false
    },
    {
      agent: reviewerAgent,
      cwd: reviewCwd,
      task: "[auto-review:maintainability]\nStart your response with:\nReviewer: [auto-review:maintainability]\nLoaded Skills: none\n\nExpected Loaded Skills: none\nReview scope: reviewCwd only. If reviewCwd itself is under a parent .worktree/<name>, that selected worktree is in scope; exclude only nested .worktree/** inside reviewCwd. Review the current diff for simplicity, maintainability, API clarity, naming, and code organization. Do not modify project/source files; returning findings in your response is allowed. Return Critical, Warnings, Suggestions, and Files Reviewed with file/line evidence.",
      output: false
    },
    {
      agent: "frontend-reviewer",
      cwd: reviewCwd,
      model: "openai-codex/gpt-5.5",
      skill: ["frontend-review"],
      task: "[auto-review:profile:frontend-performance]\nStart your response with:\nReviewer: [auto-review:profile:frontend-performance]\nLoaded Skills: frontend-review\n\nExpected Loaded Skills: frontend-review\nReview scope: reviewCwd only. If reviewCwd itself is under a parent .worktree/<name>, that selected worktree is in scope; exclude only nested .worktree/** inside reviewCwd. Review the current diff with the configured profile role: focus on frontend performance, rendering cost, unnecessary re-renders, and expensive effects. Do not modify project/source files; returning findings in your response is allowed. Return Critical, Warnings, Suggestions, and Files Reviewed with file/line evidence.",
      output: false
    },
    {
      agent: reviewerAgent,
      cwd: reviewCwd,
      skill: ["frontend-review"],
      task: "[auto-review:skill:frontend-review]\nStart your response with:\nReviewer: [auto-review:skill:frontend-review]\nLoaded Skills: frontend-review\n\nExpected Loaded Skills: frontend-review\nReview scope: reviewCwd only. If reviewCwd itself is under a parent .worktree/<name>, that selected worktree is in scope; exclude only nested .worktree/** inside reviewCwd. Review the current diff from the frontend-review perspective: React, UI behavior, UX, accessibility, styling, component state, and user interactions. Do not modify project/source files; returning findings in your response is allowed. Return Critical, Warnings, Suggestions, and Files Reviewed with file/line evidence.",
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
  cwd: reviewCwd,
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
## Reviewer Skill Audit
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
/auto-review config [--global|--project|--scope global|--scope project]
/auto-review config [--global|--project|--scope global|--scope project] get <key>
/auto-review config [--global|--project|--scope global|--scope project] set <key> <value>
/auto-review config [--global|--project|--scope global|--scope project] init
```

## Natural Language Mapping

When the user says something like the following, translate it into the corresponding `/auto-review` command and tell the user to run it:

| User intent | Agent action |
|-------------|-------------|
| "auto review 끄고 싶어" / "disable auto review" / "stop reviewing" | Say: `Run "/auto-review off" to disable.` |
| "auto review 켜줘" / "enable auto review" / "start reviewing again" | Say: `Run "/auto-review on" to enable.` |
| "auto review 설정 보여줘" / "show auto review settings" / "what is the current config?" | Say: `Run "/auto-review config" to view effective settings, or "/auto-review config --global" / "/auto-review config --project" for one scope.` |
| "auto review 설정 바꾸고 싶어" / "change auto review config" / "set X to Y" | Identify the key, value, and scope. For project scope say: `Run "/auto-review config set <key> <value>".` For global scope say: `Run "/auto-review config --global set <key> <value>".` |
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
| "global auto review 설정 파일 만들어줘" / "전역 설정 만들어줘" | Say: `Run "/auto-review config --global init" to create the global config.` |
| "global baseline review 꺼줘" / "전역 기본 리뷰 끄기" | Say: `Run "/auto-review config --global set includeBaselineReview false".` |

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
- Do **not** manually create or edit `.pi/extensions/auto-review/config.json` or `~/.pi/agent/extensions/auto-review/config.json`. The extension handles file I/O.
- Config commands default to project writes for `set`/`init`; unscoped `config` display/get reads effective merged settings. Use `--global` or `--scope global` to target global config, and `--project` or `--scope project` to explicitly select project config. Do not use `--scope effective`; it is unsupported and should show usage/help.
- For boolean values, only `true` or `false` are valid.
- For `reviewerSkills` and `fixerSkills`, space-separated shorthand is accepted: `"skill-a skill-b"`.
- For `reviewerProfiles`, provide a JSON array. Example: `[{"id":"frontend-performance","agent":"reviewer","model":"openai-codex/gpt-5.5","skills":["frontend-review"],"task":"Focus on frontend performance."}]`. A new enabled profile needs a non-empty `task`; a project override for an existing global profile may omit `task` or other fields to inherit them by `id`, override fields with supported replacement values, add fields, or disable the profile with `enabled: false`. Do not use `null` or empty strings expecting them to unset inherited optional fields such as `agent`, `model`, `label`, `task`, `taskExtra`, or `skills`.
- `/auto-review config set reviewerProfiles [...]` replaces the project-level `reviewerProfiles` array in `.pi/extensions/auto-review/config.json`; `/auto-review config --global set reviewerProfiles [...]` replaces the global array in `~/.pi/agent/extensions/auto-review/config.json`. These commands do not append to or patch the existing scoped list. If the user wants to add one profile while keeping other profiles in that scope, tell them to include all desired profiles in the JSON array. Effective config still merges global and project profiles by `id` after that replacement.
- For `reviewConcurrency`, use a positive integer no greater than `8`.
- For `maxReviewPasses`, use a positive integer or `unlimited`/`none`/`null`.
- If the user is unsure what a key does, use `/auto-review config get <key>`.
- If the user wants to see everything, use `/auto-review config`.
