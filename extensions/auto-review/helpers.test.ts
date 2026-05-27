import { describe, expect, it } from 'vitest';
import {
  buildChildPiArgs,
  buildReviewTask,
  extractFinalAssistantText,
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
  it('runs when enabled and edit/write happened', () => {
    expect(
      shouldRunReview({
        enabled: true,
        reviewInProgress: false,
        sawMutationTool: true,
        beforeStatus: '',
        afterStatus: '',
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

describe('buildReviewTask', () => {
  it('includes changed files and asks for skill-aware read-only review', () => {
    const task = buildReviewTask({ changedFiles: ['src/index.ts'], status: ' M src/index.ts' });
    expect(task).toContain('src/index.ts');
    expect(task).toContain('git diff');
    expect(task).toContain('relevant skills');
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
