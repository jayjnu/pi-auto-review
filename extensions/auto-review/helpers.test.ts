import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getMergedConfig, parseConfigValue } from './config.ts';
import { AUTO_REVIEW_SKILL_COMMAND, areSkillCommandsEnabled, buildReviewPrompt, filterCurrentWorktreeStatus, isAutoReviewFixerSubagentInput, isFileMutationToolResult, isLikelyMutatingBashCommand, isReadOnlyReviewBashCommand, isReviewerSubagentInput, parseChangedFiles, shouldRunReview } from './helpers.ts';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auto-review-settings-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('areSkillCommandsEnabled', () => {
  it('defaults to enabled when no settings files exist', () => {
    const dir = createTempDir();
    expect(areSkillCommandsEnabled(path.join(dir, 'project'), dir)).toBe(true);
  });

  it('lets project settings override global settings', () => {
    const dir = createTempDir();
    const project = path.join(dir, 'project');
    fs.mkdirSync(path.join(dir, '.pi', 'agent'), { recursive: true });
    fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'settings.json'), JSON.stringify({ enableSkillCommands: false }));
    fs.writeFileSync(path.join(project, '.pi', 'settings.json'), JSON.stringify({ enableSkillCommands: true }));

    expect(areSkillCommandsEnabled(project, dir)).toBe(true);
  });

  it('returns false when effective settings disable skill commands', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'settings.json'), JSON.stringify({ enableSkillCommands: false }));

    expect(areSkillCommandsEnabled(path.join(dir, 'project'), dir)).toBe(false);
  });
});

describe('isFileMutationToolResult', () => {
  it('detects successful edit and write tool results', () => {
    expect(isFileMutationToolResult('edit', false)).toBe(true);
    expect(isFileMutationToolResult('write', false)).toBe(true);
  });

  it('ignores failed mutations and read-only tools', () => {
    expect(isFileMutationToolResult('edit', true)).toBe(false);
    expect(isFileMutationToolResult('bash', false)).toBe(false);
    expect(isFileMutationToolResult('read', false)).toBe(false);
  });
});

describe('isReviewerSubagentInput', () => {
  it('detects reviewer subagent inputs', () => {
    expect(isReviewerSubagentInput({ agent: 'reviewer', task: 'review diff' })).toBe(true);
    expect(isReviewerSubagentInput({ tasks: [{ agent: 'reviewer', task: 'a' }, { agent: 'reviewer', task: 'b' }] })).toBe(true);
  });

  it('rejects non-reviewer or mixed subagent inputs', () => {
    expect(isReviewerSubagentInput({ agent: 'worker', task: 'fix' })).toBe(false);
    expect(isReviewerSubagentInput({ tasks: [{ agent: 'reviewer', task: 'a' }, { agent: 'worker', task: 'b' }] })).toBe(false);
    expect(isReviewerSubagentInput({ tasks: [] })).toBe(false);
    expect(isReviewerSubagentInput(undefined)).toBe(false);
  });
});

