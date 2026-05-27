import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChildPiArgs, extractFinalAssistantText } from './helpers.ts';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecFunction = (
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal },
) => Promise<ExecResult>;

export interface RunReviewerInput {
  cwd: string;
  task: string;
  signal?: AbortSignal;
  tempDir?: string;
  exec: ExecFunction;
}

export interface RunReviewerResult {
  text: string;
  stderr: string;
  code: number;
}

const META_PROMPT = `You are an automated post-change code reviewer.

Your job is to review code changes made by a parent Pi agent.

Rules:
- Inspect the available skills listed in your system prompt.
- If a relevant skill exists for code review, changed file types, project conventions, testing, security, architecture, or the active framework, read it and follow it.
- Follow all loaded AGENTS.md and project instructions.
- Use bash for read-only commands only: git diff, git status, git log, git show, and similar inspection commands.
- Do not modify files.
- Do not run write commands.
- Report concrete findings with file paths and line numbers.
`;

export async function runReviewer(input: RunReviewerInput): Promise<RunReviewerResult> {
  const ownedTempDir = input.tempDir ? undefined : await mkdtemp(join(tmpdir(), 'pi-auto-review-'));
  const tempDir = input.tempDir ?? ownedTempDir!;

  try {
    await mkdir(tempDir, { recursive: true });
    const metaPromptPath = join(tempDir, 'meta-prompt.md');
    await writeFile(metaPromptPath, META_PROMPT, 'utf8');

    const args = buildChildPiArgs(metaPromptPath, input.task);
    const result = await input.exec('pi', args, { cwd: input.cwd, signal: input.signal });
    const extracted = extractFinalAssistantText(result.stdout);
    const text = result.code === 0 || extracted !== '(review completed with no assistant output)'
      ? extracted
      : `Reviewer failed before producing output.\n\n${result.stderr || '(no stderr)'}`;

    return { text, stderr: result.stderr, code: result.code };
  } finally {
    if (ownedTempDir) await rm(ownedTempDir, { recursive: true, force: true });
  }
}
