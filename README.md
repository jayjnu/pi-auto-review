# pi-auto-review

A Pi package that automatically runs a read-only code review after a Pi agent finishes a user prompt that changed code.

## Install

```bash
pi install git:git@jayjnu:jayjnu/pi-auto-review.git
```

For local development:

```bash
pi -e /path/to/pi-auto-review
```

## Behavior

`pi-auto-review` runs once after an agent prompt changes code. It does not run after every individual edit.

The reviewer is a separate Pi subprocess. The subprocess uses normal Pi settings and discovery:

- `~/.pi/agent/settings.json`
- `.pi/settings.json`
- `AGENTS.md`
- Pi skills from global, user, project, and package locations

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
```

## Customizing Reviews

Define review expectations with normal Pi mechanisms: `AGENTS.md`, project skills, global skills, and package skills. The spawned reviewer is prompted to inspect and follow relevant skills and loaded context.

## Safety

The reviewer subprocess receives only `read`, `grep`, `find`, `ls`, and `bash`. Its prompt instructs it to use bash for read-only commands only.