describe('isLikelyMutatingBashCommand', () => {
  it('detects common bash mutation commands', () => {
    expect(isLikelyMutatingBashCommand('echo fix > src/index.ts')).toBe(true);
    expect(isLikelyMutatingBashCommand('rm -rf dist')).toBe(true);
    expect(isLikelyMutatingBashCommand('git commit -am fix')).toBe(true);
    expect(isLikelyMutatingBashCommand('git -C .worktree/feature commit -am fix')).toBe(true);
    expect(isLikelyMutatingBashCommand('git -C .worktree/feature add src/index.ts')).toBe(true);
    expect(isLikelyMutatingBashCommand('git -c user.name=bot -C .worktree/feature commit -am fix')).toBe(true);
    expect(isLikelyMutatingBashCommand('git --git-dir=.git --work-tree=. add src/index.ts')).toBe(true);
    expect(isLikelyMutatingBashCommand('echo ok && git commit -am fix')).toBe(true);
    expect(isLikelyMutatingBashCommand('git branch new-feature')).toBe(true);
    expect(isLikelyMutatingBashCommand('git tag v1.0.0')).toBe(true);
    expect(isLikelyMutatingBashCommand('npm install left-pad')).toBe(true);
    expect(isLikelyMutatingBashCommand('sed -i s/a/b/ file.ts')).toBe(true);
    expect(isLikelyMutatingBashCommand("sed -i'' s/a/b/ file.ts")).toBe(true);
    expect(isLikelyMutatingBashCommand('sed --in-place s/a/b/ file.ts')).toBe(true);
    expect(isLikelyMutatingBashCommand('find . -delete')).toBe(true);
    expect(isLikelyMutatingBashCommand('find . -chown root')).toBe(true);
  });

  it('does not flag common read-only inspection commands', () => {
    expect(isLikelyMutatingBashCommand('git diff --no-ext-diff')).toBe(false);
    expect(isLikelyMutatingBashCommand('git -C .worktree/feature diff --no-ext-diff')).toBe(false);
    expect(isLikelyMutatingBashCommand('git --git-dir .git --work-tree . status --porcelain')).toBe(false);
    expect(isLikelyMutatingBashCommand('git branch --show-current')).toBe(false);
    expect(isLikelyMutatingBashCommand('git branch -a -v')).toBe(false);
    expect(isLikelyMutatingBashCommand("git branch -a 'feature/*'")).toBe(false);
    expect(isLikelyMutatingBashCommand("git branch --list 'feature/*'")).toBe(false);
    expect(isLikelyMutatingBashCommand('git tag --list')).toBe(false);
    expect(isLikelyMutatingBashCommand('git tag -n -l')).toBe(false);
    expect(isLikelyMutatingBashCommand("git tag -l 'v1.*'")).toBe(false);
    expect(isLikelyMutatingBashCommand('git branch --merged main')).toBe(false);
    expect(isLikelyMutatingBashCommand('git branch --no-merged main')).toBe(false);
    expect(isLikelyMutatingBashCommand('git branch --all')).toBe(false);
    expect(isLikelyMutatingBashCommand('git branch --remotes')).toBe(false);
    expect(isLikelyMutatingBashCommand('git branch --verbose')).toBe(false);
    expect(isLikelyMutatingBashCommand('git tag --merged main')).toBe(false);
    expect(isLikelyMutatingBashCommand('git tag --no-merged main')).toBe(false);
    expect(isLikelyMutatingBashCommand('git tag --verify v1.0.0')).toBe(false);
    expect(isLikelyMutatingBashCommand('npm test')).toBe(false);
    expect(isLikelyMutatingBashCommand('rg TODO src')).toBe(false);
    expect(isLikelyMutatingBashCommand("rg 'foo>bar' src")).toBe(false);
    expect(isLikelyMutatingBashCommand('grep "a<b" file')).toBe(false);
  });
});

