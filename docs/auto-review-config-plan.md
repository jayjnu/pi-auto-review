# Auto Review Config Plan

> Forward-looking design note: this configuration layer is planned but not implemented yet.

## Goal

Add global and project-level configuration for `pi-auto-review`, especially for controlling the bundled `pi-subagents` reviewer behavior and review/fix loop policy.

## 1. Config Schema

Add a new file:

```text
extensions/auto-review/config.ts
```

Support:

```ts
export interface AutoReviewConfig {
  enabled?: boolean;
  reviewerAgent?: string;
  reviewerSkills?: string[];
  reviewerTaskExtra?: string;
  autoFix?: boolean;
  blockInputDuringReview?: boolean;
  reviewStartWatchdogMs?: number;
}
```

Defaults:

```ts
{
  enabled: true,
  reviewerAgent: 'reviewer',
  reviewerSkills: [],
  reviewerTaskExtra: '',
  autoFix: true,
  blockInputDuringReview: true,
  reviewStartWatchdogMs: 30_000,
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
- Invalid JSON: warn and ignore.
- Unknown keys: ignore or warn.

## 3. Prompt Builder Changes

Extend `ReviewPromptInput` in `helpers.ts`:

```ts
interface ReviewPromptInput {
  changedFiles: string[];
  status: string;
  beforeHead?: string;
  afterHead?: string;
  reviewerAgent: string;
  reviewerSkills: string[];
  reviewerTaskExtra?: string;
  autoFix: boolean;
}
```

Prompt should invoke the bundled skill command and pass only run-specific context:

```text
/skill:auto-review

<!-- pi-auto-review-turn -->
Review and fix the code changes from the previous turn.
...
```

The stable workflow lives in `skills/auto-review/SKILL.md`. Config-derived options such as `reviewerAgent`, `reviewerSkills`, `autoFix`, and `reviewerTaskExtra` should either be passed as concise context in the skill command arguments or represented by generated skill/config guidance.

## 4. Index Wiring

In `index.ts`:

- Load config on `session_start` using `ctx.cwd`.
- Keep runtime override for `/auto-review on|off`.
- Compute effective enabled state via:

```ts
function isEnabled() {
  if (pi.getFlag('no-auto-review') === true) return false;
  return runtimeEnabledOverride ?? config.enabled;
}
```

Priority:

```text
--no-auto-review flag > runtime /auto-review on/off > project config > global config > defaults
```

Use config values when building the review prompt.

## 5. Guard Policy

Use config to control guards:

- `blockInputDuringReview: false` disables input blocking.
- `reviewStartWatchdogMs` controls watchdog timeout.
- `autoFix: false` keeps review turn read-only for the whole turn.
- `autoFix: true` allows fixes after configured reviewer subagent returns.

Reviewer subagent completion should still be recognized only when the subagent input matches the configured reviewer agent.

## 6. Tests

Add tests for:

- Global config load.
- Project config overrides global config.
- Invalid JSON is ignored with warning.
- Prompt starts with `/skill:auto-review` and includes `AUTO_REVIEW_PROMPT_MARKER`.
- `reviewerAgent` appears in skill context and controls reviewer-completion guard.
- `reviewerSkills` appears in skill context.
- `reviewerTaskExtra` appears in skill context.
- `autoFix: false` prompts no-fix behavior and keeps mutation guard enabled.
- `blockInputDuringReview: false` does not block input.
- Custom `reviewStartWatchdogMs` is used.
- Runtime `/auto-review off/on` override still works.

## 7. README Updates

Add a `Configuration` section.

Global config path:

```text
~/.pi/agent/extensions/auto-review/config.json
```

Project config path:

```text
.pi/extensions/auto-review/config.json
```

Example:

```json
{
  "reviewerAgent": "reviewer",
  "reviewerSkills": ["effect-ts-reviewer"],
  "reviewerTaskExtra": "Check Effect service/layer patterns.",
  "autoFix": true,
  "blockInputDuringReview": true,
  "reviewStartWatchdogMs": 30000
}
```

Clarify that:

- `pi-auto-review` controls when review/fix turns are queued.
- bundled `pi-subagents` runs the configured reviewer.
- fixes are allowed only according to `autoFix` policy.

## 8. Validation

Run:

```bash
npm test
npm run typecheck
pi remove /path/to/pi-auto-review || true
pi install /path/to/pi-auto-review
```

## 9. Implementation Order

1. Add `config.ts`.
2. Extend `helpers.ts` prompt input and tests.
3. Wire config into `index.ts`.
4. Add config/guard tests.
5. Update README.
6. Run tests/typecheck.
7. Reinstall local Pi package.
