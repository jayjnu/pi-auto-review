# pi-auto-review

A Pi package that automatically runs a read-only code review after a Pi agent finishes a user prompt that changed code.

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

`pi-auto-review` runs once after an agent prompt changes code. It does not run after every individual edit. If the agent commits its changes and leaves a clean worktree, auto-review reviews the committed range from the turn's starting `HEAD` to the ending `HEAD`.

The reviewer is a separate Pi subprocess. The subprocess uses normal Pi settings and discovery:

- `~/.pi/agent/settings.json`
- `.pi/settings.json`
- `AGENTS.md`
- Pi skills from global, user, project, and package locations

The package does not define a custom model setting. Configure reviewer model behavior with Pi's official `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` settings.

When the isolated reviewer reports Critical or Warning findings, auto-fix can queue a follow-up main-agent turn to apply concrete fixes. Suggestion-only reviews do not trigger auto-fix automatically.

## Disable

Start Pi with:

```bash
pi --no-auto-review
```

Disable automatic follow-up fixes while keeping review enabled:

```bash
pi --no-auto-review-fix
```

At runtime:

```text
/auto-review off
/auto-review on
/auto-review status
/auto-review fix off
/auto-review fix on
/auto-review fix status
```

## Runtime Control

`/auto-review status` shows whether automatic review and auto-fix are currently enabled.

`/auto-review off` disables review for the current Pi session.

`/auto-review on` enables review for the current Pi session unless Pi was started with `--no-auto-review` and you want to keep it disabled.

`/auto-review fix off` disables automatic follow-up fix turns for the current Pi session.

`/auto-review fix on` enables automatic follow-up fix turns for Critical and Warning findings.

## Customizing Reviews

Define review expectations with normal Pi mechanisms: `AGENTS.md`, project skills, global skills, and package skills. The spawned reviewer is prompted to inspect and follow relevant skills and loaded context.

## Safety

The reviewer subprocess receives only `read`, `grep`, `find`, `ls`, and `bash`. Its prompt instructs it to use bash for read-only commands only.