describe('isReadOnlyReviewBashCommand', () => {
  it('allows simple read-only inspection commands used during review', () => {
    expect(isReadOnlyReviewBashCommand('git diff --no-ext-diff')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git status --porcelain')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git ls-files')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git branch --show-current')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git branch -a -v')).toBe(true);
    expect(isReadOnlyReviewBashCommand("git branch -a 'feature/*'")).toBe(true);
    expect(isReadOnlyReviewBashCommand("git branch --list 'feature/*'")).toBe(true);
    expect(isReadOnlyReviewBashCommand('git tag --list')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git tag -n -l')).toBe(true);
    expect(isReadOnlyReviewBashCommand("git tag -l 'v1.*'")).toBe(true);
    expect(isReadOnlyReviewBashCommand('git tag -v v1.0.0')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git branch --merged main')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git branch --no-merged main')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git branch --all')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git branch --remotes')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git branch --verbose')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git tag --merged main')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git tag --no-merged main')).toBe(true);
    expect(isReadOnlyReviewBashCommand('git tag --verify v1.0.0')).toBe(true);
    expect(isReadOnlyReviewBashCommand('rg "TODO" extensions')).toBe(true);
    expect(isReadOnlyReviewBashCommand("rg 'foo|bar' src")).toBe(true);
    expect(isReadOnlyReviewBashCommand("grep 'a$b' file")).toBe(true);
    expect(isReadOnlyReviewBashCommand('find extensions -type f')).toBe(true);
  });

  it('blocks mutation-capable bash commands during review', () => {
    expect(isReadOnlyReviewBashCommand('git commit -am fix')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git diff --ext-diff')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git diff --external-diff')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git branch -D old-branch')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git branch --delete old-branch')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git branch --move old new')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git tag -d v1.0.0')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git tag --delete v1.0.0')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git tag --force v1.0.0')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git branch new-feature')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git tag v1.0.0')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git branch --no-color new-feature')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git tag --no-column v1.0.0')).toBe(false);
    expect(isReadOnlyReviewBashCommand('rm -rf dist')).toBe(false);
    expect(isReadOnlyReviewBashCommand('sed -n "1,20p" README.md')).toBe(false);
    expect(isReadOnlyReviewBashCommand("sed -n '1w out.txt' README.md")).toBe(false);
    expect(isReadOnlyReviewBashCommand('find . -delete')).toBe(false);
    expect(isReadOnlyReviewBashCommand('find . -chmod 777')).toBe(false);
    expect(isReadOnlyReviewBashCommand('find . -fprint files.txt')).toBe(false);
    expect(isReadOnlyReviewBashCommand('find . -fprint0 files.txt')).toBe(false);
    expect(isReadOnlyReviewBashCommand('git diff > review.patch')).toBe(false);
    expect(isReadOnlyReviewBashCommand('grep foo README.md | xargs rm')).toBe(false);
    expect(isReadOnlyReviewBashCommand('grep "a$b" file')).toBe(false);
    expect(isReadOnlyReviewBashCommand("grep 'unterminated file")).toBe(false);
  });
});

describe('parseChangedFiles', () => {
  it('extracts file paths from porcelain status output', () => {
    const status = [' M src/index.ts', 'A  README.md', '?? docs/new.md', 'R  old.ts -> new.ts'].join('\n');
    expect(parseChangedFiles(status)).toEqual(['src/index.ts', 'README.md', 'docs/new.md', 'new.ts']);
  });

  it('excludes nested worktree paths from changed files', () => {
    const status = [' M src/index.ts', ' M .worktree/feature/src/index.ts', '?? .worktree/other/'].join('\n');
    expect(parseChangedFiles(status)).toEqual(['src/index.ts']);
  });

  it('filters nested worktree paths from porcelain status', () => {
    const status = [' M src/index.ts', ' M .worktree/feature/src/index.ts', '?? .worktree/other/'].join('\n');
    expect(filterCurrentWorktreeStatus(status)).toBe(' M src/index.ts\n');
  });

  it('keeps rename/copy status lines when either source or target is in the current worktree', () => {
    const status = [
      'R  src/a.ts -> .worktree/feature/a.ts',
      'R  .worktree/feature/b.ts -> src/b.ts',
      'R  .worktree/feature/c.ts -> .worktree/other/c.ts',
      'C  src/d.ts -> src/e.ts',
    ].join('\n');

    expect(filterCurrentWorktreeStatus(status)).toBe([
      'R  src/a.ts -> .worktree/feature/a.ts',
      'R  .worktree/feature/b.ts -> src/b.ts',
      'C  src/d.ts -> src/e.ts',
    ].join('\n') + '\n');
    expect(parseChangedFiles(status)).toEqual(['src/a.ts', 'src/b.ts', 'src/e.ts']);
  });

  it('ignores short malformed status lines', () => {
    const status = ['M', '?? docs/new.md', ' A'].join('\n');

    expect(filterCurrentWorktreeStatus(status)).toBe('?? docs/new.md\n');
    expect(parseChangedFiles(status)).toEqual(['docs/new.md']);
  });

  it('returns an empty array for empty status', () => {
    expect(parseChangedFiles('')).toEqual([]);
  });
});

