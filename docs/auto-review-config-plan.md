# Auto Review Config Implementation Notes

> Historical implementation notes for the `pi-auto-review` configuration layer. The feature is implemented; use `README.md` as the public user-facing reference.

## Goal

Document the global and project-level configuration for `pi-auto-review`, including flat parallel reviewer fanout and the single-writer fixer subagent.

## 1. Config Schema

Implemented in:

```text
extensions/auto-review/config.ts
```

Supported schema:

```ts
export interface AutoReviewConfig {
  enabled?: boolean;
  reviewerAgent?: string;
  reviewerSkills?: string[];
  reviewerTaskExtra?: string;
  reviewConcurrency?: number;
  includeBaselineReview?: boolean;
  fixerAgent?: string;
  fixerSkills?: string[];
  fixerTaskExtra?: string;
  autoFix?: boolean;
  autoFixSuggestions?: boolean;
  blockInputDuringReview?: boolean;
  reviewStartWatchdogMs?: number;
  maxReviewPasses?: number | null;
}
```

Defaults:

```ts
{
  enabled: true,
  reviewerAgent: 'reviewer',
  reviewerSkills: [],
  reviewerTaskExtra: '',
  reviewConcurrency: 4,
  includeBaselineReview: true,
  fixerAgent: 'worker',
  fixerSkills: [],
  fixerTaskExtra: '',
  autoFix: true,
  autoFixSuggestions: false,
  blockInputDuringReview: true,
  reviewStartWatchdogMs: 30_000,
  maxReviewPasses: null,
}
```

## 2. Config File Paths

Load and merge in this order:

```text
defaults
< ~/.pi/agent/extensions/auto-review/config.json
< <cwd>/.pi/extensions/auto-review/config.json
```

Project config overrides global config.

Behavior:

- Missing file: ignore.
- Invalid JSON/read failure: ignore and fall back to lower-priority config/defaults.
- Unknown keys: ignore.

## 3. Prompt Builder Changes

Prompt generation intentionally dispatches only the bundled skill command:

```text
/skill:auto-review
```

The stable workflow lives in `skills/auto-review/SKILL.md`. The skill reads the current git state and supported effective config itself, keeping the queued prompt minimal and avoiding duplicated run/config context in the prompt body.

## 4. Auto-Review Skill Workflow

The skill now instructs the main agent to:

1. Decide whether a review target exists.
2. Build a flat parallel reviewer fanout:
   - three default baseline reviewers when `includeBaselineReview` is true: correctness/regressions, tests/validation, and simplicity/maintainability;
   - one isolated additional reviewer task per `reviewerSkills` entry;
   - `reviewerTaskExtra` appended to every reviewer task;
   - `reviewConcurrency` passed to `subagent({ tasks })`.
3. Keep reviewers read-only and non-nested.
4. Synthesize findings in the main session.
5. If `autoFix` permits accepted fixes, dispatch exactly one `fixerAgent` subagent as the only writer.
6. Pass `fixerSkills` and `fixerTaskExtra` to the fixer when configured.

## 5. Index Wiring

In `index.ts`:

- Load config on `session_start` using `ctx.cwd`.
- Keep runtime override for `/auto-review on|off`.
- Compute effective enabled state with this priority:

```text
--no-auto-review flag > runtime /auto-review on/off > project config > global config > defaults
```

The extension still queues only `/skill:auto-review`.

## 6. Fixer Mutation Tracking

The extension tracks completed `subagent` tool results targeting the configured `fixerAgent`, including errored or partial fixer runs, and treats them as mutation sources when git state or file content actually changed. This keeps repeated review passes working when the fixer changes the same dirty files and porcelain status does not change.

Reviewer subagents are not treated as mutation sources.

## 7. Guard Policy

Use config to control queue behavior and skill workflow instructions:

- `blockInputDuringReview: false` disables input blocking while a review is queued but not yet dispatched.
- `reviewStartWatchdogMs` controls watchdog timeout.
- `autoFix: false` tells the auto-review skill to report findings without dispatching the fixer.
- `autoFix: true` allows the single `fixerAgent` to fix Critical/Warning findings after reviewers return.
- `autoFixSuggestions: false` keeps Suggestions report-only by default.
- `maxReviewPasses` optionally limits repeated review/fix passes in one loop.

The extension intentionally does not enforce mutation-blocking guard hooks inside child reviewer sessions. Workflow discipline is owned by `skills/auto-review/SKILL.md` and `pi-subagents`.

## 8. Tests

Config-related tests cover:

- Global config load.
- Project config overrides global config.
- Invalid JSON/read failures fall back to lower-priority config/defaults.
- Prompt generation is the minimal `/skill:auto-review` command.
- Config is loaded before dispatch while the generated prompt remains `/skill:auto-review`.
- Reviewer/fixer skill arrays parse from shorthand.
- `reviewConcurrency`, `includeBaselineReview`, and `fixerAgent` defaults/config commands.
- Completed configured fixer subagent results, including errored or partial runs, are treated as mutation sources for follow-up review passes when git state/content changed.

## 9. Validation

Run:

```bash
npm test
npm run typecheck
pi remove /path/to/pi-auto-review || true
pi install /path/to/pi-auto-review
```
