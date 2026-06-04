# Changelog

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