describe('shouldRunReview', () => {
  it('runs when enabled and edit/write produced current changes', () => {
    expect(
      shouldRunReview({
        enabled: true,
        reviewQueued: false,
        reviewInProgress: false,
        sawMutationTool: true,
        beforeStatus: '',
        afterStatus: ' M src/index.ts',
      }),
    ).toBe(true);
  });

  it('runs when an edit/write was committed and the worktree is clean', () => {
    expect(
      shouldRunReview({
        enabled: true,
        reviewQueued: false,
        reviewInProgress: false,
        sawMutationTool: true,
        beforeStatus: '',
        afterStatus: '',
        beforeHead: 'abc',
        afterHead: 'def',
      }),
    ).toBe(true);
  });

  it('does not run when disabled, already queued, reviewing, or unchanged', () => {
    const base = {
      enabled: true,
      reviewQueued: false,
      reviewInProgress: false,
      sawMutationTool: true,
      beforeStatus: '',
      afterStatus: ' M a.ts',
    };

    expect(shouldRunReview({ ...base, enabled: false })).toBe(false);
    expect(shouldRunReview({ ...base, reviewQueued: true })).toBe(false);
    expect(shouldRunReview({ ...base, reviewInProgress: true })).toBe(false);
    expect(shouldRunReview({ ...base, sawMutationTool: false, afterStatus: '' })).toBe(false);
  });
});

describe('buildReviewPrompt', () => {
  it('builds a minimal skill invocation prompt by default', () => {
    const prompt = buildReviewPrompt();

    expect(prompt).toBe(AUTO_REVIEW_SKILL_COMMAND);
    expect(prompt).not.toContain('src/index.ts');
    expect(prompt).not.toContain('git diff --no-ext-diff');
    expect(prompt).not.toContain('Reviewer agent:');
    expect(prompt).not.toContain('Review pass:');
  });

  it('keeps dirty-worktree review prompts compact even when changed files are known', () => {
    const prompt = buildReviewPrompt({
      status: ' M src/index.ts',
      beforeHead: 'abc',
      afterHead: 'def',
    });

    expect(prompt).toBe(AUTO_REVIEW_SKILL_COMMAND);
    expect(prompt).not.toContain('Changed files:');
  });

  it('includes compact committed range context for clean-worktree committed changes', () => {
    const prompt = buildReviewPrompt({
      status: '',
      beforeHead: 'abc',
      afterHead: 'def',
    });

    expect(prompt).toContain(AUTO_REVIEW_SKILL_COMMAND);
    expect(prompt).toContain('Auto-review context:');
    expect(prompt).toContain('Committed clean-worktree range: abc..def');
    expect(prompt).not.toContain('Changed files:');
    expect(prompt).not.toContain('diff --git');
  });

});

