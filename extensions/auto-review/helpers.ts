import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ReviewDecisionInput {
  enabled: boolean;
  reviewQueued: boolean;
  reviewInProgress: boolean;
  sawMutationTool: boolean;
  beforeStatus: string;
  afterStatus: string;
  beforeHead?: string;
  afterHead?: string;
}

export interface ReviewPromptInput {
  changedFiles: string[];
  status: string;
  beforeHead?: string;
  afterHead?: string;
  reviewerAgent: string;
  reviewerSkills: string[];
  reviewerTaskExtra?: string;
  autoFix: boolean;
  autoFixSuggestions: boolean;
  reviewPass?: number;
  maxReviewPasses?: number | null;
}

export const AUTO_REVIEW_SKILL_COMMAND = '/skill:auto-review';

const READ_ONLY_REVIEW_COMMANDS = new Set(['pwd', 'ls', 'grep', 'rg', 'cat', 'head', 'tail', 'wc']);

function readEnableSkillCommandsSetting(filePath: string): boolean | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const value = (parsed as { enableSkillCommands?: unknown }).enableSkillCommands;
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function areSkillCommandsEnabled(cwd: string, homeDir = os.homedir()): boolean {
  let enabled = true;
  const globalSetting = readEnableSkillCommandsSetting(path.join(homeDir, '.pi', 'agent', 'settings.json'));
  if (typeof globalSetting === 'boolean') enabled = globalSetting;
  const projectSetting = readEnableSkillCommandsSetting(path.join(cwd, '.pi', 'settings.json'));
  if (typeof projectSetting === 'boolean') enabled = projectSetting;
  return enabled;
}

export function isFileMutationToolResult(toolName: string, isError: boolean | undefined): boolean {
  if (isError) return false;
  return toolName === 'edit' || toolName === 'write';
}

function isReviewerTask(value: unknown, reviewerAgent = 'reviewer'): boolean {
  if (!value || typeof value !== 'object') return false;
  const task = value as { agent?: unknown; tasks?: unknown };
  if (task.agent === reviewerAgent) return true;
  if (Array.isArray(task.tasks)) return task.tasks.length > 0 && task.tasks.every((t) => isReviewerTask(t, reviewerAgent));
  return false;
}

export function isReviewerSubagentInput(input: Record<string, unknown> | undefined, reviewerAgent = 'reviewer'): boolean {
  if (!input) return false;
  if (input.agent === reviewerAgent) return true;
  if (Array.isArray(input.tasks)) return input.tasks.length > 0 && input.tasks.every((t) => isReviewerTask(t, reviewerAgent));
  return false;
}

export function isLikelyMutatingBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (hasShellMetaOutsideQuotes(trimmed, (char, quote) => quote === undefined && /[><;&|]/.test(char))) return true;

  const [binary = ''] = trimmed.split(/\s+/, 1);
  if (['rm', 'mv', 'cp', 'touch', 'mkdir', 'rmdir', 'ln', 'chmod', 'chown', 'tee'].includes(binary)) return true;
  if (binary === 'sed' && /(?:^|\s)(?:--in-place(?:=\S*)?|-i(?:\S*|\s|$))/.test(trimmed)) return true;
  if (binary === 'find' && /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls|chmod|chown)\b/.test(trimmed)) return true;
  if (binary === 'git') {
    if (/^git\s+(?:branch|tag)\b/.test(trimmed)) return !isReadOnlyReviewBashCommand(trimmed);
    return /^git\s+(?:add|am|apply|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|rm|stash|switch)\b/.test(trimmed);
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(binary)) {
    const subcommand = trimmed.slice(binary.length).trim().split(/\s+/, 1)[0] ?? '';
    return ['add', 'install', 'i', 'remove', 'rm', 'update', 'upgrade', 'dedupe', 'prune'].includes(subcommand);
  }
  return false;
}

function hasShellMetaOutsideQuotes(command: string, isUnsafe: (char: string, quote: 'single' | 'double' | undefined) => boolean): boolean {
  let quote: 'single' | 'double' | undefined;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      continue;
    }
    if (isUnsafe(char, quote)) return true;
  }

  return quote !== undefined;
}

function hasUnsafeShellMetaOutsideQuotes(command: string): boolean {
  return hasShellMetaOutsideQuotes(command, (char, quote) => {
    if (char === '`') return true;
    if (char === '$' && quote !== 'single') return true;
    if (quote !== undefined) return false;
    return /[;&|><\n\r]/.test(char);
  });
}

