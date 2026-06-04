# pi-auto-review

A Pi package that automatically queues a subagent-backed code review and fix loop after a Pi agent finishes a user prompt that changed code.

## Install

```bash
pi install npm:@jayjnu/pi-auto-review
```

For GitHub install without npm publishing:

```bash
pi install git:https://github.com/jayjnu/pi-auto-review.git
```

For local development:

```bash
pi -e /path/to/pi-auto-review
```

## Behavior

`pi-auto-review` runs once after an agent prompt changes code. It does not run after every individual edit. If the agent commits its changes and leaves a clean worktree, auto-review asks the main agent to review the committed range from the turn's starting `HEAD` to the ending `HEAD`.

The package bundles `pi-subagents` and an `auto-review` skill. After Pi becomes idle, it queues a short `/skill:auto-review` main-agent orchestration turn. For normal dirty-worktree reviews this prompt stays minimal; for clean-worktree committed changes it appends only the compact `before..after` commit range and changed-file names so the skill can inspect the committed diff.

That skill tells the main agent to first decide whether the current context contains a meaningful review target, then orchestrate a flat parallel reviewer fanout. Three baseline reviewers are included by default (correctness/regressions, tests/validation, and simplicity/maintainability), and each configured `reviewerSkills` entry becomes its own isolated additional reviewer task. The main agent synthesizes those read-only reviewer results. When auto-fix is enabled and Critical or Warning findings are accepted, the main agent dispatches exactly one configured fixer subagent as the single writer. That means:

- review context is isolated in child Pi sessions via `pi-subagents`;
- skill-specific review perspectives can run in parallel without nested fanout;
- fixes are applied by one configured fixer subagent, not by parallel reviewers;
- the main chat flow remains the orchestrator/synthesizer;
- the extension can briefly block new user input while a review turn is queued;
- no custom background reviewer process is spawned by `pi-auto-review`.

The extension dispatches the `/skill:auto-review` skill command, with compact committed-range context only for clean-worktree committed changes, and relies on the bundled skill plus `pi-subagents` for review/fix workflow discipline. If the configured fixer subagent changes files, `pi-auto-review` treats that fixer run as a mutation source and can queue another review turn.

The package assumes Pi skill commands are enabled. Pi defaults `enableSkillCommands` to `true`; if your effective settings disable it, `pi-auto-review` shows a session-start warning asking you to set `"enableSkillCommands": true` in `~/.pi/agent/settings.json` or `.pi/settings.json`.

The package does not define a custom model setting. Configure reviewer model behavior with Pi's official `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` settings.

## Disable

Start Pi with:

```bash
pi --no-auto-review
```

At runtime:

```text
/auto-review off
/auto-review on
/auto-review status
/auto-review config
/auto-review config get <key>
/auto-review config set <key> <value>
/auto-review config init
```

## Runtime Control

`/auto-review status` shows whether automatic review is enabled, whether a review is idle or queued, and the completed/queued review pass count.

`/auto-review off` disables review for the current Pi session.

`/auto-review on` enables review for the current Pi session unless Pi was started with `--no-auto-review` and you want to keep it disabled.

## Configuration

`pi-auto-review` supports global and project-level config files.

Global config path:

```text
~/.pi/agent/extensions/auto-review/config.json
```

Project config path:

```text
.pi/extensions/auto-review/config.json
```

Project config overrides global config. You can create and edit the project config through Pi commands:

```text
/auto-review config init
/auto-review config
/auto-review config set autoFix false
/auto-review config set autoFixSuggestions false
/auto-review config set maxReviewPasses 2
/auto-review config set maxReviewPasses unlimited
```

Example config file:

```json
{
  "reviewerAgent": "reviewer",
  "reviewerSkills": ["frontend-review", "effect-ts-reviewer"],
  "reviewerTaskExtra": "",
  "reviewConcurrency": 4,
  "includeBaselineReview": true,
  "fixerAgent": "worker",
  "fixerSkills": [],
  "fixerTaskExtra": "",
  "autoFix": true,
  "autoFixSuggestions": false,
  "blockInputDuringReview": true,
  "reviewStartWatchdogMs": 30000,
  "maxReviewPasses": null
}
```

- `enabled` — enable or disable automatic review (default: `true`).
- `reviewerAgent` — the subagent name used for review (default: `reviewer`).
- `reviewerSkills` — extra review skills; each skill becomes its own flat parallel reviewer task (default: `[]`).
- `reviewerTaskExtra` — extra instructions appended to every reviewer task (default: `""`).
- `reviewConcurrency` — max concurrent flat reviewer tasks (default: `4`, capped at `8`).
- `includeBaselineReview` — include the default baseline reviewer set: correctness/regressions, tests/validation, and simplicity/maintainability (default: `true`).
- `fixerAgent` — the single writer subagent used for accepted auto-fixes (default: `worker`).
- `fixerSkills` — extra skills injected into the fixer subagent (default: `[]`).
- `fixerTaskExtra` — extra instructions appended to the fixer task (default: `""`).
- `autoFix` — allow the configured fixer subagent to apply Critical/Warning fixes after reviewers return (default: `true`).
- `autoFixSuggestions` — allow automatic fixing of Suggestions when safe and local (default: `false`). By default, Suggestions are report-only.
- `blockInputDuringReview` — block new user messages while a review turn is queued but not yet dispatched (default: `true`).
- `reviewStartWatchdogMs` — timeout in ms before a stuck queued review is dropped (default: `30000`).
- `maxReviewPasses` — optional review/fix pass limit for one review loop. Use `null`/`none`/`unlimited` for no limit (default: `null`).

Priority: `--no-auto-review` flag > runtime `/auto-review on/off` > project config > global config > defaults.

## Customizing Reviews

Define review expectations with normal Pi mechanisms: `AGENTS.md`, project skills, global skills, package skills, and `pi-subagents` reviewer/fixer configuration. The bundled `auto-review` skill prompts the main agent to use the conversation, recent tool results, known edits/fixes, and optional read-only checks as context before deciding whether to call subagents. If there is no meaningful review target, the skill should stop without dispatching reviewers.

For skill-specific fanout, configure `reviewerSkills`:

```text
/auto-review config set reviewerSkills frontend-review effect-ts-reviewer
```

This runs a flat parallel review pass with the three default baseline reviewers plus one reviewer per skill. Auto-fixes are delegated to `fixerAgent` as a single writer.

## Safety

The queued `/skill:auto-review` turn instructs reviewer subagents to keep inspection read-only and instructs the main agent not to edit directly. The extension itself does not enforce per-tool mutation blocking inside child reviewer sessions; workflow discipline is handled by the skill instructions and `pi-subagents`. After reviewers return, the main agent may dispatch the configured single fixer subagent for accepted Critical/Warning findings.