describe('getMergedConfig', () => {
  it('applies defaults when no config files exist', () => {
    const dir = createTempDir();
    const config = getMergedConfig(dir, dir);
    expect(config.enabled).toBe(true);
    expect(config.reviewerAgent).toBe('reviewer');
    expect(config.reviewerSkills).toEqual([]);
    expect(config.reviewerTaskExtra).toBe('');
    expect(config.reviewerProfiles).toEqual([]);
    expect(config.reviewConcurrency).toBe(4);
    expect(config.includeBaselineReview).toBe(true);
    expect(config.fixerAgent).toBe('worker');
    expect(config.fixerSkills).toEqual([]);
    expect(config.fixerTaskExtra).toBe('');
    expect(config.autoFix).toBe(true);
    expect(config.autoFixSuggestions).toBe(false);
    expect(config.blockInputDuringReview).toBe(true);
    expect(config.reviewStartWatchdogMs).toBe(30_000);
    expect(config.maxReviewPasses).toBeNull();
  });

  it('lets project config override global config', () => {
    const dir = createTempDir();
    const project = path.join(dir, 'project');
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.mkdirSync(path.join(project, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ autoFix: false, reviewerAgent: 'global-reviewer' }));
    fs.writeFileSync(path.join(project, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ autoFix: true, reviewerAgent: 'project-reviewer' }));

    const config = getMergedConfig(project, dir);
    expect(config.autoFix).toBe(true);
    expect(config.reviewerAgent).toBe('project-reviewer');
  });

  it('merges reviewerProfiles by id so project config can override global reviewers', () => {
    const dir = createTempDir();
    const project = path.join(dir, 'project');
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.mkdirSync(path.join(project, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({
      reviewerProfiles: [
        { id: 'frontend-perf', agent: 'reviewer', model: 'global/model', skills: ['frontend-review'], task: 'Check rendering performance.' },
        { id: 'security', agent: 'security-reviewer', task: 'Check security issues.' },
      ],
    }));
    fs.writeFileSync(path.join(project, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({
      reviewerProfiles: [
        { id: 'frontend-perf', model: 'project/model', taskExtra: 'Use project design-system constraints.' },
        { id: 'security', enabled: false },
        { id: 'effect', skills: ['effect-ts-reviewer'], task: 'Check Effect.ts usage.' },
      ],
    }));

    const config = getMergedConfig(project, dir);
    expect(config.reviewerProfiles).toEqual([
      { id: 'frontend-perf', agent: 'reviewer', model: 'project/model', skills: ['frontend-review'], task: 'Check rendering performance.', taskExtra: 'Use project design-system constraints.' },
      { id: 'security', agent: 'security-reviewer', task: 'Check security issues.', enabled: false },
      { id: 'effect', skills: ['effect-ts-reviewer'], task: 'Check Effect.ts usage.' },
    ]);
  });

  it('rejects empty project reviewerProfiles taskExtra so lower-priority global profiles remain effective', () => {
    const dir = createTempDir();
    const project = path.join(dir, 'project');
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.mkdirSync(path.join(project, '.pi', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({
      reviewerProfiles: [
        { id: 'empty-extra', task: 'Check empty extra inheritance.', taskExtra: 'Global empty extra.' },
        { id: 'whitespace-extra', task: 'Check whitespace extra inheritance.', taskExtra: 'Global whitespace extra.' },
      ],
    }));
    fs.writeFileSync(path.join(project, '.pi', 'extensions', 'auto-review', 'config.json'), JSON.stringify({
      reviewerProfiles: [
        { id: 'empty-extra', taskExtra: '' },
        { id: 'whitespace-extra', taskExtra: '   ' },
      ],
    }));

    const config = getMergedConfig(project, dir);
    expect(config.reviewerProfiles).toEqual([
      { id: 'empty-extra', task: 'Check empty extra inheritance.', taskExtra: 'Global empty extra.' },
      { id: 'whitespace-extra', task: 'Check whitespace extra inheritance.', taskExtra: 'Global whitespace extra.' },
    ]);
  });

  it('ignores invalid JSON with fallback to defaults', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), 'not json');

    const config = getMergedConfig(dir, dir);
    expect(config.enabled).toBe(true);
  });

  it('ignores unknown keys', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ unknownKey: 'value', enabled: false }));

    const config = getMergedConfig(dir, dir);
    expect(config.enabled).toBe(false);
    expect((config as unknown as Record<string, unknown>).unknownKey).toBeUndefined();
  });

  it('trims valid reviewerSkills/fixerSkills from config files', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewerSkills: [' effect-ts-re ', 'reviewer'], fixerSkills: [' fixer-skill '] }));

    const config = getMergedConfig(dir, dir);
    expect(config.reviewerSkills).toEqual(['effect-ts-re', 'reviewer']);
    expect(config.fixerSkills).toEqual(['fixer-skill']);
  });

  it('trims and keeps valid reviewerProfiles from config files', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({
      reviewerProfiles: [{
        id: ' frontend ',
        agent: ' reviewer ',
        model: ' openai/gpt ',
        skills: [' frontend-review '],
        task: ' Review frontend changes. ',
        taskExtra: ' Use project frontend constraints. ',
        label: ' Frontend ',
        enabled: true,
      }],
    }));

    const config = getMergedConfig(dir, dir);
    expect(config.reviewerProfiles).toEqual([{ id: 'frontend', agent: 'reviewer', model: 'openai/gpt', skills: ['frontend-review'], task: 'Review frontend changes.', taskExtra: 'Use project frontend constraints.', label: 'Frontend', enabled: true }]);
  });

  it('ignores invalid reviewerProfiles arrays', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewerProfiles: [{ id: 'valid', skills: ['ok'] }, { id: '', task: 'bad' }] }));

    const config = getMergedConfig(dir, dir);
    expect(config.reviewerProfiles).toEqual([]);
  });

  it('rejects reviewerProfiles arrays with invalid optional string fields or enabled values', () => {
    const invalidProfiles = [
      { id: 'numeric-agent', agent: 123 },
      { id: 'empty-agent', agent: '' },
      { id: 'numeric-model', model: 123 },
      { id: 'empty-model', model: '   ' },
      { id: 'numeric-label', label: 123 },
      { id: 'empty-label', label: '' },
      { id: 'numeric-task', task: 123 },
      { id: 'empty-task', task: '   ' },
      { id: 'numeric-task-extra', taskExtra: 123 },
      { id: 'empty-task-extra', taskExtra: '' },
      { id: 'string-enabled', enabled: 'true' },
      { id: 'numeric-enabled', enabled: 1 },
    ];

    for (const invalidProfile of invalidProfiles) {
      const dir = createTempDir();
      fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewerProfiles: [{ id: 'valid', task: 'Check valid profile.' }, invalidProfile] }));

      const config = getMergedConfig(dir, dir);
      expect(config.reviewerProfiles, `invalid profile should reject array: ${JSON.stringify(invalidProfile)}`).toEqual([]);
    }
  });

  it('filters non-array reviewerSkills/fixerSkills, non-string items, and empty strings', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewerSkills: ['valid', 123, null], fixerSkills: ['valid', '', '   '] }));

    const config = getMergedConfig(dir, dir);
    expect(config.reviewerSkills).toEqual([]);
    expect(config.fixerSkills).toEqual([]);
  });

  it('ignores non-finite reviewStartWatchdogMs', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewStartWatchdogMs: NaN }));

    const config = getMergedConfig(dir, dir);
    expect(config.reviewStartWatchdogMs).toBe(30_000);
  });

  it('clamps config-file reviewConcurrency to the safe maximum', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewConcurrency: 99 }));

    const config = getMergedConfig(dir, dir);
    expect(config.reviewConcurrency).toBe(8);
  });

  it('ignores empty-string reviewerAgent/fixerAgent and falls back to defaults', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewerAgent: '', fixerAgent: '' }));

    const config = getMergedConfig(dir, dir);
    expect(config.reviewerAgent).toBe('reviewer');
    expect(config.fixerAgent).toBe('worker');
  });

  it('ignores non-positive reviewStartWatchdogMs and falls back to default', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pi', 'agent', 'extensions', 'auto-review', 'config.json'), JSON.stringify({ reviewStartWatchdogMs: 0 }));

    const config = getMergedConfig(dir, dir);
    expect(config.reviewStartWatchdogMs).toBe(30_000);
  });
});

