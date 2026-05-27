export interface ReviewDecisionInput {
  enabled: boolean;
  reviewInProgress: boolean;
  sawMutationTool: boolean;
  beforeStatus: string;
  afterStatus: string;
}

export interface ReviewTaskInput {
  changedFiles: string[];
  status: string;
}

export function isFileMutationToolResult(toolName: string, isError: boolean | undefined): boolean {
  if (isError) return false;
  return toolName === 'edit' || toolName === 'write';
}

export function parseChangedFiles(status: string): string[] {
  return status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const pathPart = line.slice(3).trim();
      const renameTarget = pathPart.split(' -> ').at(-1);
      return renameTarget ?? pathPart;
    })
    .filter((file) => file.length > 0);
}

export function shouldRunReview(input: ReviewDecisionInput): boolean {
  if (!input.enabled) return false;
  if (input.reviewInProgress) return false;
  if (input.sawMutationTool) return true;
  return input.beforeStatus.trim() !== input.afterStatus.trim();
}

export function buildReviewTask(input: ReviewTaskInput): string {
  const changedFiles = input.changedFiles.length > 0 ? input.changedFiles.map((file) => `- ${file}`).join('\n') : '- (no changed files parsed)';
  const status = input.status.trim().length > 0 ? input.status.trim() : '(empty git status)';

  return [
    'Review the current git diff after the parent Pi agent changed code.',
    '',
    'Before reviewing:',
    '1. Inspect the available skills listed in your system prompt.',
    '2. If any relevant skills exist for code review, changed file types, testing, security, architecture, or project conventions, read and follow them.',
    '3. Follow all loaded AGENTS.md and project instructions.',
    '4. Use bash for read-only commands only, such as git diff, git status, git log, and git show.',
    '',
    'Changed files:',
    changedFiles,
    '',
    'Git status:',
    '```text',
    status,
    '```',
    '',
    'Use git diff and file reads to review the changes. Report concrete findings with file paths and line numbers.',
    '',
    'Output format:',
    '## Summary',
    '## Critical',
    '## Warnings',
    '## Suggestions',
    '## Files Reviewed',
  ].join('\n');
}

export function buildChildPiArgs(metaPromptPath: string, task: string): string[] {
  return [
    '--mode',
    'json',
    '-p',
    '--no-session',
    '--tools',
    'read,grep,find,ls,bash',
    '--append-system-prompt',
    metaPromptPath,
    task,
  ];
}

export function extractFinalAssistantText(jsonOutput: string): string {
  let finalText = '';

  for (const line of jsonOutput.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
      };
      if (event.type !== 'message_end' || event.message?.role !== 'assistant') continue;
      const text = event.message.content?.find((part) => part.type === 'text')?.text;
      if (text) finalText = text;
    } catch {
      continue;
    }
  }

  return finalText || '(review completed with no assistant output)';
}
