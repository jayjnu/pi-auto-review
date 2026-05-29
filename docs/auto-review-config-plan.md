# Auto Review Config Implementation Notes

> Historical implementation notes for the `pi-auto-review` configuration layer. The feature is implemented; use `README.md` as the public user-facing reference.

## Goal

Document the global and project-level configuration for `pi-auto-review`, especially for controlling review/fix loop policy and the currently supported reviewer-agent selection.

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

`ReviewPromptInput` in `helpers.ts` includes the run context and effective review policy:

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
  autoFixSuggestions: boolean;
  reviewPass?: number;
  maxReviewPasses?: number | null;
}
```

Prompt generation intentionally dispatches only the bundled skill command:

```text
/skill:auto-review
```

The stable workflow lives in `skills/auto-review/SKILL.md`. The skill reads the current git state and supported effective config itself, keeping the queued prompt minimal and avoiding duplicated run/config context in the prompt body. The minimal prompt path does not currently inject `reviewerSkills` or `reviewerTaskExtra` into the reviewer subagent call; wire those fields into the skill workflow before relying on them for reviewer customization.

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

Do not inject config values into the generated prompt; the queued prompt stays minimal and the auto-review skill reads config when it runs.

## 5. Guard Policy

Use config to control queue behavior and skill workflow instructions:

- `blockInputDuringReview: false` disables input blocking while a review is queued but not yet dispatched.
- `reviewStartWatchdogMs` controls watchdog timeout.
- `autoFix: false` tells the auto-review skill to report findings without applying fixes.
- `autoFix: true` allows the main agent to fix Critical/Warning findings after the configured reviewer subagent returns.
- `autoFixSuggestions: false` keeps Suggestions report-only by default.
- `maxReviewPasses` optionally limits repeated review/fix passes in one loop.

The extension intentionally does not enforce mutation-blocking guard hooks during the review turn. Workflow discipline is owned by `skills/auto-review/SKILL.md` and `pi-subagents`.

## 6. Tests

Config-related tests cover:

- Global config load.
- Project config overrides global config.
- Invalid JSON/read failures fall back to lower-priority config/defaults.
- Prompt generation is the minimal `/skill:auto-review` command.
- The generated prompt does not duplicate changed files, reviewer settings, or review-pass context.
- Config is loaded before dispatch while the generated prompt remains `/skill:auto-review`.
- `blockInputDuringReview: false` does not block input.
- Custom `reviewStartWatchdogMs` is used.
- Runtime `/auto-review off/on` override still works.

## 7. README Updates

`README.md` includes a `Configuration` section.

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
  "autoFixSuggestions": false,
  "blockInputDuringReview": true,
  "reviewStartWatchdogMs": 30000,
  "maxReviewPasses": null
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

## 9. Historical Implementation Order

1. Added `config.ts`.
2. Extended `helpers.ts` prompt input and tests.
3. Wired config into `index.ts`.
4. Added config/queue-behavior tests.
5. Updated README.
6. Ran tests/typecheck.
7. Reinstalled local Pi package.