describe('isAutoReviewFixerSubagentInput', () => {
  it('detects single, parallel, and chain fixer subagent inputs', () => {
    expect(isAutoReviewFixerSubagentInput({ agent: 'worker', task: 'fix' })).toBe(true);
    expect(isAutoReviewFixerSubagentInput({ tasks: [{ agent: 'reviewer', task: 'review' }, { agent: 'worker', task: 'fix' }] })).toBe(true);
    expect(isAutoReviewFixerSubagentInput({ chain: [{ agent: 'reviewer', task: 'review' }, { agent: 'worker', task: 'fix' }] })).toBe(true);
    expect(isAutoReviewFixerSubagentInput({ chain: [{ parallel: [{ agent: 'worker', task: 'fix' }] }] })).toBe(true);
  });

  it('rejects reviewer-only and non-target fixer inputs', () => {
    expect(isAutoReviewFixerSubagentInput({ agent: 'reviewer', task: 'review' })).toBe(false);
    expect(isAutoReviewFixerSubagentInput({ tasks: [{ agent: 'reviewer', task: 'a' }] })).toBe(false);
    expect(isAutoReviewFixerSubagentInput({ agent: 'custom-fixer', task: 'fix' }, 'worker')).toBe(false);
    expect(isAutoReviewFixerSubagentInput({ agent: 'custom-fixer', task: 'fix' }, 'custom-fixer')).toBe(true);
    expect(isAutoReviewFixerSubagentInput(undefined)).toBe(false);
  });
});

