import { describe, expect, it } from 'vitest';
import {
  buildAutoFixTask,
  buildChildPiArgs,
  buildReviewFingerprint,
  buildReviewTask,
  ensureSkillsUsedSection,
  extractFinalAssistantText,
  hasBlockingReviewFindings,
  isFileMutationToolResult,
  parseChangedFiles,
  shouldRunReview,
} from './helpers.ts';

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

describe('parseChangedFiles', () => {
  it('extracts file paths from porcelain status output', () => {
    const status = [' M src/index.ts', 'A  README.md', '?? docs/new.md', 'R  old.ts -> new.ts'].join('\n');
    expect(parseChangedFiles(status)).toEqual(['src/index.ts', 'README.md', 'docs/new.md', 'new.ts']);
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
        reviewInProgress: false,
        sawMutationTool: true,
        beforeStatus: '',
        afterStatus: '',
        beforeHead: 'abc',
        afterHead: 'def',
      }),
    ).toBe(true);
  });

  it('runs when git status changed even without edit/write tool detection', () => {
    expect(
      shouldRunReview({
        enabled: true,
        reviewInProgress: false,
        sawMutationTool: false,
        beforeStatus: '',
        afterStatus: ' M src/index.ts',
      }),
    ).toBe(true);
  });

  it('does not run when disabled, already running, or unchanged', () => {
    expect(
      shouldRunReview({
        enabled: false,
        reviewInProgress: false,
        sawMutationTool: true,
        beforeStatus: '',
        afterStatus: ' M a.ts',
      }),
    ).toBe(false);
    expect(
      shouldRunReview({
        enabled: true,
        reviewInProgress: true,
        sawMutationTool: true,
        beforeStatus: '',
        afterStatus: ' M a.ts',
      }),
    ).toBe(false);
    expect(
      shouldRunReview({
        enabled: true,
        reviewInProgress: false,
        sawMutationTool: false,
        beforeStatus: '',
        afterStatus: '',
      }),
    ).toBe(false);
  });
});

describe('buildReviewFingerprint', () => {
  it('is stable for the same status and diffs and changes when the diff changes', () => {
    const first = buildReviewFingerprint({ status: ' M a.ts', diff: 'diff-a', cachedDiff: '' });
    const second = buildReviewFingerprint({ status: ' M a.ts', diff: 'diff-a', cachedDiff: '' });
    const changed = buildReviewFingerprint({ status: ' M a.ts', diff: 'diff-b', cachedDiff: '' });

    expect(first).toBe(second);
    expect(first).not.toBe(changed);
  });
});

describe('hasBlockingReviewFindings', () => {
  it('detects only Critical and Warnings as auto-fix blocking findings', () => {
    expect(hasBlockingReviewFindings('## Critical\n- Fix this')).toBe(true);
    expect(hasBlockingReviewFindings('## Warnings\n- Fix this')).toBe(true);
    expect(hasBlockingReviewFindings('## Suggestions\n- Optional nit')).toBe(false);
  });

  it('ignores common clean-review wording in Critical and Warnings sections', () => {
    expect(hasBlockingReviewFindings('## Critical\nNone.\n\n## Warnings\n- None')).toBe(false);
    expect(hasBlockingReviewFindings('## Warnings\nNo warnings found in this diff.')).toBe(false);
    expect(hasBlockingReviewFindings('## Critical\nNo critical findings.\n\n## Warnings\nNo actionable findings found.')).toBe(false);
    expect(hasBlockingReviewFindings('## Warnings\nNone — only suggestions.')).toBe(false);
    expect(hasBlockingReviewFindings('## Critical\nNothing to report.\n\n## Warnings\nNo concerns.')).toBe(false);
    expect(hasBlockingReviewFindings('## Warnings\nNot applicable.')).toBe(false);
  });
});

describe('ensureSkillsUsedSection', () => {
  it('preserves reviews that already include a skills section', () => {
    const text = '## Skills Used\n- effect-typescript\n\n## Summary';
    expect(ensureSkillsUsedSection(text)).toBe(text);
  });

  it('prepends a fallback skills section when missing', () => {
    expect(ensureSkillsUsedSection('## Summary\nNo issues')).toContain('## Skills Used\n- Not reported by reviewer.');
  });
});

describe('buildAutoFixTask', () => {
  it('builds a main-agent follow-up task with reviewer output', () => {
    const task = buildAutoFixTask({ reviewText: '## Critical\n- Fix `src/index.ts:1`', changedFiles: ['src/index.ts'], fingerprint: 'abc123' });

    expect(task).toContain('Critical or Warning findings');
    expect(task).toContain('Fix them now');
    expect(task).toContain('src/index.ts');
    expect(task).toContain('abc123');
    expect(task).toContain('## Critical');
    expect(task).toContain('auto-review extension will re-check');
  });

  it('uses a longer markdown fence when reviewer output contains code fences', () => {
    const task = buildAutoFixTask({
      reviewText: '## Warnings\n```ts\nconst value = true;\n```',
      changedFiles: ['src/index.ts'],
      fingerprint: 'abc123',
    });

    expect(task).toContain('````markdown');
    expect(task.trimEnd().endsWith('````')).toBe(true);
  });
});

describe('buildReviewTask', () => {
  it('includes changed files and asks for skill-aware read-only review', () => {
    const task = buildReviewTask({ changedFiles: ['src/index.ts'], status: ' M src/index.ts' });
    expect(task).toContain('src/index.ts');
    expect(task).toContain('git diff');
    expect(task).toContain('relevant skills');
    expect(task).toContain('## Skills Used');
    expect(task).toContain('Make skill usage visible');
    expect(task).toContain('read-only');
  });
});

describe('buildChildPiArgs', () => {
  it('uses json print no-session mode and does not override model or thinking', () => {
    const args = buildChildPiArgs('/tmp/meta.md', 'Review now');
    expect(args).toEqual([
      '--mode',
      'json',
      '-p',
      '--no-session',
      '--tools',
      'read,grep,find,ls,bash',
      '--append-system-prompt',
      '/tmp/meta.md',
      'Review now',
    ]);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--thinking');
  });
});

describe('extractFinalAssistantText', () => {
  it('extracts the final assistant text from json mode output', () => {
    const output = [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } }),
    ].join('\n');
    expect(extractFinalAssistantText(output)).toBe('final');
  });

  it('returns fallback text when no assistant output exists', () => {
    expect(extractFinalAssistantText('not json')).toBe('(review completed with no assistant output)');
  });
});
