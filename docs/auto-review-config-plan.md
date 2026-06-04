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
  reviewerProfiles?: Array<{
    id: string;
    agent?: string;
    model?: string;
    skills?: string[];
    task?: string;
    taskExtra?: string;
    label?: string;
    enabled?: boolean;
  }>;
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
  reviewerProfiles: [],
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

Project config overrides global config. Commands can target either scope: `/auto-review config --global ...` or `/auto-review config --scope global ...` reads/writes the global file, while `/auto-review config --project ...`, `/auto-review config --scope project ...`, or an unscoped `set`/`init` reads/writes the project file. Unscoped `config` display/get reads effective merged settings; explicit `--scope effective` is unsupported and should show usage/help. `reviewerProfiles` normalization and merge behavior is implemented in `extensions/auto-review/reviewer-profiles.ts`; this is the executable source of truth. In summary, profiles are merged by `id`, so project config can override fields, add fields, inherit omitted fields, or disable global profiles with `enabled: false`. A project override may omit `task` to inherit a global profile task by id. A new enabled profile needs a non-empty `task` to create a standalone reviewer task. There is no supported null/empty-string clearing mechanism for inherited optional profile fields; `null` or `""` cannot currently unset inherited `agent`, `model`, `label`, `task`, `taskExtra`, or `skills`. The `/auto-review config set reviewerProfiles [...]` command replaces the project-level `reviewerProfiles` array in that file; `/auto-review config --global set reviewerProfiles [...]` replaces the global array. These are not append/update operations for the scoped list. Effective config still merges global and project profiles by `id` after the scoped array is replaced.

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
   - one isolated additional reviewer task per enabled `reviewerProfiles` entry with a non-empty effective `task`, with per-profile `agent`, `model`, `skills`, role `task`, and `taskExtra`; project overrides may omit fields to inherit them by id, but cannot unset inherited optional fields with `null` or empty strings;
   - one isolated additional reviewer task per `reviewerSkills` entry;
   - `reviewerTaskExtra` appended to every reviewer task;
   - `reviewConcurrency` passed to `subagent({ tasks })`, with reviewer fanout split into sequential batches of at most 8 tasks when needed.
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
- Reviewer profile JSON arrays normalize and merge by `id` across global/project config.
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
