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

The package bundles `pi-subagents` and an `auto-review` skill. After Pi becomes idle, it queues a short `/skill:auto-review` main-agent orchestration turn. That skill tells the main agent to first call the `reviewer` subagent, then apply fixes in the main session when the reviewer reports Critical or Warning findings. That means:

- review context is isolated in a child Pi session via `pi-subagents`;
- fixes happen in the visible main chat flow;
- the extension can briefly block new user input while a review turn is queued;
- no custom background reviewer process is spawned by `pi-auto-review`.

The extension dispatches only the `/skill:auto-review` skill command and relies on the bundled skill plus `pi-subagents` for review/fix workflow discipline. If fixes change files, `pi-auto-review` queues another review turn.

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
  "reviewerSkills": ["effect-ts-reviewer"],
  "reviewerTaskExtra": "Check Effect service/layer patterns.",
  "autoFix": true,
  "autoFixSuggestions": false,
  "blockInputDuringReview": true,
  "reviewStartWatchdogMs": 30000,
  "maxReviewPasses": null
}
```

- `enabled` — enable or disable automatic review (default: `true`).
- `reviewerAgent` — the subagent name used for review (default: `reviewer`).
- `reviewerSkills` — additional skills to inject into the reviewer subagent (default: `[]`).
- `reviewerTaskExtra` — extra instructions appended to the reviewer task (default: `""`).
- `autoFix` — allow the main agent to apply Critical/Warning fixes after the reviewer returns (default: `true`).
- `autoFixSuggestions` — allow automatic fixing of Suggestions when safe and local (default: `false`). By default, Suggestions are report-only.
- `blockInputDuringReview` — block new user messages while a review turn is queued but not yet dispatched (default: `true`).
- `reviewStartWatchdogMs` — timeout in ms before a stuck queued review is dropped (default: `30000`).
- `maxReviewPasses` — optional review/fix pass limit for one review loop. Use `null`/`none`/`unlimited` for no limit (default: `null`).

Priority: `--no-auto-review` flag > runtime `/auto-review on/off` > project config > global config > defaults.

## Customizing Reviews

Define review expectations with normal Pi mechanisms: `AGENTS.md`, project skills, global skills, package skills, and `pi-subagents` reviewer configuration. The bundled `auto-review` skill prompts the main agent to call the configured reviewer subagent and then fix Critical/Warning findings.

## Safety

The queued `/skill:auto-review` turn instructs the main agent to keep inspection read-only until the reviewer subagent returns. The extension itself does not enforce per-tool mutation blocking; workflow discipline is handled by the skill instructions and `pi-subagents`. After the reviewer returns, the main agent can apply fixes for Critical/Warning findings.