describe('parseConfigValue reviewerProfiles', () => {
  it('parses JSON reviewer profile arrays', () => {
    expect(parseConfigValue('reviewerProfiles', '[{"id":"frontend-perf","agent":"reviewer","model":"openai/gpt","skills":["frontend-review"],"task":"Check perf"}]')).toEqual([
      { id: 'frontend-perf', agent: 'reviewer', model: 'openai/gpt', skills: ['frontend-review'], task: 'Check perf' },
    ]);
  });

  it('rejects non-array or invalid reviewerProfiles values', () => {
    expect(() => parseConfigValue('reviewerProfiles', '{"id":"frontend"}')).toThrow('Expected JSON array of reviewer profile objects');
    expect(() => parseConfigValue('reviewerProfiles', '[{"id":"frontend","skills":[""]}]')).toThrow('Expected JSON array of reviewer profile objects');
  });

  it('rejects invalid optional reviewerProfiles fields from command input', () => {
    const invalidProfiles = [
      { id: 'numeric-model', model: 123 },
      { id: 'empty-model', model: '' },
      { id: 'numeric-label', label: 123 },
      { id: 'empty-label', label: '   ' },
      { id: 'numeric-task', task: 123 },
      { id: 'empty-task', task: '' },
      { id: 'numeric-task-extra', taskExtra: 123 },
      { id: 'empty-task-extra', taskExtra: '   ' },
      { id: 'string-enabled', enabled: 'true' },
    ];

    for (const invalidProfile of invalidProfiles) {
      expect(
        () => parseConfigValue('reviewerProfiles', JSON.stringify([invalidProfile])),
        `invalid profile should be rejected: ${JSON.stringify(invalidProfile)}`,
      ).toThrow('optional agent/model/label/task/taskExtra must be non-empty strings');
    }
  });
});

describe('parseConfigValue skill arrays', () => {
  it('trims JSON array skill values', () => {
    expect(parseConfigValue('reviewerSkills', '[" effect-ts-re ", "reviewer"]')).toEqual(['effect-ts-re', 'reviewer']);
    expect(parseConfigValue('fixerSkills', '[" fixer-skill "]')).toEqual(['fixer-skill']);
  });

  it('rejects empty or whitespace-only JSON array skill values', () => {
    expect(() => parseConfigValue('reviewerSkills', '["valid", ""]')).toThrow('non-empty strings');
    expect(() => parseConfigValue('fixerSkills', '["valid", "   "]')).toThrow('non-empty strings');
  });

  it('rejects malformed JSON-looking skill array values instead of treating them as shorthand', () => {
    expect(() => parseConfigValue('reviewerSkills', '["skill",]')).toThrow('Expected JSON array or space-separated list for reviewerSkills');
    expect(() => parseConfigValue('fixerSkills', '{"skill":true')).toThrow('Expected JSON array or space-separated list for fixerSkills');
  });

  it('rejects non-array JSON skill values instead of treating them as shorthand', () => {
    expect(() => parseConfigValue('reviewerSkills', '{"skill":"effect-ts-re"}')).toThrow('Expected JSON array or space-separated list for reviewerSkills');
    expect(() => parseConfigValue('fixerSkills', '"fixer-skill"')).toThrow('Expected JSON array or space-separated list for fixerSkills');
  });

  it('preserves space-separated shorthand filtering', () => {
    expect(parseConfigValue('reviewerSkills', '  effect-ts-re   reviewer  ')).toEqual(['effect-ts-re', 'reviewer']);
    expect(parseConfigValue('fixerSkills', '  fixer-skill  ')).toEqual(['fixer-skill']);
  });
});

describe('isReviewerSubagentInput with custom agent', () => {
  it('detects custom reviewer agent', () => {
    expect(isReviewerSubagentInput({ agent: 'custom-reviewer', task: 'review' }, 'custom-reviewer')).toBe(true);
    expect(isReviewerSubagentInput({ agent: 'reviewer', task: 'review' }, 'custom-reviewer')).toBe(false);
  });

  it('defaults to reviewer when no agent arg given', () => {
    expect(isReviewerSubagentInput({ agent: 'reviewer', task: 'review' })).toBe(true);
    expect(isReviewerSubagentInput({ agent: 'custom-reviewer', task: 'review' })).toBe(false);
  });
});
