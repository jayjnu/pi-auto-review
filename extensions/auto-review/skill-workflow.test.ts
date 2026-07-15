import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('auto-review skill workflow instructions', () => {
  const skillPath = path.join(process.cwd(), 'skills', 'auto-review', 'SKILL.md');

  it('documents flat baseline reviewer fanout and single fixer workflow', () => {
    const skill = fs.readFileSync(skillPath, 'utf-8');

    expect(skill).toContain('correctness/regressions/edge cases/unintended side effects');
    expect(skill).toContain('tests/validation/build confidence and missing verification');
    expect(skill).toContain('simplicity/maintainability/API clarity/code organization');
    expect(skill).toContain('subagent({');
    expect(skill).toContain('tasks: [');
    expect(skill).toContain('context: "fresh"');
    expect(skill).toContain('agent: fixerAgent');
    expect(skill).toContain('The fixer is the only writer for this auto-review pass.');
    expect(skill).toContain('Include this field only when fixerSkills is non-empty');
    expect(skill).toContain('When `fixerSkills` is empty, omit the `skill` field entirely');
    expect(skill).toContain('[auto-review:correctness]');
    expect(skill).toContain('[auto-review:validation]');
    expect(skill).toContain('[auto-review:maintainability]');
    expect(skill).toContain('[auto-review:skill:<skill-name>]');
    expect(skill).toContain('[auto-review:profile:<profile-id>]');
    expect(skill).toContain('model: "openai-codex/gpt-5.5"');
    expect(skill).toContain('split it into sequential batches of at most 8 tasks');
    expect(skill).toContain('Expected Loaded Skills: <skill-list-or-none>');
    expect(skill).toContain('Loaded Skills: <same-skill-list-or-none>');
    expect(skill).toContain('Loaded Skills: none');
    expect(skill).toContain('Loaded Skills: frontend-review');
    expect(skill).toContain('Start your response with:');
    expect(skill).toContain('Reviewer: [auto-review:correctness]');
    expect(skill).toContain('Committed clean-worktree range: <before>..<after>');
    expect(skill).toContain('Do **not** dispatch subagents merely because `HEAD` changed');
    expect(skill).toContain("perform a cheap scoped read-only range inspection such as `git diff --name-only <before>..<after> -- :/ ':(top,exclude).worktree' ':(top,exclude).worktree/**'`");
    expect(skill).toContain('contains no new unreviewed source/config/dependency/docs changes beyond bookkeeping');
    expect(skill).toContain('If confidence is not high, proceed with normal committed-range review');
    expect(skill).toContain('이미 리뷰된 변경의 commit/release 후속 작업이라 추가 리뷰를 생략합니다');
    expect(skill).toContain('Review target: committed range <before>..<after>');
    expect(skill).toContain('git rev-parse --show-toplevel');
    expect(skill).toContain("A worktree whose absolute path is itself under a parent repository's `.worktree/<name>` directory is still in scope");
    expect(skill).toContain('exclude only nested `.worktree/**` directories inside `reviewCwd`');
    expect(skill).toContain('Set `cwd: reviewCwd` on every reviewer task item');
    expect(skill).toContain('Set `cwd: reviewCwd` on the fixer subagent call');
    expect(skill).toContain('cwd: reviewCwd');
  });

  it('documents effective config helper before orchestration', () => {
    const skill = fs.readFileSync(skillPath, 'utf-8');

    expect(skill).toContain('cd <auto-review-skill-dir> && node scripts/effective-config.mjs "$reviewCwd"');
    expect(skill).toContain('Resolve `<auto-review-skill-dir>` as the directory containing this `SKILL.md`');
    expect(skill).toContain('do not run `node scripts/effective-config.mjs "$reviewCwd"` from the project root');
    expect(skill).toContain('already-merged, already-filtered JSON config');
    expect(skill).toContain('defaults < global config');
    expect(skill).toContain('checks Git common-dir for linked worktrees');
    expect(skill).toContain('filters out `enabled: false` profiles');
    expect(skill).toContain('If the helper script cannot be executed, fall back to the same merge rules manually');
    expect(skill).toContain('The extension also strips them at the `tool_call` level');
  });
});