function isReadOnlyGitBranch(rest: string): boolean {
  if (rest === '') return true;
  if (/(?:^|\s)(?:-(?:d|D|m|M|c|C)|--(?:delete|move|copy|force))\b/.test(rest)) return false;

  const tokens = rest.split(/\s+/).filter(Boolean);
  let allowsPatternArgs = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (/^-[rav]+$/.test(token)) {
      allowsPatternArgs = true;
      continue;
    }
    if (['--list', '--all', '--remotes', '--verbose'].includes(token)) {
      allowsPatternArgs = true;
      continue;
    }
    if (['--show-current', '--color', '--no-color', '--column', '--no-column'].includes(token)) continue;
    if (['--contains', '--merged', '--no-merged', '--points-at', '--format', '--sort'].includes(token)) {
      const next = tokens[index + 1];
      if (next && !next.startsWith('-')) index += 1;
      continue;
    }
    if (/^--(?:contains|points-at|format|sort)=\S+$/.test(token)) continue;
    if (allowsPatternArgs && !token.startsWith('-')) continue;
    return false;
  }
  return true;
}

function isReadOnlyGitTag(rest: string): boolean {
  if (rest === '') return true;
  if (/(?:^|\s)(?:-(?:a|d|f|m|s|u)|--(?:annotate|delete|force|local-user|message|sign))\b/.test(rest)) return false;

  const tokens = rest.split(/\s+/).filter(Boolean);
  let allowsPatternArgs = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (/^-n\d*$/.test(token)) continue;
    if (token === '-l' || token === '--list') {
      allowsPatternArgs = true;
      continue;
    }
    if (token === '-v' || token === '--verify') {
      const next = tokens[index + 1];
      if (!next || next.startsWith('-')) return false;
      index += 1;
      continue;
    }
    if (['--column', '--no-column'].includes(token)) continue;
    if (['--contains', '--merged', '--no-merged', '--points-at', '--format', '--sort'].includes(token)) {
      const next = tokens[index + 1];
      if (next && !next.startsWith('-')) index += 1;
      continue;
    }
    if (/^--(?:contains|points-at|format|sort)=\S+$/.test(token)) continue;
    if (allowsPatternArgs && !token.startsWith('-')) continue;
    return false;
  }
  return true;
}

export function isReadOnlyReviewBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Review turns should only inspect state. Block shell composition and
  // redirection so an otherwise read-only command cannot be chained into a
  // mutation such as `git diff > file` or `grep x | xargs rm`. Quoted regex
  // metacharacters like `rg 'foo|bar'` are allowed.
  if (hasUnsafeShellMetaOutsideQuotes(trimmed)) return false;

  const [binary = ''] = trimmed.split(/\s+/, 1);
  if (binary === 'git') {
    if (/\s--output(?:=|\s)/.test(trimmed)) return false;
    if (/\s--(?:ext-diff|external-diff)\b/.test(trimmed)) return false;
    if (/^git\s+branch\b/.test(trimmed)) {
      const rest = trimmed.replace(/^git\s+branch\b/, '').trim();
      return isReadOnlyGitBranch(rest);
    }
    if (/^git\s+tag\b/.test(trimmed)) {
      const rest = trimmed.replace(/^git\s+tag\b/, '').trim();
      return isReadOnlyGitTag(rest);
    }
    return /^git\s+(?:blame|diff|ls-files|log|rev-parse|show|status)\b/.test(trimmed);
  }

  if (binary === 'find') {
    if (/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls|chmod|chown)\b/.test(trimmed)) return false;
    return true;
  }

  return READ_ONLY_REVIEW_COMMANDS.has(binary);
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
  if (input.reviewQueued) return false;
  if (input.reviewInProgress) return false;

  const statusChanged = input.beforeStatus.trim() !== input.afterStatus.trim();
  const headChanged = (input.beforeHead ?? '').trim() !== (input.afterHead ?? '').trim();
  const hasCurrentChanges = input.afterStatus.trim().length > 0;

  if (input.sawMutationTool) return statusChanged || headChanged || hasCurrentChanges;
  return statusChanged || headChanged;
}

export function buildReviewPrompt(_input: ReviewPromptInput): string {
  return AUTO_REVIEW_SKILL_COMMAND;
}
