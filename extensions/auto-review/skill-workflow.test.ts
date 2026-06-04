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
    expect(skill).toContain('perform a cheap read-only range inspection such as `git diff --name-only <before>..<after>`');
    expect(skill).toContain('contains no new unreviewed source/config/dependency/docs changes beyond bookkeeping');
    expect(skill).toContain('If confidence is not high, proceed with normal committed-range review');
    expect(skill).toContain('이미 리뷰된 변경의 commit/release 후속 작업이라 추가 리뷰를 생략합니다');
    expect(skill).toContain('Review target: committed range <before>..<after>');
  });

  it('documents effective config normalization before orchestration', () => {
    const skill = fs.readFileSync(skillPath, 'utf-8');

    expect(skill).toContain('Merge precedence is `defaults < global config');
    expect(skill).toContain('ignore unknown keys');
    expect(skill).toContain('ignore invalid or missing values and keep the lower-priority/default value');
    expect(skill).toContain('ignore empty `reviewerAgent`/`fixerAgent`');
    expect(skill).toContain('require booleans to be actual booleans');
    expect(skill).toContain('require `reviewConcurrency` to be a positive integer capped at `8` and defaulting to `4`');
    expect(skill).toContain('require `reviewerSkills`/`fixerSkills` to be string arrays in JSON config');
    expect(skill).toContain('require `reviewerProfiles` to be a JSON array of objects');
    expect(skill).toContain('Merge `reviewerProfiles` by `id`');
    expect(skill).toContain('Do not treat `null` or empty strings as an unset mechanism');
    expect(skill).toContain('replaces the project-level `reviewerProfiles` array');
    expect(skill).toContain('do not append to or patch the existing scoped list');
    expect(skill).toContain('space-separated input because it writes an array');
  });
});
