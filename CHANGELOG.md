# Changelog

## v0.6.3 - 2026-07-13

### Fixed
- **Config reload at every `agent_end`**: direct file edits to `config.json` (including `enabled: false`) now take effect on the next agent turn without requiring `/auto-review config set`. Previously config was loaded only at `session_start`, so file edits were invisible until restart.
- **Worktree `.pi/` gitignore support**: Project config is found via `git rev-parse --git-common-dir` (which resolves the main repo root even for linked worktrees living outside the main repo directory tree), with a filesystem walk-up fallback for non-git or error cases. This finds `.pi/` in the main repo even when `.pi/` is gitignored and absent in a worktree.
- **Extension-level disabled reviewer filtering via `tool_call` interception**: the `tool_call` handler now strips disabled `reviewerProfiles` from `subagent` `tasks` arrays in code, matching by the task label (`[auto-review:profile:<id>]` or custom `label`). This is a safety net on top of the inline `Effective config:` block — it catches manual `/skill:auto-review` turns (no inline config) and LLM hallucination. The LLM can no longer dispatch a disabled reviewer profile regardless of how the review turn was triggered.

## v0.6.2 - 2026-07-13

### Fixed
- `reviewerProfiles` entries with `enabled: false` are now filtered in code before the review prompt is dispatched, instead of relying on the main agent LLM to read config files and skip them. The extension passes the already-merged, already-filtered effective config inline in the `Auto-review context:` block (as an `Effective config:` JSON block), so disabled profiles are no longer dispatched even when the main agent fails to re-read/merge config correctly (especially in worktree contexts). The skill uses this inline block directly and no longer re-reads config files when it is present.

## v0.6.1 - 2026-07-13

### Fixed
- `/auto-review config set enabled <value>` now clears any session-only `/auto-review on|off` override so the new config value takes effect immediately. Previously, a prior runtime override would shadow the config change for the rest of the session.

### Added
- `/auto-review status` now reports which layer is deciding the enabled state: the `--no-auto-review` flag, a session `/auto-review on|off` override, the `enabled` config value, or the default.
- Internal `resolveEnabledState()` unifies the enabled-decision and source-description logic into a single source of truth so the status message can never diverge from the actual enabled boolean.
- Consistency test covering all enabled-state branches (flag, session override, config, default) via `it.each` with per-case isolation.

### Validation
- `npm test` — 122 tests passed.
- `npm run typecheck` — passed.

## v0.6.0 - 2026-07-13

### Added
- Reviewer and fixer tasks now set `cwd: reviewCwd` so subagent processes start in the selected worktree root instead of the parent repository or a sibling nested worktree.
- The auto-review skill constrains review scope to the selected worktree root (`reviewCwd`) and excludes nested `.worktree/**` directories inside it via root-relative Git pathspecs (`:(top,exclude).worktree`).
- Mandatory review-worthiness gate with explicit skip rules (no meaningful diff, trivial/lockfile/auto-generated only, already-reviewed identical scope, committed bookkeeping) before dispatching any subagent.
- Follow-up pass optimization: reviewers prioritize newly introduced changes or unresolved prior findings; identical-scope follow-ups reduce to the baseline correctness reviewer only.
- Incremental range support for follow-up reviewer tasks when an `Incremental range since last review:` is present.

### Changed
- `parseChangedFiles` now filters nested `.worktree/` paths so parallel worktree directories do not leak into the changed-files list.
- `isLikelyMutatingBashCommand` now detects git commands prefixed with `-C`, `--git-dir`, `--work-tree`, and `-c` flags (both mutating and read-only variants).
- Dirty-worktree review prompts no longer inline `changedFiles`; the skill derives changed files itself via scoped read-only git commands.
- Renumbered and clarified the auto-review skill Required Flow steps.

### Validation
- `npm test` — 114 tests passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.

## v0.5.1 - 2026-06-04

### Added
- Added reviewer output skill-audit guidance so review results show `Loaded Skills` for each reviewer.

### Changed
- Disabled the auto-review extension inside pi-subagents child processes to prevent recursive auto-review loops from child fixer sessions.

## v0.5.0 - 2026-06-04

### Added
- Added scoped config commands for global/project auto-review settings:
  - `/auto-review config --global ...`
  - `/auto-review config --project ...`
  - `/auto-review config --scope global ...`
  - `/auto-review config --scope project ...`
- Added global config init/set/get/show command flows and tests.

### Changed
- Unscoped `config` / `get` continue to show effective merged settings.
- Unscoped `set` / `init` continue to write project config by default.
- Narrowed committed clean-worktree skip behavior so commit/release follow-up ranges are skipped only after cheap read-only inspection and high confidence that no new unreviewed source/config/dependency/docs changes were introduced.
- Updated README, config notes, and auto-review skill guidance for scoped config usage.

### Validation
- `npm test` — 98 tests passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.

## v0.4.0 - 2026-06-04

### Added
- Added `reviewerProfiles` config for flat auto-review fanout.
- Added per-profile support for `id`, `agent`, `model`, `skills`, `task`, `taskExtra`, `label`, and `enabled`.
- Added global/project profile merging by `id`, allowing project config to override, extend, inherit, or disable global profiles.
- Added profile-specific model and skill routing.
- Added reviewer fanout batching guidance for cases where generated reviewer tasks exceed the subagent task limit.

### Changed
- Extracted reviewer profile normalization and merge logic into `extensions/auto-review/reviewer-profiles.ts`.
- Hardened reviewer profile validation and improved parse errors.
- Updated README, config notes, auto-review skill workflow, and tests.

### Validation
- `npm test` — 94 tests passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.
- `npm pack --dry-run` confirmed `reviewer-profiles.ts` is included.
