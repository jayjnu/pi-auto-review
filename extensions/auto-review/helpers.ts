import { createHash } from 'node:crypto';

export interface ReviewDecisionInput {
  enabled: boolean;
  reviewInProgress: boolean;
  sawMutationTool: boolean;
  beforeStatus: string;
  afterStatus: string;
  beforeHead?: string;
  afterHead?: string;
}

export interface ReviewTaskInput {
  changedFiles: string[];
  status: string;
  reviewTarget?: string;
  suggestedCommands?: string[];
}

export interface AutoFixTaskInput {
  reviewText: string;
  changedFiles: string[];
  fingerprint: string;
}

export interface ReviewFingerprintInput {
  status: string;
  diff: string;
  cachedDiff: string;
  committedDiff?: string;
  untrackedSnapshot?: string;
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

  const statusChanged = input.beforeStatus.trim() !== input.afterStatus.trim();
  const headChanged = (input.beforeHead ?? '').trim() !== (input.afterHead ?? '').trim();
  const hasCurrentChanges = input.afterStatus.trim().length > 0;

  if (input.sawMutationTool) return statusChanged || headChanged || hasCurrentChanges;
  return statusChanged || headChanged;
}

export function buildReviewFingerprint(input: ReviewFingerprintInput): string {
  return createHash('sha256')
    .update('pi-auto-review:v1\0')
    .update(input.status)
    .update('\0diff\0')
    .update(input.diff)
    .update('\0cached\0')
    .update(input.cachedDiff)
    .update('\0committed\0')
    .update(input.committedDiff ?? '')
    .update('\0untracked\0')
    .update(input.untrackedSnapshot ?? '')
    .digest('hex');
}

function getMarkdownSection(text: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingPattern = new RegExp(`^##\\s+${escapedHeading}\\b`, 'i');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start === -1) return '';

  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start + 1, end).join('\n').trim();
}

function isNonActionableLine(line: string): boolean {
  const normalized = line.replace(/^[-*]\s*/, '').trim();
  if (!normalized) return true;
  if (/^(none|nothing|n\/?a|not\s+applicable|없음)(?:\b|[\s.!—-]|$)/i.test(normalized)) return true;
  if (/^no\s+concerns?(?:\b|[\s.!—-]|$)/i.test(normalized)) return true;
  return /^no\b/i.test(normalized) && /\b(issues?|warnings?|suggestions?|critical|actionable|findings?|problems?|blockers?|concerns?)\b/i.test(normalized);
}

function sectionHasContent(section: string): boolean {
  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.some((line) => !isNonActionableLine(line));
}

export function hasBlockingReviewFindings(text: string): boolean {
  return ['Critical', 'Warnings'].some((heading) => sectionHasContent(getMarkdownSection(text, heading)));
}

export function ensureSkillsUsedSection(text: string): string {
  if (/^##\s+Skills Used\b/im.test(text)) return text;
  return ['## Skills Used', '- Not reported by reviewer.', '', text].join('\n');
}

function markdownFenceFor(text: string): string {
  const longestRun = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return '`'.repeat(longestRun + 1);
}

export function buildAutoFixTask(input: AutoFixTaskInput): string {
  const changedFiles = input.changedFiles.length > 0 ? input.changedFiles.map((file) => `- ${file}`).join('\n') : '- (no changed files parsed)';
  const reviewFence = markdownFenceFor(input.reviewText);

  return [
    'Auto review found Critical or Warning findings in the current diff. Fix them now.',
    '',
    'Rules:',
    '- Apply concrete code changes for Critical and Warnings findings.',
    '- Apply Suggestions only when they are safe, local, and aligned with the user request.',
    '- Do not run another review yourself; the auto-review extension will re-check after your changes.',
    '- If a finding is intentionally not fixable, explain why briefly.',
    '',
    `Review fingerprint: ${input.fingerprint}`,
    '',
    'Changed files:',
    changedFiles,
    '',
    'Reviewer output:',
    `${reviewFence}markdown`,
    input.reviewText,
    reviewFence,
  ].join('\n');
}

export function buildReviewTask(input: ReviewTaskInput): string {
  const changedFiles = input.changedFiles.length > 0 ? input.changedFiles.map((file) => `- ${file}`).join('\n') : '- (no changed files parsed)';
  const status = input.status.trim().length > 0 ? input.status.trim() : '(empty git status)';
  const reviewTarget = input.reviewTarget ?? 'Review the current git diff after the parent Pi agent changed code.';
  const suggestedCommands = input.suggestedCommands?.length
    ? input.suggestedCommands.map((command) => `- \`${command}\``).join('\n')
    : '- `git diff --no-ext-diff`\n- `git diff --cached --no-ext-diff`';

  return [
    reviewTarget,
    '',
    'Before reviewing:',
    '1. Inspect the available skills listed in your system prompt.',
    '2. If any relevant skills exist for code review, changed file types, testing, security, architecture, or project conventions, read and follow them.',
    '3. Make skill usage visible to the user in the final review. List every skill you read or followed by name when possible, plus a short reason.',
    '4. If no skill was relevant or loaded, explicitly say so.',
    '5. Follow all loaded AGENTS.md and project instructions.',
    '6. Use bash for read-only commands only, such as git diff, git status, git log, and git show.',
    '',
    'Changed files:',
    changedFiles,
    '',
    'Git status:',
    '```text',
    status,
    '```',
    '',
    'Suggested inspection commands:',
    suggestedCommands,
    '',
    'Use git diff/git show and file reads to review the changes. Report concrete findings with file paths and line numbers.',
    '',
    'Output format:',
    '## Skills Used',
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
