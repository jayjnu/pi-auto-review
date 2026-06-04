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
    expect(skill).toContain('Start your response with: Reviewer: [auto-review:correctness]');
    expect(skill).toContain('Committed clean-worktree range: <before>..<after>');
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
    expect(skill).toContain('space-separated input because it writes an array');
  });
});
